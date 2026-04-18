// send-booking-email
// Skickar bekräftelse-, påminnelse- och admin-mail för Hönshyltegård-bokningar.
//
// Triggas på tre sätt:
//   1) Supabase Database Webhook (bookings UPDATE) — payment_status → 'paid'
//      skickar confirmation till kund + admin-notifikation till Helena.
//   2) pg_cron-schemalagd POST med {type:'reminder'} — skickar påminnelser
//      för bokningar 24h framåt där reminder_sent_at är null.
//   3) Manuell POST med {booking_id, type:'confirmation'|'reminder'|'admin_notify'}
//      — för felsökning/återsändning.
//
// Env-variabler som måste vara satta på functionen:
//   RESEND_API_KEY   — från resend.com
//   EMAIL_FROM       — t.ex. "Hönshyltegård <boka@honshyltegard.nu>"
//   ADMIN_EMAIL      — Helenas e-post
//   WEBHOOK_SECRET   — delad hemlighet för DB-webhook-autentisering
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — auto-populeras av plattformen

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY")!;
const EMAIL_FROM   = Deno.env.get("EMAIL_FROM") ?? "Hönshyltegård <boka@honshyltegard.nu>";
const ADMIN_EMAIL  = Deno.env.get("ADMIN_EMAIL") ?? "";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";

const SB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

type Booking = {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  adults: number;
  children: number;
  alpacas: number | null;
  note: string | null;
  total_price: number;
  abicart_order_id: number | null;
  slot_id: number | null;
  service_id: number;
  payment_status: string;
  status: string;
  created_at: string;
  reminder_sent_at?: string | null;
  services?: { name: string } | null;
  time_slots?: { slot_date: string; slot_time: string } | null;
};

async function fetchBooking(id: number): Promise<Booking | null> {
  const url = `${SUPABASE_URL}/rest/v1/bookings?id=eq.${id}` +
    `&select=*,services(name),time_slots(slot_date,slot_time)`;
  const r = await fetch(url, { headers: SB_HEADERS });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] ?? null;
}

async function fetchBookingsForReminder(dayIso: string): Promise<Booking[]> {
  // Hämtar paid-bokningar där slot_date = dayIso och reminder_sent_at är null
  const url = `${SUPABASE_URL}/rest/v1/bookings` +
    `?payment_status=eq.paid&reminder_sent_at=is.null` +
    `&select=*,services(name),time_slots!inner(slot_date,slot_time)` +
    `&time_slots.slot_date=eq.${dayIso}`;
  const r = await fetch(url, { headers: SB_HEADERS });
  if (!r.ok) return [];
  return r.json();
}

async function markReminderSent(id: number) {
  await fetch(`${SUPABASE_URL}/rest/v1/bookings?id=eq.${id}`, {
    method: "PATCH",
    headers: SB_HEADERS,
    body: JSON.stringify({ reminder_sent_at: new Date().toISOString() }),
  });
}

