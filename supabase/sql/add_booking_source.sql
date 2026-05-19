-- add_booking_source.sql
-- Lägger till `source` på bookings så vi kan särskilja bokningar Helena själv
-- lagt in (telefon, mejl, walk-in) från de som kommit via online-widgeten.
--
-- Default 'widget' — alla befintliga + framtida online-bokningar fortsätter att
-- räknas som 'widget' utan kodändring. Manuella bokningar sätter 'manual'
-- explicit via admin Edge Function.
--
-- Kör i Supabase SQL Editor. Idempotent.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'widget'
    CHECK (source IN ('widget','manual'));

-- Anon ska kunna se source när den läser sina egna bokningar efter betalning
-- (samma icke-PII-paket som rls_harden_bookings.sql redan satt upp).
GRANT SELECT (source) ON public.bookings TO anon;

-- Authenticated (Helena i dashboarden) har redan full SELECT — behöver inget.
