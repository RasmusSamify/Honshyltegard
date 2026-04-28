-- add_booking_extras.sql
-- Lägger till två fält som widgeten skickar in:
--   private_party  – kunden bockar i "Slutet sällskap"
--   special_needs  – fritext från kund med särskilda behov (rullstol, hörsel, allergier etc)
--
-- Kör i Supabase SQL Editor. Idempotent (säker att köra om).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS private_party BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS special_needs TEXT;
