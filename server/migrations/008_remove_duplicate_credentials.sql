BEGIN;

-- Credentials must live only in users.password (bcrypt hash).
-- Remove legacy plaintext password storage from users.
ALTER TABLE public.users
  DROP COLUMN IF EXISTS plain_password;

-- Restaurant credentials were a duplicate source of truth and stored
-- plaintext values. Manager/staff accounts are represented by users rows.
ALTER TABLE public.restaurants
  DROP COLUMN IF EXISTS manager_username,
  DROP COLUMN IF EXISTS manager_password,
  DROP COLUMN IF EXISTS waiter_username,
  DROP COLUMN IF EXISTS waiter_password,
  DROP COLUMN IF EXISTS kitchen_username,
  DROP COLUMN IF EXISTS kitchen_password;

COMMIT;
