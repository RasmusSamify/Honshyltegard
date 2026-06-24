-- notify_owner_on_booking.sql
-- "Plingen" — Postgres-trigger som skickar ett mejl direkt via Resend när
-- en bokning blivit betald.
--
-- Triggas när bookings.status går till 'confirmed' eller payment_status
-- går till 'paid'. Idempotent via owner_notified_at — sätts i triggern så
-- ytterligare UPDATE:n på samma rad inte skickar dubbla mejl.
--
-- Resend-nyckeln läses från Supabase Vault. pg_net anropar Resend's API
-- direkt — inga edge functions inblandade.
--
-- ─── ENGÅNGS-SETUP ──────────────────────────────────────────────────────────
-- 1. Lagra Resend-nyckeln i Vault (engångsjobb, kräver inte superuser):
--
--      SELECT vault.create_secret('re_xxx...', 'resend_api_key');
--
--    Verifiera:
--      SELECT name FROM vault.decrypted_secrets WHERE name = 'resend_api_key';
--
-- 2. Kör hela denna fil i Supabase SQL-editorn.
--
-- 3. Testa via UPDATE av en bokning till status='confirmed' (eller använd
--    test-SQL:en som ligger separat).
--
-- ─── KONFIG ────────────────────────────────────────────────────────────────
-- OWNER_EMAILS och DASHBOARD_URL är hårdkodade i funktionen. Byt där om de
-- behöver ändras. Plingen går till både Helena (alpacka.honshyltegard@gmail.com)
-- och Samify (info@samify.se) — lägg till/ta bort adresser i OWNER_EMAILS-arrayen.
--
-- ─── INSPEKTERA / FELSÖKA ──────────────────────────────────────────────────
--   SELECT id, status_code, (content::jsonb) AS body, created
--   FROM net._http_response
--   ORDER BY created DESC LIMIT 5;
--
-- ─── STÄNGA AV ─────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS trg_notify_owner_on_paid ON bookings;

CREATE EXTENSION IF NOT EXISTS pg_net;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS owner_notified_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.notify_owner_on_paid_booking()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Mottagare av plingen. Helena (gården) + Samify som kopia.
  OWNER_EMAILS  constant text[] := ARRAY['alpacka.honshyltegard@gmail.com', 'info@samify.se'];
  FROM_EMAIL    constant text := 'Hönshyltegård <bokningar@updates.samify.se>';
  DASHBOARD_URL constant text := 'https://rasmussamify.github.io/Honshyltegard/dashboard.html';

  resend_key   text;
  svc_name     text;
  slot_date    date;
  slot_time    time;
  date_label   text;
  time_label   text;
  subject      text;
  html_body    text;
  details_rows text := '';
