// upgrade_to_supabase_auth.ts
//
// Uppgraderar din befintliga supabase/functions/admin/index.ts från PIN-auth
// till Supabase Auth JWT. Den nya dashboarden (dashboard.html) anropar
// admin-functionen med `Authorization: Bearer <session.access_token>`.
//
// INSTRUKTIONER:
//   1. Öppna din nuvarande admin/index.ts
//   2. Ersätt PIN-verifieringen med authenticateRequest() nedan
//   3. Lägg till de saknade action-grenarna (deleteBooking, updateBookingStatus,
//      createBulkSlots) bland dina andra `if (action === ...)` checks
//   4. Deploy: supabase functions deploy admin --project-ref zyokiwrzxpgtrsnfymke
//
// Deploy med verify_jwt=true för automatisk JWT-validering — då räcker det
// att plattformen sköter auth-checken och vi bara läser användarens identitet:
//   supabase functions deploy admin --project-ref zyokiwrzxpgtrsnfymke
// (verify_jwt är default true, inget flag behövs)
//
// Om du ändå vill göra manuell verifiering (t.ex. om du deployar med verify_jwt=false),
// använd authenticateRequest() nedan.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Auth: läs user från Authorization-headern via Supabase Auth API ──
async function authenticateRequest(req: Request): Promise<{ user: { id: string; email: string; user_metadata?: Record<string, unknown> } } | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user?.id || !user?.email) return null;
  return { user };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Huvudhandler (exempel — anpassa till din befintliga struktur) ──
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // Autentisera
  const auth = await authenticateRequest(req);
  if (!auth) return json({ ok: false, error: "unauthorized" }, 401);

  // (Valfritt) kontrollera admin-roll via user_metadata
  // if (auth.user.user_metadata?.role !== "admin") return json({ ok: false, error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const action = (body as any).action as string;

  // ── action: getDashboard (befintlig — anpassa till ditt namn) ──
  if (action === "getDashboard") {
    // ... (din existerande kod här)
  }

  // ── action: deleteBooking ──
  if (action === "deleteBooking") {
    const id = Number((body as any).id);
    if (!id) return json({ ok: false, error: "id required" }, 400);
    const r = await fetch(`${SB_URL}/rest/v1/bookings?id=eq.${id}`, {
      method: "DELETE",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=representation",
      },
    });
    if (!r.ok) return json({ ok: false, error: await r.text() }, r.status);
    const rows = await r.json();
    return json({ ok: true, deleted: rows.length });
  }

  // ── action: updateBookingStatus ──
  if (action === "updateBookingStatus") {
    const id = Number((body as any).id);
    const status = String((body as any).status || "");
    const ALLOWED = ["confirmed", "completed", "cancelled", "no_show", "pending_payment"];
    if (!id || !ALLOWED.includes(status)) {
      return json({ ok: false, error: "id + valid status required" }, 400);
    }
    const r = await fetch(`${SB_URL}/rest/v1/bookings?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) return json({ ok: false, error: await r.text() }, r.status);
    const rows = await r.json();
    return json({ ok: true, booking: rows[0] || null });
  }

  // ── action: createBulkSlots ──
  // Skapar time_slots-rader från (from, to, times, service_id, max_spots).
  // Optional `weekdays` är en lista av getDay()-värden (0=Sön, 1=Mån, ..., 6=Lör)
  // — bara datum vars veckodag finns i listan får tider. Utelämnad = alla dagar.
  // Hoppar över tider som redan finns (unique on service_id + slot_date + slot_time).
  if (action === "createBulkSlots") {
    const { service_id, from, to, times, max_spots, weekdays } = body as any;
    if (!service_id || !from || !to || !Array.isArray(times) || !max_spots) {
      return json({ ok: false, error: "service_id, from, to, times[], max_spots required" }, 400);
    }
    const wdFilter: number[] | null = Array.isArray(weekdays) && weekdays.length > 0
      ? weekdays.map((w: unknown) => Number(w)).filter((w: number) => w >= 0 && w <= 6)
      : null;
    const rows: Array<{ service_id: number; slot_date: string; slot_time: string; max_spots: number; booked_spots: number; active: boolean }> = [];
    const start = new Date(from + "T12:00:00");
    const end = new Date(to + "T12:00:00");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (wdFilter && !wdFilter.includes(d.getDay())) continue;
      const dateStr = d.toISOString().substring(0, 10);
      for (const t of times) {
        const time = t.length === 5 ? t + ":00" : t;
        rows.push({ service_id: Number(service_id), slot_date: dateStr, slot_time: time, max_spots: Number(max_spots), booked_spots: 0, active: true });
      }
    }
    if (rows.length === 0) return json({ ok: true, requested: 0, created: 0 });
    const r = await fetch(`${SB_URL}/rest/v1/time_slots`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation,resolution=ignore-duplicates",
      },
      body: JSON.stringify(rows),
    });
    if (!r.ok) return json({ ok: false, error: await r.text() }, r.status);
    const created = await r.json();
    return json({ ok: true, requested: rows.length, created: created.length });
  }

  // ── action: deleteBulkSlots (din befintliga — inget behöver ändras) ──

  return json({ ok: false, error: "unknown action: " + action }, 400);
});
