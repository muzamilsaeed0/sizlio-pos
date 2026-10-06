-- Fixes Counter Lite / POS: column "change_amount" of relation "orders" does not exist

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS change_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMIT;
