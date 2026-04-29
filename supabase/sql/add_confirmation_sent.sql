-- add_confirmation_sent.sql
-- Spårar när Helena har skickat det personliga bekräftelsemejlet till
-- kunden. Sätts när hon klickar "Öppna i mejlklient" eller "Markera som
-- skickat" i dashboardens bekräftelsemejl-sektion. Visar grön bock i
-- bokningslistan så hon ser vilka som är hanterade.
--
-- Kör i Supabase SQL Editor.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz;
