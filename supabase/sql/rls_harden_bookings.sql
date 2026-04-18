-- rls_harden_bookings.sql
-- Stänger ner publik läsning av kunddata på bookings.
--
-- Problem idag:
--   curl "<url>/rest/v1/bookings?select=*" -H "apikey: <ANON>"  ← returnerar ALLA bookings
--   med first_name, last_name, email, phone, note. Det vill vi inte.
--
-- Lösning:
--   Använder PostgreSQL column-level GRANTs. PostgREST respekterar dem — anon
--   kan då bara SELECT:a id + metadata, inte PII. RLS-policies är oförändrade;
--   det är column-privilegier som gör jobbet här.
--
--   Widgeten behöver fortfarande kunna:
--     · INSERT nya bookings (med PII-kolumner som input)
--     · få tillbaka id efter INSERT (return=representation)
--     · PATCH abicart_order_id + payment_status efter Abicart-order skapats
--     · SELECT sin egen bokning efter betalning (utan PII)
--
-- Admin dashboard påverkas INTE — den går via admin Edge Function som använder
-- service_role, vilken bypass:ar både RLS och column GRANTs.
--
-- Kör i Supabase SQL Editor.

-- ── 1. Reset: ta bort allt anon/authenticated har på tabellen ──
REVOKE ALL ON public.bookings FROM anon;
REVOKE ALL ON public.bookings FROM authenticated;

-- ── 2. Anon får SELECT bara på icke-PII-kolumner ──
-- (PII = first_name, last_name, email, phone, note — INTE inkluderade)
GRANT SELECT (
  id,
  service_id,
  slot_id,
  abicart_order_id,
  status,
  payment_status,
  total_price,
  adults,
  children,
  alpacas,
  created_at,
  newsletter_consent,
  reminder_sent_at
) ON public.bookings TO anon;

-- ── 3. Anon får INSERT med alla bookning-kolumner ──
-- (Widgeten skickar PII som input; det behövs för att spara bokningen)
GRANT INSERT (
  service_id,
  slot_id,
  first_name,
  last_name,
  email,
  phone,
  adults,
  children,
  alpacas,
  note,
  status,
  payment_status,
  total_price,
  newsletter_consent,
  abicart_order_id
) ON public.bookings TO anon;

-- ── 4. Anon får UPDATE bara på transaktionsdata ──
-- (abicart_order_id + payment_status — det är allt widgeten PATCHar)
-- OBS: RLS kan ändå blockera. Nuvarande RLS-policy på bookings verkar tyst blockera
-- UPDATE via anon; se om din widget-PATCH av abicart_order_id faktiskt landar.
-- Om inte, lägg till en policy:
--   CREATE POLICY "anon update own pending"
--     ON bookings FOR UPDATE TO anon
--     USING (payment_status = 'pending')
--     WITH CHECK (payment_status IN ('pending','paid'));
GRANT UPDATE (abicart_order_id, payment_status) ON public.bookings TO anon;

-- ── 5. Authenticated (Helena via Supabase Auth om ni bygger om dashboarden) ──
-- Full läsbehörighet — men fortfarande inget skrivande direkt; det går via Edge Function.
GRANT SELECT ON public.bookings TO authenticated;

-- ── 6. service_role behålls orörd (bypassar RLS + GRANTs ändå) ──
-- Behöver inte GRANT:as explicit.

-- ── 7. Verifiera ──
-- Kör dessa efter migrationen för att bekräfta:
--
-- Ska returnera 0 PII-rader (bara metadata):
--   curl "https://zyokiwrzxpgtrsnfymke.supabase.co/rest/v1/bookings?select=*&limit=1" \
--     -H "apikey: <ANON>" -H "Authorization: Bearer <ANON>"
--   (Svaret ska innehålla id, status, total_price etc — men inte first_name/email)
--
-- Uttryckligt PII-select ska ge fel:
--   curl ".../rest/v1/bookings?select=first_name,email" -H "apikey: <ANON>" ...
--   → { "code": "42501", "message": "permission denied for column first_name" }
--
-- Ska fortfarande fungera (INSERT via widget):
--   Gå igenom bokningsflödet på rasmussamify.github.io/Honshyltegard/
