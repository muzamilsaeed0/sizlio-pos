# Sizlio POS — Production Readiness Audit (Static Pass)

**Audit date:** 2026-10-11  
**Repository reviewed:** `muzamilsaeed0/sizlio-pos`, branch `main`  
**Scope:** Express server/bootstrap, authentication/session middleware, login/password policy, tenant-scoped order/inventory models, public QR order flow, POS settings, sales reports, migration runner, package scripts, and super-admin restaurant/user handling.

## Important limitation

This is a source-level review of the files listed below. The full automated suite, production database, live deployment, browser flows, provider sandbox, backup restore, and load/concurrency tests have **not** been run as part of this audit pass. A passing unit suite alone does not establish production readiness. Do not label the product fully production-ready until the release gates at the end are verified.

## Findings and priority

### P1 — Weak password policy is enforced across account workflows

**Evidence**
- `server/controllers/authController.js`: account settings password change accepts 4–8 characters.
- `server/controllers/restaurantController.js`: manager/staff create/reset validation accepts 4–8 characters.
- `server/controllers/userController.js` and `server/models/userModel.js`: staff create/reset/update paths accept 4–8 characters.
- `server/models/restaurantModel.js`: initial manager/staff account creation also caps passwords at 8 characters.

**Risk:** Short passwords materially weaken accounts, especially shared counter/rider devices. Password policy is duplicated across layers, so changing only one validation will produce inconsistent behavior.

**Fix order:** centralize policy; allow a practical minimum of at least 10–12 characters and a bcrypt-safe maximum of 72 UTF-8 bytes; update all create/reset/change paths and UI constraints together; preserve forced password change for generated credentials; provide a migration path for existing accounts. Do not silently change existing credentials.

### P1 — Screen URLs are served without server-side plan/role page gating

**Evidence:** `server/server.js` serves `/counter`, `/waiter`, `/kitchen`, `/rider`, `/manager`, `/sales`, `/inventory`, `/admin`, and `/counter-lite` directly through page handlers/static assets. The page routes themselves do not perform a plan/role check.

**Risk:** Users can open screens outside their plan/role. API middleware remains the real security boundary, so this does not by itself prove protected data can be read, but it fails the intended Counter Lite screen restriction and is not sufficient UI enforcement.

**Fix order:** add a centralized page-access policy that keeps login/public pages usable, resolves the authenticated DB session, checks restaurant plan and role, and redirects/returns a safe denial for disallowed staff screens. Independently verify every corresponding API route; hiding navigation alone is not authorization. For Cafe Lite, the permitted operational screens must match the agreed Counter Lite + Rider plan.

### P1 — QR GPS is a deterrent, not proof of physical presence

**Evidence:** `server/controllers/publicController.js` validates client-submitted latitude/longitude against restaurant coordinates and radius before public table ordering.

**Risk:** Browser GPS coordinates are client-controlled and can be spoofed. Server-side distance checks stop accidental reuse outside the venue but cannot cryptographically prove physical presence. Table QR HMAC and idempotency are useful controls, but do not prevent deliberate coordinate spoofing.

**Fix order:** keep server-side radius checks and table-token validation; document GPS as best-effort; consider short-lived signed location challenges, Wi-Fi/local-network signals where appropriate, per-table order throttles, and abuse monitoring. Do not promise spoof-proof geofencing.

### P1 — Passwords remain limited to 4–8 characters despite bcrypt hashing

**Evidence:** same paths as the weak password policy finding.

**Risk:** Hashing protects stored passwords, but it does not compensate for weak password entropy. The policy must be fixed consistently rather than changing one controller in isolation.

**Fix order:** one shared validator + consistent UI/API enforcement, with regression tests for every create/reset/change endpoint.

### P2 — POS settings endpoint treats omitted numeric fields as zero

**Evidence:** `server/controllers/settingsController.js`, `savePosSettings`: helper `num(field)` returns `0` when a field is omitted, and the endpoint writes the resulting full settings object.

**Risk:** A partial client update or a future client that omits a newly added setting can unintentionally reset existing charges/tax values.

**Fix order:** either explicitly require the complete settings schema and reject missing required fields, or load current settings and merge validated supplied fields. Add tests for omitted, null, blank, negative, over-limit, and valid values before changing the API contract.

### P2 — Production database TLS disables certificate verification

**Evidence:** `server/config/db.js` sets `ssl: { rejectUnauthorized: false }` in production.

**Risk:** TLS encryption is used but server certificate verification is disabled, weakening protection against an active interception attack.

**Fix order:** confirm the production database provider's CA requirements, configure trusted CA verification where supported, and test connection from the actual host before enabling strict verification. Do not deploy a TLS change without checking provider compatibility.

### P2 — Login audit IP trusts forwarding headers directly

**Evidence:** `server/controllers/authController.js` takes `x-forwarded-for` / `x-real-ip` directly for login tracking.

**Risk:** If the app is reachable through paths that do not sanitize proxy headers, the recorded IP can be spoofed. This is primarily audit-log integrity, not authentication bypass.

**Fix order:** use Express's trusted-proxy-aware `req.ip` only after verifying deployment proxy configuration; never use the logged IP as an authorization factor.

### P2 — Public QR idempotency spans multiple database operations

