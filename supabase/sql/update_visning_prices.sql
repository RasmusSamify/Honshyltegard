-- update_visning_prices.sql
-- Höjer priserna för "Träffa & Mata Alpacka" från 60/40 till 70/50 kr
-- så widgetens beräkning matchar de nya priserna i Abicart.
-- Idempotent: targets båda gamla och nya namnet.

UPDATE services
   SET price = 70,
       price_child = 50
 WHERE name IN ('Visning av alpacka', 'Träffa & Mata Alpacka');
