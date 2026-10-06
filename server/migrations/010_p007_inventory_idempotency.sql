BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS inventory_deducted_at timestamp without time zone;

-- Existing production orders are not backfilled automatically.
-- The marker is used only for future idempotent stock consumption.

CREATE INDEX IF NOT EXISTS idx_orders_inventory_deducted
  ON public.orders (restaurant_id, inventory_deducted_at);

COMMIT;