**Evidence:** `server/controllers/publicController.js` reserves a public request, creates the order via the order model, and then marks the request completed in a separate operation.

**Risk:** A process crash between order creation and request completion can leave a processing request without its `order_id`; a later stale-request recovery may retry. Confirm the exact order-creation transaction and add a concurrency/crash-window regression test before claiming duplicate-order protection is complete.

**Fix order:** make the idempotency record and order creation atomic in one database transaction where possible; otherwise implement a durable reconciliation strategy that can associate an existing order with its request hash before retrying.

### P2 — Report date filters are not validated at the controller boundary

**Evidence:** `server/controllers/reportController.js` passes `req.query.from` and `req.query.to` to `server/models/reportModel.js`; the model casts them to dates in SQL when both are supplied.

**Risk:** malformed or reversed ranges can produce database errors or confusing reports. Tenant scoping is present in the inspected report queries, but input validation and consistent range behavior should be explicit.

**Fix order:** validate strict YYYY-MM-DD calendar dates, reject reversed/oversized ranges, define behavior when only one bound is supplied, and test timezone/date-boundary behavior.

## Controls observed in the inspected source

- Authentication checks the JWT session against the current database session and rejects inactive users and inactive/expired restaurants.
- Cookie-authenticated state-changing requests enforce an allowed Origin.
- Login is rate-limited at the server bootstrap.
- Report routes use authentication and manager/counter role authorization.
- Tenant-scoped order lookup methods fail closed when restaurant ID is absent/invalid.
- Inventory transaction code uses a database transaction, row locking, quantity/type validation, and rollback paths.
- Public QR order creation checks a server-generated table token, idempotency key shape, and restaurant GPS radius.
- Restaurant detail handling removes several legacy password/secret fields before returning data.
- Migration runner uses advisory locking, checksums, and transaction-wrapped migrations in the inspected code.

These are positive source-level controls, not proof that every caller and runtime path is safe.

## Release-blocking verification checklist

- [ ] Run the complete existing automated suite once after all code patches are finished.
- [ ] Add tests for every fix in this report before the final suite run.
- [ ] Verify every API route for authentication, role, tenant scope, plan entitlement, and ownership.
- [ ] Verify Cafe Lite/Counter Lite allowed screens by direct URL and direct API requests.
- [ ] Verify password hashes are never returned in any API response; audit legacy plaintext credential columns and remove them in a dedicated, backed-up migration.
- [ ] Exercise duplicate webhook delivery, invalid signatures, payment amount mismatch, simultaneous payment callbacks, and payment/order reconciliation against a disposable database.
- [ ] Exercise order create/edit/cancel/serve/pay paths with inventory deduction and rollback under concurrent requests.
- [ ] Test migration from a copy of a real production schema, migration failure rollback, and checksum mismatch behavior.
- [ ] Perform a real backup restore drill; confirm data, uploaded assets, secrets, and restore time.
- [ ] Verify environment secrets, CORS, trusted proxy settings, TLS, health/readiness checks, graceful shutdown, logs/alerts, and rate limits on the deployed host.
- [ ] Browser-test desktop/tablet/mobile workflows for manager, Counter Lite, rider, kitchen, QR customer ordering, sales reports, and FBR/payment integrations.
- [ ] Run load/concurrency tests with realistic traffic and database connection limits.
- [ ] Review licensing, privacy policy, terms, support process, and customer data-retention expectations before commercial launch.

## Remediation log (main branch)

The following source changes have since been committed. These are **not yet test-verified**; the requested full suite run is intentionally deferred until the audit patches are complete.

- **Password policy:** user-set passwords now require at least 8 characters and are capped at 72 UTF-8 bytes across login-password change, initial password change, manager/staff create/reset, and the related Super Admin / Counter Lite forms. Auto-generated temporary credentials still use the existing forced-change flow. Review any remaining account/password screens during final UI pass.
- **POS settings partial-update safety:** omitted fields now inherit the stored settings instead of silently becoming zero; malformed supplied numeric values are rejected.
- **Operational health checks:** added `GET /health/live` and `GET /health/ready`; readiness verifies database connectivity and returns only a minimal status.
- **Database pool resilience:** added a PostgreSQL pool error listener so unexpected idle-client errors are logged rather than becoming unhandled EventEmitter errors.
- **Sales report input validation:** sales-detail, top-item, payment-summary, and sales-chart endpoints now reject invalid calendar dates, missing paired bounds, and reversed ranges before issuing report queries.
- **Audit artifact:** this document records the remaining findings and release gates.

Relevant files:
- `server/controllers/authController.js`
- `server/controllers/restaurantController.js`
- `server/controllers/userController.js`
- `server/models/restaurantModel.js`
- `server/models/userModel.js`
- `server/public/change-password.html`
- `server/public/counter-lite.html`
- `server/public/superadmin.html`
- `server/controllers/settingsController.js`
- `server/server.js`

## Current verdict

**Not yet certified production-ready from this static pass.** The highest-priority engineering work is the consistent password policy, server-side page/plan access behavior, QR idempotency crash window, settings update semantics, and database TLS verification. Complete the fixes, then run the full suite once as requested and separately perform the deployment/database acceptance checks.
