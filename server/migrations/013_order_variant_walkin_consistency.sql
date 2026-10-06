BEGIN;

-- Keep the canonical schema aligned with the order code.
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS variant_id integer;

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
