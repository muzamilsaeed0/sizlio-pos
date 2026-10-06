-- Sizlio POS migration: P0-02 canonical schema consistency
-- Adds columns used by the authentication/session layer and
-- restaurant metadata used by the application.
--
-- Safe for existing installations: all additions are IF NOT EXISTS.

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS current_session text,
  ADD COLUMN IF NOT EXISTS last_login_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_login_ip text,
  ADD COLUMN IF NOT EXISTS last_login_device text;

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS food_type character varying(100)
    DEFAULT 'Fast Food'::character varying,
  ADD COLUMN IF NOT EXISTS business_type character varying(30)
    DEFAULT 'restaurant'::character varying;

-- Canonical application role is delivery.
-- Normalize any legacy aliases before enforcing the role constraint.
UPDATE public.users
SET role = 'delivery'
WHERE role IN ('rider', 'delivery_rider');

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
