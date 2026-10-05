-- Sizlio POS migration: immutable payment ledger
-- Records every successful payment settlement independently from mutable order fields.
BEGIN;

CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id BIGSERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  qr_payment_id BIGINT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_method VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'refunded', 'failed')),
  provider_ref VARCHAR(255),
  reference VARCHAR(255),
  actor_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_transactions_restaurant_idx
  ON public.payment_transactions (restaurant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_transactions_order_idx
  ON public.payment_transactions (restaurant_id, order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_transactions_qr_idx
  ON public.payment_transactions (qr_payment_id)
  WHERE qr_payment_id IS NOT NULL;

COMMIT;
