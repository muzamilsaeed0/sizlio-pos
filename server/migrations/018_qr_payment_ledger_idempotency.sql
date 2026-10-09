BEGIN;

-- A QR payment may produce at most one ledger transaction. The partial
-- unique index allows non-QR/manual ledger rows whose qr_payment_id is NULL.
-- Fail loudly rather than silently deleting or rewriting historical accounting
-- records if the production database already contains duplicates.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.payment_transactions
    WHERE qr_payment_id IS NOT NULL
    GROUP BY qr_payment_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce QR ledger idempotency: duplicate payment_transactions.qr_payment_id values exist';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_qr_payment_uidx
  ON public.payment_transactions(qr_payment_id)
  WHERE qr_payment_id IS NOT NULL;

COMMIT;
