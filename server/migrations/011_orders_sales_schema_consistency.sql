BEGIN;

-- Keep the orders schema aligned with the fields used by pricing,
-- payment, order completion and the Sales Dashboard.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS local_number integer,
  ADD COLUMN IF NOT EXISTS delivery_charge numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dine_charge numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS card_charge numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bank_charge numeric(12,2) DEFAULT 0;

UPDATE public.orders
SET
  delivery_charge = COALESCE(delivery_charge, 0),
  dine_charge = COALESCE(dine_charge, 0),
  card_charge = COALESCE(card_charge, 0),
  bank_charge = COALESCE(bank_charge, 0)
WHERE
  delivery_charge IS NULL
  OR dine_charge IS NULL
  OR card_charge IS NULL
  OR bank_charge IS NULL;

ALTER TABLE public.orders
  ALTER COLUMN delivery_charge SET DEFAULT 0,
  ALTER COLUMN dine_charge SET DEFAULT 0,
  ALTER COLUMN card_charge SET DEFAULT 0,
  ALTER COLUMN bank_charge SET DEFAULT 0;

COMMIT;
