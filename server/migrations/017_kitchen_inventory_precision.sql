-- Sizlio POS migration 017: preserve recipe precision in kitchen stock and ledger.
-- Recipe ingredient quantities support three decimal places. Keeping kitchen
-- balances and their movement ledger at two decimals can round a small stock
-- deduction away while still recording a rounded transaction.
BEGIN;

ALTER TABLE public.kitchen_inventory
  ALTER COLUMN quantity TYPE NUMERIC(12,3)
  USING quantity::NUMERIC(12,3);

ALTER TABLE public.kitchen_inventory_transactions
  ALTER COLUMN quantity TYPE NUMERIC(12,3)
  USING quantity::NUMERIC(12,3);

COMMIT;
