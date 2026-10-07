# Sizlio POS database migrations

## Production rule

The application server does **not** run migrations automatically on startup.

Run migrations as an explicit deployment step:

```bash
npm run migrate
```

The runner stores applied migrations in `public.schema_migrations`, records a SHA-256 checksum for every applied file, and uses a PostgreSQL advisory lock so two deploys cannot migrate the same database concurrently.

## Commands

From the repository root:

```bash
npm run migrate
npm run migrate:status
```

From `server/`:

```bash
npm run migrate
npm run migrate:status
```

### Applying pending migrations

`migrate` runs pending migrations in numeric order. Every current migration is required to be wrapped in a single `BEGIN; ... COMMIT;` transaction. A migration is recorded only after its SQL completes successfully.

If an already-applied migration file is changed, the runner stops because its checksum no longer matches. Never edit an applied migration; create a new numbered migration instead.

### Existing production databases

If a production database was upgraded manually before this migration runner was introduced, **do not run `migrate:baseline` unless you have verified that the database already contains the schema represented by every migration being baselined.**

Example:

```bash
npm run migrate:status
npm run migrate:baseline -- 016
```

Baseline mode does not execute SQL. It only records migrations through the selected version as already applied.

For an older database that is missing one or more migrations, use:

```bash
npm run migrate
```

Do not baseline a partially upgraded database.

## Fresh installations

Use `server/restaurant_pos_schema.sql` to create the canonical fresh database first. Then run:

```bash
npm run migrate
```

This keeps the migration history table under the same production control path and verifies that the current migration chain can be applied cleanly to the canonical schema.

## Deployment order

1. Backup the production PostgreSQL database.
2. Deploy the new application code.
3. Run `npm run migrate` as a one-time release/deploy step.
4. Confirm `npm run migrate:status` shows no pending migrations.
5. Start/restart the application.

Do not put `npm run migrate` inside the normal server start command when multiple application instances may start at once. The advisory lock protects concurrent migration commands, but migrations should still be a deliberate deployment step.
