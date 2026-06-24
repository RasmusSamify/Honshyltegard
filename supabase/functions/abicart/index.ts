import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const WEBSHOP    = '84183';
// Abicart admin-auth-token läses ENBART från miljövariabel — aldrig hårdkodad
// i koden (ligger i Supabase-secrets: `supabase secrets set ABICART_TOKEN=...`).
const AUTH_TOKEN = Deno.env.get('ABICART_TOKEN') ?? '';
const AB_BASE_URL = `https://shop.textalk.se/backend/jsonrpc/v1/?webshop=${WEBSHOP}`;
const AB_ADMIN   = `${AB_BASE_URL}&auth=${AUTH_TOKEN}`;
const SB_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SB_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SHOP_BASE  = 'https://webshop.honshyltegard.nu';
const LAT        = '56.47739536235032';
const LNG        = '14.690764677283862';

const CORS   = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const JSON_H = { ...CORS, 'Content-Type': 'application/json' };

let rpcId = 1;

/**
 * Generic Abicart JSON-RPC caller.
 * - admin (default true): include &auth=ADMIN_TOKEN
 * - session: append &session=TOKEN to bind call to a user session
 *
 * For createOrder we use { admin: false, session } when fetching Session.getToken
 * (matches original client-side behavior), then { session } for Order.* calls
 * so the order is bound to the session that the user will arrive with on /kassa.
 */