async function sendViaResend(to: string | string[], subject: string, html: string, text: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, html, text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Mall ─────────────────────────────────────────────────
const BRAND = {
  green: "#3D5A3E",
  brown: "#5C3D1E",
  cream: "#F5F0E8",
  surface: "#FDFAF4",
  muted: "#7A6A55",
  border: "#D8CFBF",
};

function formatSEK(n: number) {
  return new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK", maximumFractionDigits: 0 }).format(n);
}
function formatDate(iso: string) {
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00" : ""));
  return d.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function renderShell(title: string, bodyHtml: string) {
  return `<!DOCTYPE html>
<html lang="sv"><head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:${BRAND.cream};font-family:Georgia,'Times New Roman',serif;color:#221A0F">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:${BRAND.surface};border-radius:14px;overflow:hidden;border:1px solid ${BRAND.border}" cellpadding="0" cellspacing="0">
        <tr><td style="padding:32px 32px 16px;text-align:center;border-bottom:1px solid ${BRAND.border}">
          <div style="font-size:32px;margin-bottom:8px">🦙</div>
          <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND.green};font-family:Arial,sans-serif">Hönshyltegård</div>
        </td></tr>
        <tr><td style="padding:28px 32px">${bodyHtml}</td></tr>
        <tr><td style="padding:20px 32px;background:${BRAND.cream};border-top:1px solid ${BRAND.border};font-family:Arial,sans-serif;font-size:12px;color:${BRAND.muted};line-height:1.7">
          <strong style="color:${BRAND.brown}">Hönshyltegård</strong><br>
          Hönshyltavägen 8, 360 24 Linneryd · <a href="https://honshyltegard.nu" style="color:${BRAND.green}">honshyltegard.nu</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderDetails(b: Booking) {
  const svc = b.services?.name ?? `#${b.service_id}`;
  const when = b.time_slots?.slot_date
    ? `${formatDate(b.time_slots.slot_date)} kl. ${b.time_slots.slot_time.substring(0,5)}`
    : "Datum meddelas";
  const guests = `${b.adults} vuxna` + (b.children ? `, ${b.children} barn` : "");
  const row = (label: string, value: string) => `
    <tr><td style="padding:8px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.muted};font-size:13px;font-family:Arial,sans-serif">${label}</td>
    <td style="padding:8px 0;border-bottom:1px solid ${BRAND.border};text-align:right;color:${BRAND.brown};font-size:14px;font-weight:600;font-family:Arial,sans-serif">${value}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 4px">
    ${row("Upplevelse", svc)}
    ${row("När", when)}
    ${row("Gäster", guests)}
    ${b.alpacas ? row("Alpackor", `${b.alpacas} st`) : ""}
    ${row("Bokningsnr", `#${b.id}`)}
    ${row("Totalt", formatSEK(b.total_price))}
  </table>`;
}

function tmplConfirmation(b: Booking) {
  const body = `
    <h1 style="font-family:Georgia,serif;font-size:26px;color:${BRAND.brown};margin:0 0 8px">Tack ${escapeHtml(b.first_name)}!</h1>
    <p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#221A0F;margin:0 0 20px">Din bokning är bekräftad och betalningen har registrerats. Vi ser fram emot att träffa dig.</p>
    ${renderDetails(b)}
    <div style="margin-top:24px;padding:16px 18px;background:${BRAND.cream};border-radius:10px;font-family:Arial,sans-serif;font-size:13px;line-height:1.7;color:${BRAND.brown}">
      <strong>Praktisk info</strong><br>
      · Adress: Hönshyltavägen 8, 360 24 Linneryd<br>
      · Kom 5–10 min innan avgång<br>
      · Klä dig efter väder – stadiga skor rekommenderas<br>
      · Mobil på ljudlöst, inga andra djur<br>
      · Vid extremt väder kontaktar vi dig i förväg<br>
      · Frågor? Svara på det här mailet
    </div>`;
  const text =
`Tack ${b.first_name}!

Din bokning är bekräftad.

Upplevelse: ${b.services?.name ?? b.service_id}
När: ${b.time_slots?.slot_date ? formatDate(b.time_slots.slot_date) + " kl. " + b.time_slots.slot_time.substring(0,5) : "meddelas"}
Gäster: ${b.adults} vuxna${b.children ? `, ${b.children} barn` : ""}
Bokningsnr: #${b.id}
Totalt: ${formatSEK(b.total_price)}

Adress: Hönshyltavägen 8, 360 24 Linneryd
Kom 5–10 min innan avgång. Klä dig efter väder.
Mobil på ljudlöst. Inga andra djur.
Frågor? Svara på det här mailet.

Hönshyltegård
honshyltegard.nu`;
  return {
    subject: `Bokningsbekräftelse – Hönshyltegård (#${b.id})`,
    html: renderShell("Bokningsbekräftelse", body),
    text,
  };
}

function tmplReminder(b: Booking) {
  const body = `
    <h1 style="font-family:Georgia,serif;font-size:26px;color:${BRAND.brown};margin:0 0 8px">Vi ses imorgon, ${escapeHtml(b.first_name)}!</h1>
    <p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#221A0F;margin:0 0 20px">En vänlig påminnelse om din bokning. Vi ser fram emot ditt besök.</p>
    ${renderDetails(b)}
    <div style="margin-top:24px;padding:16px 18px;background:${BRAND.cream};border-radius:10px;font-family:Arial,sans-serif;font-size:13px;line-height:1.7;color:${BRAND.brown}">
      <strong>Tänk på</strong><br>
      · Kläder efter väder + stadiga skor<br>
      · Kom 5–10 min innan avgång<br>
      · Är du förhindrad? Svara på detta mail så hittar vi en lösning
    </div>`;
  const text =
`Hej ${b.first_name}! En vänlig påminnelse om din bokning hos Hönshyltegård imorgon.

Upplevelse: ${b.services?.name ?? b.service_id}
När: ${b.time_slots?.slot_date ? formatDate(b.time_slots.slot_date) + " kl. " + b.time_slots.slot_time.substring(0,5) : ""}
Gäster: ${b.adults} vuxna${b.children ? `, ${b.children} barn` : ""}
Bokningsnr: #${b.id}

Kläder efter väder, kom 5–10 min innan avgång. Är du förhindrad — svara på mailet.`;
  return {
    subject: `Påminnelse – Hönshyltegård imorgon (#${b.id})`,
    html: renderShell("Påminnelse", body),
    text,
  };
}

function tmplAdminNotify(b: Booking) {
  const body = `
    <h1 style="font-family:Georgia,serif;font-size:22px;color:${BRAND.brown};margin:0 0 8px">Ny bokning – #${b.id}</h1>
    <p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#221A0F;margin:0 0 20px">Betalning registrerad. Bokningen är aktiv.</p>
    ${renderDetails(b)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
      <tr><td style="padding:8px 0;color:${BRAND.muted};font-size:13px;font-family:Arial,sans-serif">Namn</td>
      <td style="padding:8px 0;text-align:right;color:${BRAND.brown};font-size:14px;font-family:Arial,sans-serif">${escapeHtml(b.first_name)} ${escapeHtml(b.last_name)}</td></tr>
      <tr><td style="padding:8px 0;color:${BRAND.muted};font-size:13px;font-family:Arial,sans-serif">E-post</td>
      <td style="padding:8px 0;text-align:right;color:${BRAND.brown};font-size:14px;font-family:Arial,sans-serif">${escapeHtml(b.email)}</td></tr>
      ${b.phone ? `<tr><td style="padding:8px 0;color:${BRAND.muted};font-size:13px;font-family:Arial,sans-serif">Telefon</td>
      <td style="padding:8px 0;text-align:right;color:${BRAND.brown};font-size:14px;font-family:Arial,sans-serif">${escapeHtml(b.phone)}</td></tr>` : ""}
      ${b.note ? `<tr><td colspan="2" style="padding:12px 14px;background:${BRAND.cream};border-radius:8px;margin-top:8px;font-size:13px;color:${BRAND.brown};font-family:Arial,sans-serif">Övrigt: ${escapeHtml(b.note)}</td></tr>` : ""}
    </table>`;
  return {
    subject: `[Hönshyltegård] Ny bokning #${b.id} – ${b.first_name} ${b.last_name}`,
    html: renderShell("Ny bokning", body),
    text: `Ny bokning #${b.id}\n${b.first_name} ${b.last_name} · ${b.email}${b.phone ? " · " + b.phone : ""}\n${b.services?.name ?? b.service_id} · ${b.time_slots?.slot_date ?? ""} ${b.time_slots?.slot_time?.substring(0,5) ?? ""}\n${b.adults} vuxna${b.children ? ", " + b.children + " barn" : ""} · ${formatSEK(b.total_price)}${b.note ? "\nÖvrigt: " + b.note : ""}`,
  };
}

function escapeHtml(s: string) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ── Huvudhandler ────────────────────────────────────────
Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Webhook-Secret, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: cors });

  let payload: Record<string, unknown>;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: "invalid json" }, 400, cors); }

  // Identifiera trigger-typ
  const isDbWebhook = payload && typeof payload === "object" && "type" in payload && "record" in payload && "table" in payload;
  const manualType = (payload as any).type as string | undefined;

  try {
    // Fall 1: Database Webhook (bookings UPDATE)
    if (isDbWebhook) {
      if (WEBHOOK_SECRET) {
        const got = req.headers.get("X-Webhook-Secret");
        if (got !== WEBHOOK_SECRET) return json({ ok: false, error: "unauthorized" }, 401, cors);
      }
      const webhook = payload as { type: string; record: Booking; old_record: Booking | null };
      if (webhook.type !== "UPDATE") return json({ ok: true, skipped: "not-update" }, 200, cors);
      const oldStatus = webhook.old_record?.payment_status;
      const newStatus = webhook.record?.payment_status;
      if (newStatus !== "paid" || oldStatus === "paid") {
        return json({ ok: true, skipped: "not-newly-paid" }, 200, cors);
      }
      const full = await fetchBooking(webhook.record.id);
      if (!full) return json({ ok: false, error: "booking not found" }, 404, cors);
      const customer = tmplConfirmation(full);
      await sendViaResend(full.email, customer.subject, customer.html, customer.text);
      if (ADMIN_EMAIL) {
        const adm = tmplAdminNotify(full);
        await sendViaResend(ADMIN_EMAIL, adm.subject, adm.html, adm.text);
      }
      return json({ ok: true, sent: ["confirmation", ADMIN_EMAIL ? "admin" : null].filter(Boolean) }, 200, cors);
    }

    // Fall 2: Schemalagd påminnelse (cron)
    if (manualType === "reminder" && !(payload as any).booking_id) {
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().substring(0, 10);
      const day = (payload as any).date ?? tomorrow;
      const list = await fetchBookingsForReminder(day);
      let sent = 0;
      for (const b of list) {
        try {
          const t = tmplReminder(b);
          await sendViaResend(b.email, t.subject, t.html, t.text);
          await markReminderSent(b.id);
          sent++;
        } catch (e) { console.warn("reminder", b.id, (e as Error).message); }
      }
      return json({ ok: true, date: day, candidates: list.length, sent }, 200, cors);
    }

    // Fall 3: Manuell återsändning {booking_id, type}
    const bookingId = Number((payload as any).booking_id);
    const type = manualType ?? "confirmation";
    if (!bookingId) return json({ ok: false, error: "booking_id required" }, 400, cors);
    const b = await fetchBooking(bookingId);
    if (!b) return json({ ok: false, error: "booking not found" }, 404, cors);
    let tpl;
    let to: string;
    if (type === "confirmation") { tpl = tmplConfirmation(b); to = b.email; }
    else if (type === "reminder") { tpl = tmplReminder(b); to = b.email; }
    else if (type === "admin_notify") {
      if (!ADMIN_EMAIL) return json({ ok: false, error: "ADMIN_EMAIL not configured" }, 400, cors);
      tpl = tmplAdminNotify(b); to = ADMIN_EMAIL;
    } else {
      return json({ ok: false, error: "unknown type" }, 400, cors);
    }
    await sendViaResend(to, tpl.subject, tpl.html, tpl.text);
    return json({ ok: true, type, to }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500, cors);
  }
});

function json(body: unknown, status: number, extraHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extraHeaders, "Content-Type": "application/json" },
  });
}
