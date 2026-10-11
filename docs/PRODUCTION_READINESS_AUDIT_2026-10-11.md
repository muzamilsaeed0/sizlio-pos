# Sizlio POS — Production Readiness Audit (Static Pass)

**Audit date:** 2026-10-11  
**Repository reviewed:** `muzamilsaeed0/sizlio-pos`, branch `main`  
**Scope:** Express server/bootstrap, authentication/session middleware, login/password policy, tenant-scoped order/inventory models, public QR order flow, POS settings, sales reports, migration runner, package scripts, and super-admin restaurant/user handling.

## Important limitation

This is a source-level review of the files listed below. The full automated suite, production database, live deployment, browser flows, provider sandbox, backup restore, and load/concurrency tests have **not** been run as part of this audit pass. A passing unit suite alone does not establish production readiness. Do not label the product fully production-ready until the release gates at the end are verified.

## Findings and priority

### P1 — Password policy is a deliberate product constraint (4–8 characters)

**Decision:** Per product-owner instruction, retain the existing minimum of 4 and maximum of 8 characters. All account create, reset, and change paths must enforce this same range; do not silently raise the minimum or change existing credentials. This is a known security trade-off for shared counter/rider workflows and should be clearly documented for customers.

### P1 — Screen URLs were served without server-side plan/role page gating (patched in this pass)

**Evidence:** `server/server.js` serves `/counter`, `/waiter`, `/kitchen`, `/rider`, `/manager`, `/sales`, `/inventory`, `/admin`, and `/counter-lite` directly through page handlers/static assets. The page routes themselves do not perform a plan/role check.

**Risk:** Users can open screens outside their plan/role. API middleware remains the real security boundary, so this does not by itself prove protected data can be read, but it fails the intended Counter Lite screen restriction and is not sufficient UI enforcement.

**Patch committed:** `server/server.js` now applies a centralized `protectedPage` gate to operational routes, validates the cookie-backed session through `authMiddleware`, checks current role and restaurant plan/business type from the database, restricts `/counter-lite` to Cafe Lite counter accounts, and blocks Cafe Lite access to regular operational pages other than Rider. API routes still require independent authorization; this page gate is not a substitute for API security. This source patch remains unverified until the final suite and browser flow run.

### P1 — QR GPS is a deterrent, not proof of physical presence

**Evidence:** `server/controllers/publicController.js` validates client-submitted latitude/longitude against restaurant coordinates and radius before public table ordering.

**Risk:** Browser GPS coordinates are client-controlled and can be spoofed. Server-side distance checks stop accidental reuse outside the venue but cannot cryptographically prove physical presence. Table QR HMAC and idempotency are useful controls, but do not prevent deliberate coordinate spoofing.

**Fix order:** keep server-side radius checks and table-token validation; document GPS as best-effort; consider short-lived signed location challenges, Wi-Fi/local-network signals where appropriate, per-table order throttles, and abuse monitoring. Do not promise spoof-proof geofencing.

### P1 — Passwords remain limited to 4–8 characters by explicit product decision

**Risk:** Short passwords have lower entropy even when bcrypt-hashed. Keep this constraint consistent across API and UI, protect accounts with rate limits/session controls, and revisit only if the product owner changes the requirement.

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

### P2 — Public QR and offline-order idempotency are not fully atomic (stale replay mitigation patched)

**Evidence:** `server/controllers/publicController.js` reserves a public request, creates the order via the order model, and then marks the request completed in a separate operation.

**Risk:** A process crash between order creation and request completion can leave a processing request without its `order_id`; a later stale-request recovery may retry. Confirm the exact order-creation transaction and add a concurrency/crash-window regression test before claiming duplicate-order protection is complete.

**Patch committed:** stale processing reservations are no longer automatically taken over and replayed for either public QR orders or offline syncs. Public-order and offline-order error cleanup release reservations only when failure occurs before any order mutation; once mutation starts, the reservation is preserved. This fails closed and reduces duplicate-item/order risk after a crash. **Remaining limitation:** the reservation and order mutation are still separate transactions, so a stale request requires staff reconciliation; atomic creation/linking or a supported reconciliation workflow remains a release requirement.

