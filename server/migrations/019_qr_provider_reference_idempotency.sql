BEGIN;

-- A provider transaction reference must not settle two different QR payments.
-- NULL references (manual staff confirmation) remain permitted.
-- Fail closed if historical QR ledger rows already reuse a provider reference.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.payment_transactions
    WHERE qr_payment_id IS NOT NULL
      AND provider_ref IS NOT NULL
      AND btrim(provider_ref) <> ''
    GROUP BY provider_ref
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce QR provider-reference idempotency: duplicate payment_transactions.provider_ref values exist';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_qr_provider_ref_uidx
  ON public.payment_transactions(provider_ref)
  WHERE qr_payment_id IS NOT NULL
    AND provider_ref IS NOT NULL
    AND btrim(provider_ref) <> '';

COMMIT;
