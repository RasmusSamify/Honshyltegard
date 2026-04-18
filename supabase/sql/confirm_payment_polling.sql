-- confirm_payment_polling.sql
-- Server-side backup för confirmPayment-flödet.
--
-- Widgeten kör redan client-side auto-verify via localStorage + pending-banner,
-- men det funkar bara om kunden återkommer i samma browser. Om kunden stänger
-- fliken direkt efter betalning skulle bokningen annars fastna i pending_payment.
-- Den här pg_cron-jobben kör var 5:e minut och letar upp sådana bokningar.
--
-- Kräver pg_cron + pg_net extensions — samma som email_setup.sql aktiverar.
-- Kör email_setup.sql först om det inte är gjort.
--
-- Förutsätter också att Edge Functionen `abicart` fortfarande exponerar
-- action 'confirmPayment' och att den själv PATCHar bookings-raden när paid.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Spara konfig som DB-settings så pg_cron-sql:en är ren.
-- (Byt 'eyJhb...' mot riktiga anon-nyckeln från projektet.)
--
--   ALTER DATABASE postgres SET app.settings.supabase_url     = 'https://zyokiwrzxpgtrsnfymke.supabase.co';
--   ALTER DATABASE postgres SET app.settings.supabase_anon_key = 'eyJhbGci...';
--
-- Alternativt: skriv in värdena direkt i SQL:en nedan.

-- Funktion som triggar confirmPayment för varje pending booking äldre än 5 min
-- och yngre än 24 h (undviker att piska orders som aldrig blir betalda).
CREATE OR REPLACE FUNCTION public.poll_pending_payments()
RETURNS TABLE(booking_id bigint, order_id bigint, request_id bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  sb_url   text := current_setting('app.settings.supabase_url', true);
  sb_key   text := current_setting('app.settings.supabase_anon_key', true);
  rec      record;
  req_id   bigint;
BEGIN
  IF sb_url IS NULL OR sb_key IS NULL THEN
    RAISE EXCEPTION 'app.settings.supabase_url och supabase_anon_key måste vara satta';
  END IF;

  FOR rec IN
    SELECT id, abicart_order_id
    FROM bookings
    WHERE payment_status = 'pending'
      AND abicart_order_id IS NOT NULL
      AND created_at <  now() - interval '5 minutes'
      AND created_at >= now() - interval '24 hours'
    ORDER BY created_at ASC
    LIMIT 20
  LOOP
    SELECT net.http_post(
      url     := sb_url || '/functions/v1/abicart',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || sb_key
      ),
      body    := jsonb_build_object(
        'action',   'confirmPayment',
        'order_id', rec.abicart_order_id
      ),
      timeout_milliseconds := 15000
    ) INTO req_id;

    booking_id := rec.id;
    order_id   := rec.abicart_order_id;
    request_id := req_id;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Schemalägg var 5:e minut
SELECT cron.schedule(
  'honshyltegard-poll-pending-payments',
  '*/5 * * * *',
  $$ SELECT * FROM public.poll_pending_payments(); $$
);

-- Inspektera svar (body + status) efter ett tag:
--   SELECT id, status_code, (content::jsonb) AS body
--   FROM net._http_response
--   ORDER BY created DESC
--   LIMIT 20;
--
-- Sluta med jobbet:
--   SELECT cron.unschedule('honshyltegard-poll-pending-payments');
