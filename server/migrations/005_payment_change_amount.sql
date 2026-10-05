BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS change_amount NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK (change_amount >= 0);

COMMIT;