async function ab(method: string, params: unknown[], opts: { session?: string; admin?: boolean } = {}) {
  const useAdmin = opts.admin !== false;
  let url = useAdmin ? AB_ADMIN : AB_BASE_URL;
  if (opts.session) url += `&session=${encodeURIComponent(opts.session)}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res  = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      signal: ctrl.signal
    });
    const text = await res.text();
    if (!text?.trim()) throw new Error(`Abicart tomt svar (${res.status})`);
    const data = JSON.parse(text);
    if (data.error) throw new Error(`Abicart: ${data.error.message} (${data.error.code})`);
    return data.result;
  } finally { clearTimeout(t); }
}

async function sbPatch(table: string, filter: string, data: object) {
  await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}
async function sbGet(path: string) {
  return (await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } })).json();
}
async function fetchWeather() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try { return await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&forecast_days=10&timezone=Europe%2FStockholm`, { signal: ctrl.signal })).json(); }
  finally { clearTimeout(t); }
}
function extractUid(r: unknown): number | null {
  if (typeof r === 'number') return r;
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if (typeof o.uid === 'number') return o.uid;
    if (typeof o.order === 'number') return o.order;
    if (o.order && typeof o.order === 'object') return extractUid(o.order);
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method === 'GET') {
    try { return new Response(JSON.stringify(await fetchWeather()), { headers: JSON_H }); }
    catch { return new Response(JSON.stringify({ error: 'Väder ej tillgängligt' }), { status: 503, headers: JSON_H }); }
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ok */ }
  const action = (body.action as string) || '';

  try {
    if (action === 'weather') {
      try { return new Response(JSON.stringify(await fetchWeather()), { headers: JSON_H }); }
      catch { return new Response(JSON.stringify({ error: 'Väder ej tillgängligt' }), { status: 503, headers: JSON_H }); }
    }
    if (action === 'ping') {
      const r = await ab('Webshop.get', [Number(WEBSHOP), ['uid', 'name', 'url']]);
      return new Response(JSON.stringify({ ok: true, webshop: r }), { headers: JSON_H });
    }
    if (action === 'listArticles') {
      const r = await ab('Article.list', [['uid', 'name', 'articleNumber', 'isBuyable', 'hidden'], { limit: 30 }]);
      return new Response(JSON.stringify({ ok: true, articles: r }), { headers: JSON_H });
    }

    // ── attachOrder ──────────────────────────────────────────────────
    // Sparar abicart_order_id på en bokning via SERVICE-ROLE. Widgeten är
    // anonym och anon-rollen får INTE göra UPDATE på bookings (RLS), så den
    // gamla direkta PATCH:en från klienten nekades tyst med 401 → order-id
    // sparades aldrig → betalningar kunde aldrig matchas mot bokningar.
    // Den här action:en ersätter den. Idempotent + säker: skriver bara om
    // bokningen fortfarande saknar order-id (abicart_order_id IS NULL), så en
    // andra order inte kan skriva över en redan kopplad bokning.
    if (action === 'attachOrder') {
      const booking_id = body.booking_id;
      const order_id   = body.order_id;
      if (!booking_id || !order_id) {
        return new Response(JSON.stringify({ error: 'booking_id och order_id krävs' }), { status: 400, headers: JSON_H });
      }
      const res = await fetch(
        `${SB_URL}/rest/v1/bookings?id=eq.${booking_id}&abicart_order_id=is.null`,
        { method: 'PATCH',
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ abicart_order_id: order_id, payment_status: 'pending' }) }
      );
      const rows = await res.json();
      const updated = Array.isArray(rows) ? rows.length : 0;
      console.log(`attachOrder: booking=${booking_id} order=${order_id} updated=${updated}`);
      return new Response(JSON.stringify({ ok: true, updated }), { headers: JSON_H });
    }

    if (action === 'createOrder') {
      const { booking_id, service_name, first_name, last_name, email, phone } = body as Record<string, unknown>;
      const adults   = parseInt(String(body.adults   ?? 0), 10);
      const children = parseInt(String(body.children ?? 0), 10);
      console.log(`createOrder: service=${service_name} adults=${adults} children=${children}`);

      const svcs = await sbGet(`services?name=eq.${encodeURIComponent(service_name as string)}&select=abicart_article_id,abicart_article_id_child`);
      const svc  = svcs[0];
      if (!svc) throw new Error('Tjänst saknas: ' + service_name);

      // ── STEG 1: Hämta en anonym session-token från Abicart ────────────
      // UTAN admin-auth — vi vill ha en "äkta" user-session som kassa-sidan
      // kan acceptera när användaren landar där med ?session=TOKEN
      const sessionToken = await ab('Session.getToken', [], { admin: false });
      if (!sessionToken || typeof sessionToken !== 'string') {
        throw new Error('Kunde inte hämta session-token från Abicart (got: ' + JSON.stringify(sessionToken) + ')');
      }
      console.log('Session token:', String(sessionToken).substring(0, 8) + '...');

      // ── STEG 2: Skapa order MED session, UTAN admin-auth ─────────────
      // KRITISKT: admin: false här. Annars överrider admin-auth sessionen
      // och ordern blir inte session-bunden → kassan kan inte hitta den.
      let orderUid: number | null = null;
      if (adults > 0 && svc.abicart_article_id) {
        const item = await ab(
          'Order.addArticle',
          [null, Number(svc.abicart_article_id), { quantity: adults }, { order: 'uid' }],
          { admin: false, session: sessionToken }
        );
        orderUid = extractUid(item);
        console.log('Order created:', orderUid, JSON.stringify(item));
      }
      if (!orderUid) throw new Error('Kunde inte skapa order');

      // ── STEG 3: Lägg till barn på samma order/session (UTAN admin) ──
      if (children > 0 && svc.abicart_article_id_child) {
        await ab(
          'Order.addArticle',
          [orderUid, Number(svc.abicart_article_id_child), { quantity: children }, ['uid']],
          { admin: false, session: sessionToken }
        );
      }

      // ── STEG 4: Pre-fyll kunduppgifter (samma session, UTAN admin) ──
      if (first_name || email) {
        try {
          await ab(
            'Order.set',
            [orderUid, {
              customer: {
                address: { firstName: first_name || '', lastName: last_name || '', phoneMobile: phone || '' },
                info:    { email: email || '' }
              }
            }, ['uid']],
            { admin: false, session: sessionToken }
          );
        } catch(e) { console.warn('Prefill:', (e as Error).message); }
      }

      await sbPatch('bookings', `id=eq.${booking_id}`, { abicart_order_id: orderUid, payment_status: 'pending' });

      // ── STEG 5: Bygg checkout-URL MED session-token ─────────────────
      // Användaren landar på kassa-sidan med ?session=TOKEN — Abicart läser
      // tokenen och kan visa rätt order. Detta är samma flöde som original-
      // koden i index.html använde, fast nu serversida.
      const checkoutUrl = `${SHOP_BASE}/kassa/${orderUid}?session=${encodeURIComponent(sessionToken)}`;
      console.log('Checkout:', checkoutUrl);
      return new Response(JSON.stringify({ ok: true, order_id: orderUid, checkout_url: checkoutUrl }), { headers: JSON_H });
    }

    if (action === 'confirmPayment') {
      const { order_id } = body as Record<string, unknown>;
      let order: unknown;
      try {
        order = await ab('Order.get', [order_id, ['uid', 'paymentStatus']]);
      } catch (e) {
        // 9003 "Object not found" = ordern är ännu inte placerad (kunden har
        // inte slutfört betalningen). En obetald order är en session-bunden
        // utkast-korg som inte syns för admin förrän den placerats. Behandla
        // som "ej betald än", inte som fel — annars spottar Helenas synk-knapp
        // 500-fel på varje obetald bokning.
        if ((e as Error).message.includes('(9003)')) {
          return new Response(JSON.stringify({ ok: true, paid: false, pending: true }), { headers: JSON_H });
        }
        throw e;
      }
      const paid = (order as Record<string, string>)?.paymentStatus === 'paid';
      if (paid) await sbPatch('bookings', `abicart_order_id=eq.${order_id}`, { payment_status: 'paid', status: 'confirmed' });
      return new Response(JSON.stringify({ ok: true, paid, order }), { headers: JSON_H });
    }

    return new Response(JSON.stringify({ error: 'Okänd action: ' + action }), { status: 400, headers: JSON_H });
  } catch (err) {
    console.error('Error:', (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: JSON_H });
  }
});
