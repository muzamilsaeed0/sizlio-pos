-- Sizlio POS migration: normalize user roles
-- P0-02: keep database roles aligned with the application.
--
-- Canonical roles:
--   manager, waiter, kitchen, counter, delivery, display, super_admin
--
-- Legacy aliases are normalized before the constraint is recreated:
--   rider / delivery_rider -> delivery

BEGIN;

-- Normalize legacy delivery-role values first.
UPDATE public.users
SET role = 'delivery'
WHERE role IN ('rider', 'delivery_rider');

-- Rebuild the role constraint so existing and fresh databases
-- accept exactly the roles used by the application.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (
    role IN (
      'manager',
      'waiter',
      'kitchen',
      'counter',
      'delivery',
      'display',
      'super_admin'
    )
  );

COMMIT;
