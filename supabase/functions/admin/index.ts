import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

// Hönshyltegårds adress används av AI-mejlgeneratorn. Byt här om gården flyttar.
const FARM_ADDRESS = 'Gård Hönshyltegård, 362 96 Ryd';
const FARM_EMAIL = 'alpacka.honshyltegard@gmail.com';

const SYSTEM_PROMPT = `Du är Helena Larsson, värd på Hönshyltegård – en liten alpackagård på den småländska landsbygden. Du skriver personliga bokningsbekräftelse-mejl till kunder som har bokat en upplevelse hos dig.

GÅRDEN ERBJUDER TVÅ TJÄNSTER
1. "Alpackapromenad" – en guidad promenad på ca 60 minuter ute i naturen, i alpackornas eget lugna tempo. Vuxna och ungdomar 12+ kostar 295 kr, barn 5–12 år 195 kr. Minst 2 personer per bokning. Kunden kan välja att hålla i en alpacka under promenaden (max 1 per person) – det är valfritt. Avslutas med ett besök i hagen där stona och årets föl går.
2. "Visning av alpacka" – en visning på ca 30 minuter på gården där kunderna kommer nära alpackorna, får information, kan mata dem och ta foton. Vuxna 60 kr, barn 3–12 år 40 kr, barn under 3 år gratis.

Adress: ${FARM_ADDRESS}
Avbokningsmejl och kontakt: ${FARM_EMAIL}

TONALITET
- Varm, personlig, avslappnad
- "Slow living"-känsla – ingen brådska, ingen säljande ton
- Du-tilltal
- Skriv som en vänlig värd, inte som en korporat receptionist
- Undvik klyschor som "fantastisk upplevelse" eller "vi ser fram emot er resa"
- Inga emojis – text-elegant tonläge

INNEHÅLL (anpassa efter bokningen, behöver inte vara i exakt denna ordning)
1. Personlig hälsning med kundens förnamn + tack för bokningen
2. Bekräftelse av detaljer: tjänst, datum, tid, antal personer
3. Vad de kan förvänta sig under besöket – anpassa beskrivningen efter tjänsten
4. Praktiska tips: kom 5–10 minuter innan, klä efter väder (för promenad: extra viktigt + stadiga skor), parkering finns på gården
5. Lugn närvaro runt djuren är viktigt – nämn det varmt, inte i ordningston
6. Avbokningspolicy: 24h innan = full återbetalning, kontakta ${FARM_EMAIL}
7. För Alpackapromenad: nämn kort att vi kontaktar kunden om vädret kräver att vi ställer in (åska, extrem hetta, ovädersnivåer)
8. Personlig avslutning från Helena

ANPASSNINGAR
- "Slutet sällskap" bokat → tacka extra varmt för helbokningen, nämn att tiden är helt deras grupps
- "Särskilda behov" angetts → bekräfta att du läst det, beskriv kort hur ni anpassar (t.ex. extra lugnt tempo, hjälp att komma fram, kontakta gärna innan om något specifikt behövs)
- "Övrigt"-meddelande från kund → bekräfta att du läst det och bemöt det naturligt – om det är en fråga, svara; om det är ett önskemål, bekräfta
- Barn med → varm hälsning, mjuk påminnelse om att även barn behöver vara lugna runt djuren, inget pekpinne-tonläge
- Alpackor reserverade → bekräfta antal och nämn att de är redo att hållas i

LÄNGD OCH FORMAT
- 200–350 ord
- Plain text, ingen markdown, inga emojis, inga rubriker med ##
- Inga tomma rader i mitten av brödtexten – styckesindelning räcker
- Returnera bara mejltexten – ingen ämnesrad, ingen "Hej:"-metadata, ingen prefix som "Här är mejlet:"

SPRÅK
- Skriv på det språk som anges som "Önskat språk för mejlet" i input
- "sv" = svenska, "en" = engelska, "de" = tyska
- Behåll samma personliga ton oavsett språk
- Undvik alltför formellt tyskt eller engelskt – matcha den svenska tonens värme

VIKTIGT
- Hitta inte på info som inte finns i prompten (t.ex. specifika fika-priser, andra tjänster, etc.)
- Om något fält saknas i bokningen, hoppa över det istället för att gissa
- Adressen som ska användas är exakt: ${FARM_ADDRESS}
- Avbokningsmejlet är exakt: ${FARM_EMAIL}`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SB = (path: string, method = 'GET', body?: object) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function authenticateRequest(req: Request) {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  return user?.id ? user : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const user = await authenticateRequest(req);
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const { action } = body;

  try {
    if (action === 'getDashboard') {
      const today = new Date().toISOString().split('T')[0];
      const weekEnd = new Date();
      weekEnd.setDate(weekEnd.getDate() + 7);
      const weekStr = weekEnd.toISOString().split('T')[0];

      const [bookingsRes, slotsRes, servicesRes] = await Promise.all([
        SB('bookings?order=created_at.desc&select=*,services(name)'),
        SB(`time_slots?slot_date=gte.${today}&slot_date=lte.${weekStr}&active=eq.true&order=slot_date,slot_time&select=*,services(name)`),
        SB('services?active=eq.true&order=id'),
      ]);

      const [bookings, upcomingSlots, services] = await Promise.all([
        bookingsRes.json(),
        slotsRes.json(),
        servicesRes.json(),
      ]);

      return json({ ok: true, bookings, upcomingSlots, services });
    }

    if (action === 'getSlots') {
      const { from, to } = body;
      const r = await SB(`time_slots?slot_date=gte.${from}&slot_date=lte.${to}&order=slot_date,slot_time&select=*,services(name)`);
      return json(await r.json());
    }

    if (action === 'createBulkSlots') {
      const { service_id, from, to, times, max_spots, weekdays } = body;
      if (!service_id || !from || !to || !Array.isArray(times) || !times.length || !max_spots) {
        return json({ ok: false, error: 'service_id, from, to, times[], max_spots required' }, 400);
      }
      const wdFilter: number[] | null = Array.isArray(weekdays) && weekdays.length > 0
        ? weekdays.map((w: unknown) => Number(w)).filter((w: number) => w >= 0 && w <= 6)
        : null;
      const slots: Array<{ service_id: number; slot_date: string; slot_time: string; max_spots: number; booked_spots: number; active: boolean }> = [];
      const start = new Date(from + 'T12:00:00');
      const end = new Date(to + 'T12:00:00');
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (wdFilter && !wdFilter.includes(d.getDay())) continue;
        const dateStr = d.toISOString().substring(0, 10);
        for (const t of times) {
          const time = t.length === 5 ? t + ':00' : t;
          slots.push({
            service_id: Number(service_id),
            slot_date: dateStr,
            slot_time: time,
            max_spots: Number(max_spots),
            booked_spots: 0,
            active: true,
          });
        }
      }
      if (slots.length === 0) return json({ ok: true, requested: 0, created: 0 });
      const r = await fetch(`${SB_URL}/rest/v1/time_slots`, {
        method: 'POST',
        headers: {
          apikey: SB_SERVICE_KEY,
          Authorization: `Bearer ${SB_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation,resolution=ignore-duplicates',
        },
        body: JSON.stringify(slots),
      });
      if (!r.ok) return json({ ok: false, error: await r.text() }, r.status);
      const created = await r.json();
      return json({ ok: true, requested: slots.length, created: created.length });
    }

    if (action === 'deleteBulkSlots') {
      const { ids } = body;
      if (!Array.isArray(ids) || !ids.length) return json({ ok: false, error: 'Inga IDs' }, 400);
      const safeIds = ids.map((x: unknown) => Number(x)).filter((n: number) => Number.isFinite(n));
      if (!safeIds.length) return json({ ok: false, error: 'Ogiltiga IDs' }, 400);
      const r = await fetch(`${SB_URL}/rest/v1/time_slots?id=in.(${safeIds.join(',')})`, {
        method: 'DELETE',
        headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` },
      });
      if (!r.ok) return json({ ok: false, error: await r.text() }, r.status);
      return json({ ok: true, deleted: safeIds.length });
    }

    if (action === 'deleteBooking') {
      const id = Number(body.id);
      if (!id) return json({ ok: false, error: 'id required' }, 400);
      const r = await fetch(`${SB_URL}/rest/v1/bookings?id=eq.${id}`, {
        method: 'DELETE',
        headers: {
          apikey: SB_SERVICE_KEY,
          Authorization: `Bearer ${SB_SERVICE_KEY}`,
          Prefer: 'return=representation',
        },
      });
      if (!r.ok) return json({ ok: false, error: await r.text() }, r.status);
      const rows = await r.json();
      return json({ ok: true, deleted: rows.length });
    }

    if (action === 'updateBookingStatus') {
      const id = Number(body.id);
      const status = String(body.status || '');
      const ALLOWED = ['confirmed', 'completed', 'cancelled', 'no_show', 'pending_payment'];
      if (!id || !ALLOWED.includes(status)) {
        return json({ ok: false, error: 'id + valid status required' }, 400);
      }
      const r = await fetch(`${SB_URL}/rest/v1/bookings?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
          apikey: SB_SERVICE_KEY,
          Authorization: `Bearer ${SB_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) return json({ ok: false, error: await r.text() }, r.status);
      const rows = await r.json();
      return json({ ok: true, booking: rows[0] || null });
    }

    if (action === 'generateConfirmationEmail') {
      if (!ANTHROPIC_API_KEY) return json({ ok: false, error: 'ANTHROPIC_API_KEY saknas i edge function-secrets' }, 500);
      const id = Number(body.id);
      const lang = ['sv','en','de'].includes(String(body.lang || '').toLowerCase()) ? String(body.lang).toLowerCase() : 'sv';
      if (!id) return json({ ok: false, error: 'id required' }, 400);

      // Hämta bokningen med tjänst + slot
      const r = await SB(`bookings?id=eq.${id}&select=*,services(name),time_slots(slot_date,slot_time)`);
      if (!r.ok) return json({ ok: false, error: await r.text() }, r.status);
      const rows = await r.json();
      if (!rows.length) return json({ ok: false, error: 'Bokning hittades inte' }, 404);
      const b = rows[0];
      const slot = b.time_slots || {};

      // Bygg per-bokning prompt
      const lines: string[] = [];
      lines.push(`Kundens namn: ${b.first_name} ${b.last_name}`);
      lines.push(`Kundens e-post: ${b.email}`);
      if (b.phone) lines.push(`Telefon: ${b.phone}`);
      lines.push(`Tjänst: ${b.services?.name || 'Okänd'}`);
      lines.push(`Datum: ${slot.slot_date || '–'}`);
      lines.push(`Tid: ${(slot.slot_time || '').substring(0,5)}`);
      lines.push(`Vuxna: ${b.adults || 0}`);
      if (b.children) lines.push(`Barn: ${b.children}`);
      if (b.alpacas) lines.push(`Alpackor som är reserverade att hålla i: ${b.alpacas}`);
      if (b.private_party) lines.push(`Slutet sällskap: JA`);
      if (b.special_needs) lines.push(`Särskilda behov (kund har skrivit): ${b.special_needs}`);
      if (b.note) lines.push(`Övrigt-meddelande från kund: ${b.note}`);
      lines.push(`Önskat språk för mejlet: ${lang}`);

      const userPrompt = `Skriv ett bokningsbekräftelse-mejl till denna kund:\n\n${lines.join('\n')}`;

      const cr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      if (!cr.ok) {
        const err = await cr.text();
        return json({ ok: false, error: 'Claude API fel: ' + err }, 500);
      }
      const data = await cr.json();
      const email = (data?.content?.[0]?.text ?? '').trim();
      const usage = data?.usage || {};
      return json({ ok: true, email, usage });
    }

    return json({ ok: false, error: 'Okänd action: ' + action }, 400);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
