import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

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

    return json({ ok: false, error: 'Okänd action: ' + action }, 400);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
