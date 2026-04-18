-- email_setup.sql
-- Sätter upp allt som behövs för bekräftelse-, påminnelse- och admin-mail
-- via Edge Function `send-booking-email` + Resend.
--
-- Kör i Supabase SQL Editor efter att Edge Functionen är deployad OCH följande
-- secrets är satta på projektet (Project Settings → Edge Functions → Manage secrets):
--
--   RESEND_API_KEY   = re_xxx (från resend.com)
--   EMAIL_FROM       = Hönshyltegård <boka@honshyltegard.nu>   (verifierad avsändar-domän i Resend)
--   ADMIN_EMAIL      = helena@honshyltegard.nu                 (eller den adressen Helena vill ha)
--   WEBHOOK_SECRET   = slumpmässig sträng, t.ex. output från `openssl rand -hex 32`
--
-- SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY sätts automatiskt av plattformen.

-- ── 1. Kolumn för påminnelse-tracking ───────────────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS bookings_reminder_pending_idx
  ON bookings (payment_status, reminder_sent_at)
  WHERE payment_status = 'paid' AND reminder_sent_at IS NULL;

-- ── 2. Database Webhook: bookings UPDATE → send-booking-email ────
-- OBS: Detta kan också sättas upp via UI (Database → Webhooks → Create a new hook).
-- Det är ofta enklare via UI eftersom Supabase då tar hand om pg_net-setup
-- automatiskt. Konfiguration att använda:
--
--   Name:        bookings_paid_webhook
--   Table:       bookings (schema: public)
--   Events:      Update
--   Method:      POST
--   URL:         https://zyokiwrzxpgtrsnfymke.supabase.co/functions/v1/send-booking-email
--   HTTP Headers:
--     Content-Type: application/json
--     X-Webhook-Secret: <samma värde som WEBHOOK_SECRET-secret>
--     Authorization: Bearer <SUPABASE_ANON_KEY>   (om verify_jwt = true på functionen)
--
-- Functionen skickar bara mail när payment_status byter till 'paid', så det
-- är ofarligt att webhooken fyrar av på varje UPDATE.

-- ── 3. Schemalägg påminnelse-mail via pg_cron ───────────
-- Förutsätter att pg_cron + pg_net-extensions är aktiverade (Database → Extensions).

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Kör varje dag kl. 09:00 lokal Stockholm-tid (08:00 UTC under sommartid, 09:00 UTC under vintertid).
-- Vi kör kl 08:00 UTC året runt — funktionen hittar bokningar för morgondagen.
-- Byt tid om du vill — använd en Cron-syntax (https://crontab.guru).
SELECT cron.schedule(
  'honshyltegard-daily-reminders',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url := 'https://zyokiwrzxpgtrsnfymke.supabase.co/functions/v1/send-booking-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('type', 'reminder')
  );
  $$
);

-- OBS ang. service_role_key: pg_cron har som default inte tillgång till
-- Edge Function-autentisering. Det enklaste är att sätta funktionens
-- verify_jwt = false och skydda den med WEBHOOK_SECRET + en enkel check
-- i functionen själv. Alternativt: lagra anon-nyckeln som en postgres-setting:
--
--   ALTER DATABASE postgres SET app.settings.service_role_key = 'eyJhb...';
--
-- och behåll verify_jwt = true.

-- ── 4. (Rekommendation) RLS-härdning på bookings ────────
-- Idag kan anon-rollen SELECT alla bokningar → alla kunders namn/mail är
-- publikt läsbara om nån gissar /rest/v1/bookings. Begränsa till att bara
-- kunna INSERT + SELECT egen rad via abicart_order_id (om vi lägger till ett
-- klient-side "order key"). Lämnas som TODO — kräver widget-ändring.
--
-- Exempel på hårdare policy (avaktiverar SELECT helt för anon,
-- widgeten får i så fall läsa via Edge Function som service_role):
--
--   DROP POLICY IF EXISTS "anon read bookings" ON bookings;
--   -- och i Edge Function: exponera endast de fält kunden behöver

-- Klart. Testa gärna manuellt:
--   curl -X POST "$SUPABASE_URL/functions/v1/send-booking-email" \
--     -H "Authorization: Bearer $ANON_KEY" \
--     -H "Content-Type: application/json" \
--     -d '{"booking_id": <ID>, "type": "confirmation"}'
