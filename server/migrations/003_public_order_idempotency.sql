-- Sizlio POS migration: public order idempotency
-- Prevents duplicate customer QR orders caused by double-clicks/retries.
BEGIN;

CREATE TABLE IF NOT EXISTS public.public_order_requests (
  id BIGSERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  order_id INTEGER REFERENCES public.orders(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS public_order_requests_order_idx
  ON public.public_order_requests (restaurant_id, order_id);

CREATE INDEX IF NOT EXISTS public_order_requests_updated_idx
  ON public.public_order_requests (updated_at);

COMMIT;
