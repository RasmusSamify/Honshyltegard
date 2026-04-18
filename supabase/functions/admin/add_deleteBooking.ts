// Snippet att klistra in i din befintliga supabase/functions/admin/index.ts
//
// Dashboarden anropar nu admin-functionen med { action: 'deleteBooking', id }
// via samma PIN-auth som resten av admin-actionsen. Lägg till grenen bland
// dina övriga action-handlers (samma ställe som 'getDashboard', 'deleteBulkSlots' etc).
//
// Byt SUPABASE_URL och SERVICE_ROLE_KEY mot vad du redan läser dem som i din
// admin-function — vanligast Deno.env.get("SUPABASE_URL") och
// Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") (auto-populerade av plattformen).

if (action === "deleteBooking") {
  const id = Number(body?.id);
  if (!id) {
    return new Response(JSON.stringify({ ok: false, error: "id required" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const r = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/rest/v1/bookings?id=eq.${id}`,
    {
      method: "DELETE",
      headers: {
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
        Prefer: "return=representation",
      },
    },
  );

  if (!r.ok) {
    return new Response(JSON.stringify({ ok: false, error: await r.text() }), {
      status: r.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const rows = await r.json();
  return new Response(JSON.stringify({ ok: true, deleted: rows.length }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Bonus: updateBookingStatus (för att markera bokningar som genomförda/avbokade) ──
// Lägg även till denna om du vill kunna ändra status via dashboarden.
/*
if (action === "updateBookingStatus") {
  const id = Number(body?.id);
  const status = String(body?.status || "");
  const ALLOWED = ["confirmed", "completed", "cancelled", "no_show"];
  if (!id || !ALLOWED.includes(status)) {
    return new Response(JSON.stringify({ ok: false, error: "id + status (confirmed|completed|cancelled|no_show) required" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const r = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/rest/v1/bookings?id=eq.${id}`,
    {
      method: "PATCH",
      headers: {
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ status }),
    },
  );
  if (!r.ok) {
    return new Response(JSON.stringify({ ok: false, error: await r.text() }), {
      status: r.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const rows = await r.json();
  return new Response(JSON.stringify({ ok: true, updated: rows[0] || null }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
*/
