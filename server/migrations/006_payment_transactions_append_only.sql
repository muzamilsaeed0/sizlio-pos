BEGIN;

-- Payment transactions are accounting evidence. Application code should
-- append new rows for refunds/adjustments instead of editing history.
CREATE OR REPLACE FUNCTION prevent_payment_transaction_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment_transactions is append-only; use a new transaction row';
END;
$$;

DROP TRIGGER IF EXISTS payment_transactions_no_update ON public.payment_transactions;
CREATE TRIGGER payment_transactions_no_update
BEFORE UPDATE ON public.payment_transactions
FOR EACH ROW
EXECUTE FUNCTION prevent_payment_transaction_mutation();

DROP TRIGGER IF EXISTS payment_transactions_no_delete ON public.payment_transactions;
CREATE TRIGGER payment_transactions_no_delete
BEFORE DELETE ON public.payment_transactions
FOR EACH ROW
EXECUTE FUNCTION prevent_payment_transaction_mutation();

COMMIT;
