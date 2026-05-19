-- cleanup_test_bookings_v2.sql
-- Säker städning av test-bokningar. Tar ENDAST bort bokningar som är
-- (a) från ett känt test-konto eller med "test" i namnet, OCH
-- (b) inte betalda och inte bekräftade.
-- Riktiga betalda bokningar rörs aldrig.
--
-- Kör i Supabase SQL Editor — gå igenom stegen i ordning. Stega manuellt
-- (markera + Run) så du ser preview innan DELETE körs.

-- ── STEG 1: Förhandsvisa vad som matchar ──────────────────
-- Granska listan noggrant. Är något du vill behålla? Avbryt och justera.
SELECT
  id,
  created_at,
  first_name,
  last_name,
  email,
  status,
  payment_status,
  abicart_order_id,
  total_price,
  source
FROM bookings
WHERE
  -- (a) test-signal
  (
    LOWER(COALESCE(email, '')) IN ('rasmus@samify.se', 'info@samify.se')
    OR LOWER(COALESCE(first_name, '')) LIKE 'test%'
    OR LOWER(COALESCE(last_name, ''))  LIKE 'test%'
  )
  -- (b) aldrig betald, aldrig bekräftad
  AND payment_status IS DISTINCT FROM 'paid'
  AND status IN ('pending_payment', 'cancelled')
ORDER BY id;


-- ── STEG 2: Ta bort dem ───────────────────────────────────
-- Kör först när STEG 1-listan ser rätt ut.
DELETE FROM bookings
WHERE
  (
    LOWER(COALESCE(email, '')) IN ('rasmus@samify.se', 'info@samify.se')
    OR LOWER(COALESCE(first_name, '')) LIKE 'test%'
    OR LOWER(COALESCE(last_name, ''))  LIKE 'test%'
  )
  AND payment_status IS DISTINCT FROM 'paid'
  AND status IN ('pending_payment', 'cancelled');


-- ── STEG 3: Räkna om booked_spots från verkliga bokningar ──
-- Tar hänsyn till alla återstående bokningar (ej cancelled) och summerar
-- antal personer per slot. Detta lagar ev. snedställd räkning som testet
-- lämnat efter sig — säkert att köra även om STEG 2 inte hittade något.
UPDATE time_slots ts
SET booked_spots = COALESCE(sub.taken, 0)
FROM (
  SELECT
    slot_id,
    SUM(COALESCE(adults, 0) + COALESCE(children, 0)) AS taken
  FROM bookings
  WHERE status <> 'cancelled'
  GROUP BY slot_id
) sub
WHERE ts.id = sub.slot_id
  AND ts.booked_spots IS DISTINCT FROM COALESCE(sub.taken, 0);

-- Plus: slots som inte längre har några bokningar alls → nolla
UPDATE time_slots
SET booked_spots = 0
WHERE booked_spots > 0
  AND id NOT IN (SELECT DISTINCT slot_id FROM bookings WHERE status <> 'cancelled');


-- ── STEG 4 (valfritt): Granska resultatet ─────────────────
-- Hur många bokningar finns nu? Och är någon slot fortfarande över-bookad?
SELECT
  (SELECT COUNT(*) FROM bookings) AS total_bookings,
  (SELECT COUNT(*) FROM bookings WHERE payment_status = 'paid') AS paid_bookings,
  (SELECT COUNT(*) FROM time_slots WHERE booked_spots > max_spots) AS overbooked_slots;
