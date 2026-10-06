-- Sizlio POS migration: historical order-item pricing
-- Run once against the existing Railway PostgreSQL database.
-- Safe to re-run before the NOT NULL step.

BEGIN;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2);

UPDATE public.order_items oi
SET
  unit_price = miv.price,
  line_total = miv.price * oi.quantity
FROM public.menu_item_variants miv
WHERE oi.variant_id = miv.id
  AND oi.menu_item_id = miv.menu_item_id
  AND (oi.unit_price IS NULL OR oi.line_total IS NULL);

UPDATE public.order_items oi
SET
  unit_price = m.price,
  line_total = m.price * oi.quantity
FROM public.menu_items m
WHERE oi.menu_item_id = m.id
  AND oi.variant_id IS NULL
  AND (oi.unit_price IS NULL OR oi.line_total IS NULL);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.order_items
    WHERE unit_price IS NULL OR line_total IS NULL
  ) THEN
    RAISE EXCEPTION 'Historical pricing migration failed: NULL order item prices remain';
  END IF;
END $$;

ALTER TABLE public.order_items
  ALTER COLUMN unit_price SET NOT NULL,
  ALTER COLUMN line_total SET NOT NULL;

-- Historical pricing snapshot for deal-level prices.
-- Existing order_deals rows keep the deal price charged at order time,
-- even if the current deals.price changes later.
ALTER TABLE public.order_deals
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2);

UPDATE public.order_deals od
SET
  unit_price = d.price,
  line_total = d.price * od.quantity
FROM public.deals d
WHERE od.deal_id = d.id
  AND (od.unit_price IS NULL OR od.line_total IS NULL);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.order_deals
    WHERE unit_price IS NULL OR line_total IS NULL
  ) THEN
    RAISE EXCEPTION 'Historical deal pricing migration failed: NULL order deal prices remain';
  END IF;
END $$;

ALTER TABLE public.order_deals
  ALTER COLUMN unit_price SET NOT NULL,
  ALTER COLUMN line_total SET NOT NULL;

COMMIT;
