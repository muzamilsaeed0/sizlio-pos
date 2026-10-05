-- Sizlio POS migration: atomic restaurant-local order numbers
-- Creates a per-restaurant counter so concurrent orders cannot race on MAX(local_number).
-- Existing order numbers are preserved; counters start at MAX(local_number) + 1.

BEGIN;

CREATE TABLE IF NOT EXISTS public.restaurant_order_counters (
  restaurant_id integer PRIMARY KEY,
  next_number integer NOT NULL CHECK (next_number > 0)
);

-- Seed counters from existing committed orders.
-- For example, restaurant 3 has max local_number 285, so its next number is 286.
INSERT INTO public.restaurant_order_counters (restaurant_id, next_number)
SELECT
  o.restaurant_id,
  COALESCE(MAX(o.local_number), 0) + 1
FROM public.orders o
WHERE o.restaurant_id IS NOT NULL
  AND o.local_number IS NOT NULL
GROUP BY o.restaurant_id
ON CONFLICT (restaurant_id) DO NOTHING;

COMMIT;
