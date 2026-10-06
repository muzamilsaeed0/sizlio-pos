BEGIN;

-- Align the live database constraint with the statuses used by
-- order creation, kitchen workflow, delivery and cancellation.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (
    status::text = ANY (
      ARRAY[
        'pending',
        'placed',
        'accepted',
        'preparing',
        'confirmed',
        'ready',
        'served',
        'payment_pending',
        'ready_to_dispatch',
        'ready_to_deliver',
        'out_for_delivery',
        'delivered',
        'completed',
        'cancelled'
      ]::text[]
    )
  );

COMMIT;