### P2 — Report date filters are not validated at the controller boundary

**Evidence:** `server/controllers/reportController.js` passes `req.query.from` and `req.query.to` to `server/models/reportModel.js`; the model casts them to dates in SQL when both are supplied.

**Risk:** malformed or reversed ranges can produce database errors or confusing reports. Tenant scoping is present in the inspected report queries, but input validation and consistent range behavior should be explicit.

**Fix order:** validate strict YYYY-MM-DD calendar dates, reject reversed/oversized ranges, define behavior when only one bound is supplied, and test timezone/date-boundary behavior.

### P1 — Automated payment-provider integration is not implemented in the current adapter

**Evidence:** `server/services/paymentService.js` supports the `manual` provider path. `createQrWithProvider()` throws for other provider values, and `verifyWebhookSignature()` currently returns false outside the manual HMAC configuration.

**Market impact:** Sizlio can be described as supporting manual QR generation/confirmation only if that is the intended workflow. Do not advertise automated Raast/PayFast settlement as production-integrated until the actual provider API, signatures, callback retries, idempotency, reconciliation, and sandbox certification are implemented and tested.

**Release gate:** Confirm the commercial payment promise. If automated settlement is part of the paid product, this is a blocker and needs provider credentials/API documentation plus sandbox tests; it cannot be safely completed by guessing a bank API contract.

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

- **Password policy:** product-owner requirement is minimum 4, maximum 8 characters; validation and UI limits are aligned to this range. This is a deliberate security trade-off, not a production security recommendation.
- **POS settings partial-update safety:** omitted fields now inherit the stored settings instead of silently becoming zero; malformed supplied numeric values are rejected.
- **Operational health checks:** added `GET /health/live` and `GET /health/ready`; readiness verifies database connectivity and returns only a minimal status.
- **Database pool resilience:** added a PostgreSQL pool error listener so unexpected idle-client errors are logged rather than becoming unhandled EventEmitter errors.
- **Sales report input validation:** sales-detail, top-item, payment-summary, and sales-chart endpoints reject invalid calendar dates, missing paired bounds, and reversed ranges before issuing report queries. A malformed escaped-digit regex was corrected so valid `YYYY-MM-DD` dates can pass validation. The previous manager Sales `Server error` still needs confirmation against the deployed database logs and the final test run.
- **Operational page authorization:** protected staff pages now check the active cookie session, database role, and current restaurant plan/business type. Cafe Lite is limited to Counter Lite and Rider operational pages, and `authController` plus `authMiddleware` now reject unsupported legacy roles at login and API-session validation. This source patch has not yet been run through the final test suite or browser QA.
- **Order idempotency crash handling:** public QR and offline order handlers no longer automatically take over stale processing reservations. Once public-order mutation begins, error cleanup preserves the reservation rather than deleting evidence of an uncertain outcome. Stale requests now return an explicit reconciliation-required response instead of automatically replaying a potentially completed mutation.
- **Login audit IP:** login tracking now uses Express `req.ip` (configured with trusted-proxy policy) rather than raw client-supplied forwarding headers.
- **Password regression alignment:** existing source/UI checks and the regression test cases now follow the requested 4–8 character password rule.
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

**Not yet certified production-ready from this static pass.** The source-level page-gating, password-rule consistency, POS-settings partial-update safety, and report-date validation patches are committed but await the one final full-suite run. Remaining high-risk release gates include completing a transactional or operator-supported reconciliation path for stale public/offline idempotency records, database TLS certificate verification after confirming provider CA requirements, real database migration/restore drills, duplicate/concurrent payment settlement against a disposable database, browser/load testing, and implementing/certifying any automated payment-provider integration that is promised to customers. Do not claim production-ready until these are verified.
