-- rename_visning_service.sql
-- Byter namn på tjänsten "Visning av alpacka" till "Träffa & Mata Alpacka".
-- Idempotent: kör om utan effekt om namnet redan är ändrat.
--
-- Befintliga bokningar och time_slots refererar till service_id, så
-- relationerna är intakta även efter rename.

UPDATE services
   SET name = 'Träffa & Mata Alpacka'
 WHERE name = 'Visning av alpacka';
