-- Cleanup of test bookings (run once in Supabase SQL Editor)
-- All bookings id 14-37 are test entries from rasmus@samify.se / info@samify.se,
-- created during development of the Abicart checkout flow.
-- Verified 2026-04-18: none have status=confirmed or payment_status=paid.

-- Optional: inspect before deleting
-- SELECT id, created_at, first_name, last_name, email, status, payment_status, abicart_order_id, total_price
-- FROM bookings ORDER BY id;

DELETE FROM bookings
WHERE id BETWEEN 14 AND 37
  AND email IN ('rasmus@samify.se', 'info@samify.se')
  AND status = 'pending_payment'
  AND payment_status = 'pending';

-- Reset booked_spots to 0 for any stale counts (safety net)
UPDATE time_slots SET booked_spots = 0 WHERE booked_spots > 0;

-- Corresponding Abicart order UIDs created during testing (handle manually in admin.abicart.se):
--   273158825, 273159127, 273159725, 273172031, 273172219, 273172389,
--   273474471, 273474687, 273474841