BEGIN
  SELECT decrypted_secret INTO resend_key
  FROM vault.decrypted_secrets
  WHERE name = 'resend_api_key'
  LIMIT 1;

  IF resend_key IS NULL OR resend_key = '' THEN
    RAISE WARNING 'Vault-secret resend_api_key saknas — hoppar över plingen';
    RETURN NEW;
  END IF;

  -- Markera som mejlat direkt så ev. ytterligare UPDATE:n på raden inte
  -- skickar dubbla mejl. Om Resend failar syns det i net._http_response.
  UPDATE bookings SET owner_notified_at = now() WHERE id = NEW.id;

  SELECT s.name, ts.slot_date, ts.slot_time
  INTO svc_name, slot_date, slot_time
  FROM services s
  LEFT JOIN time_slots ts ON ts.id = NEW.slot_id
  WHERE s.id = NEW.service_id;

  date_label := to_char(slot_date, 'TMDay DD TMMonth YYYY');
  time_label := to_char(slot_time, 'HH24:MI');

  details_rows := details_rows
    || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">Tjänst</td><td><strong>' || coalesce(svc_name,'—') || '</strong></td></tr>'
    || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">Datum</td><td>' || coalesce(date_label,'—') || '</td></tr>'
    || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">Tid</td><td>' || coalesce(time_label,'—') || '</td></tr>'
    || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">Vuxna</td><td>' || coalesce(NEW.adults,0) || '</td></tr>';

  IF coalesce(NEW.children, 0) > 0 THEN
    details_rows := details_rows
      || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">Barn</td><td>' || NEW.children || '</td></tr>';
  END IF;
  IF coalesce(NEW.alpacas, 0) > 0 THEN
    details_rows := details_rows
      || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">Alpackor att hålla i</td><td>' || NEW.alpacas || '</td></tr>';
  END IF;
  IF coalesce(NEW.private_party, false) THEN
    details_rows := details_rows
      || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">Slutet sällskap</td><td>Ja</td></tr>';
  END IF;
  IF NEW.special_needs IS NOT NULL AND NEW.special_needs <> '' THEN
    details_rows := details_rows
      || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50;vertical-align:top">Särskilda behov</td><td>' || NEW.special_needs || '</td></tr>';
  END IF;
  IF NEW.note IS NOT NULL AND NEW.note <> '' THEN
    details_rows := details_rows
      || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50;vertical-align:top">Meddelande</td><td>' || NEW.note || '</td></tr>';
  END IF;
  details_rows := details_rows
    || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">E-post</td><td><a href="mailto:' || NEW.email || '">' || NEW.email || '</a></td></tr>';
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' THEN
    details_rows := details_rows
      || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">Telefon</td><td>' || NEW.phone || '</td></tr>';
  END IF;
  details_rows := details_rows
    || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">Totalt</td><td>' || coalesce(NEW.total_price::text, '—') || ' kr</td></tr>'
    || '<tr><td style="padding:4px 12px 4px 0;color:#7A6A50">Bokningsnr</td><td>#' || NEW.id || '</td></tr>';

  subject := 'Ny bokning · ' || NEW.first_name || ' ' || NEW.last_name
    || ' · ' || coalesce(svc_name, 'Bokning')
    || ' ' || coalesce(date_label, '') || ' kl. ' || coalesce(time_label, '');

  html_body :=
    '<div style="font-family:Jost,Helvetica,Arial,sans-serif;color:#221808;line-height:1.6;max-width:560px">'
    || '<p style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#6A9B6C;margin:0 0 8px">Plingen</p>'
    || '<h2 style="font-family:Cormorant Garamond,Georgia,serif;font-weight:400;color:#5A3A1A;font-size:26px;margin:0 0 4px">Ny bokning</h2>'
    || '<p style="margin:0 0 20px;color:#7A6A50">' || NEW.first_name || ' ' || NEW.last_name || ' har just betalat och bokat hos er.</p>'
    || '<table style="font-size:14px;border-collapse:collapse">' || details_rows || '</table>'
    || '<p style="margin:28px 0 0"><a href="' || DASHBOARD_URL || '" style="background:#3A5A3C;color:#fff;padding:10px 20px;border-radius:100px;text-decoration:none;font-size:13px">Öppna i dashboarden →</a></p>'
    || '</div>';

  PERFORM net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || resend_key
    ),
    body    := jsonb_build_object(
      'from',     FROM_EMAIL,
      'to',       to_jsonb(OWNER_EMAILS),
      'reply_to', NEW.email,
      'subject',  subject,
      'html',     html_body
    ),
    timeout_milliseconds := 10000
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_owner_on_paid ON bookings;

CREATE TRIGGER trg_notify_owner_on_paid
AFTER UPDATE ON bookings
FOR EACH ROW
WHEN (
  NEW.owner_notified_at IS NULL
  AND (
    (NEW.status = 'confirmed'     AND OLD.status     IS DISTINCT FROM 'confirmed')
    OR
    (NEW.payment_status = 'paid'  AND OLD.payment_status IS DISTINCT FROM 'paid')
  )
)
EXECUTE FUNCTION public.notify_owner_on_paid_booking();
