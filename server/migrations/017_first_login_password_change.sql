-- Sizlio POS migration 017: require a password change for emailed initial credentials.
BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
