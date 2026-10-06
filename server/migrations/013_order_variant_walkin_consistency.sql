BEGIN;

-- Keep the canonical schema aligned with the order code.
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS variant_id integer;

DO $
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_variant_id_fkey'
  ) THEN
    ALTER TABLE public.order_items
      ADD CONSTRAINT order_items_variant_id_fkey
      FOREIGN KEY (variant_id) REFERENCES public.menu_item_variants(id)
      ON DELETE SET NULL;
  END IF;
END $;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_type_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_type_check
  CHECK (
    order_type::text = ANY (
      ARRAY[
        'dine_in',
        'delivery',
        'walk_in'
      ]::text[]
    )
  );

COMMIT;
