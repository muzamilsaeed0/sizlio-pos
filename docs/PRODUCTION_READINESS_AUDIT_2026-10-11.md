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

**Original issue:** extensionless and direct `.html` URLs were served without checking the current session's role and restaurant plan. This allowed authenticated users to open screens outside their intended plan, even when the APIs were separately protected.

**Patch committed:** `server/server.js` now applies a centralized `protectedPage` gate to operational routes, validates the cookie-backed session through `authMiddleware`, checks current role and restaurant plan/business type from the database, restricts `/counter-lite` to Cafe Lite counter accounts, and blocks Cafe Lite access to regular operational pages other than Rider. API routes still require independent authorization; this page gate is not a substitute for API security. This source patch remains unverified until the final suite and browser flow run.

### P1 — QR GPS is a deterrent, not proof of physical presence

**Evidence:** `server/controllers/publicController.js` validates client-submitted latitude/longitude against restaurant coordinates and radius before public table ordering.

**Risk:** Browser GPS coordinates are client-controlled and can be spoofed. Server-side distance checks stop accidental reuse outside the venue but cannot cryptographically prove physical presence. Table QR HMAC and idempotency are useful controls, but do not prevent deliberate coordinate spoofing.

**Fix order:** keep server-side radius checks and table-token validation; document GPS as best-effort; consider short-lived signed location challenges, Wi-Fi/local-network signals where appropriate, per-table order throttles, and abuse monitoring. Do not promise spoof-proof geofencing.

### P2 — POS settings partial-update bug (patched; final tests pending)

**Original issue:** omitted numeric fields could silently reset configured charges/tax values.

**Patch committed:** `savePosSettings` loads existing settings, preserves omitted values, and rejects malformed supplied numeric values. Final regression and live API verification remain pending.

### P2 — Production database TLS disables certificate verification

**Evidence:** `server/config/db.js` verifies certificates by default in production. The first deployment attempt returned `self-signed certificate in certificate chain`, so the current database's certificate chain is not trusted by Node.js.

**Risk:** the strict setting prevents an unverified database connection, but production is unavailable until the host's correct CA is configured. Disabling verification would weaken protection against active interception.

**Patch:** `DATABASE_SSL_CA` now accepts the database provider's PEM CA certificate (literal `\\n` sequences are converted to line breaks) while certificate verification remains enabled. Obtain the correct CA from the database provider and set it as a secret/environment variable. If the provider documents that its private network uses a self-signed chain without a CA option, a temporary `DATABASE_SSL_REJECT_UNAUTHORIZED=false` override can restore service while the provider-specific secure configuration is confirmed; treat that as a temporary risk acceptance, not the final production setting. Verify connectivity from the actual host.

### P2 — Login audit IP trusted raw forwarding headers (patched; proxy config still needs verification)

**Original issue:** client-supplied `x-forwarded-for` / `x-real-ip` values were used directly for login tracking.

**Patch committed:** login tracking now uses Express `req.ip` and the configured `trust proxy` policy, falling back to the socket address. Confirm the actual Railway proxy path is represented correctly in deployment configuration. The logged IP must never be used as an authorization factor.

### P2 — Public QR and offline-order idempotency are not fully atomic (stale replay mitigation patched)

**Evidence:** `server/controllers/publicController.js` reserves a public request, creates the order via the order model, and then marks the request completed in a separate operation.

**Risk:** A process crash between order creation and request completion can leave a processing request without its `order_id`; a later stale-request recovery may retry. Confirm the exact order-creation transaction and add a concurrency/crash-window regression test before claiming duplicate-order protection is complete.

**Patch committed:** stale processing reservations are no longer automatically taken over and replayed for either public QR orders or offline syncs. Public-order and offline-order error cleanup release reservations only when failure occurs before any order mutation; once mutation starts, the reservation is preserved. This fails closed and reduces duplicate-item/order risk after a crash. **Remaining limitation:** the reservation and order mutation are still separate transactions, so a stale request requires staff reconciliation; atomic creation/linking or a supported reconciliation workflow remains a release requirement.

### P2 — Sales report date validation had a malformed digit regex (patched; runtime verification pending)

**Original issue:** a double-escaped digit pattern rejected valid `YYYY-MM-DD` dates.

**Patch committed:** the validator now uses the correct digit regex, validates real calendar dates, requires paired bounds, and rejects reversed ranges. A regression contract was added. The previously reported Sales-page `Server error` still needs confirmation against the deployed logs and the final test run.

### P1 — Payment transaction-reference replay protection (patched; database verification pending)

**Original risk:** settlement checked amount and locked the order/QR, but did not reject a provider transaction ID already recorded against another successful payment. If a provider reused or misrouted a transaction ID, two QR payments could potentially be associated with one external transfer.

**Patch committed in this pass:** successful settlements with a provider reference take a PostgreSQL transaction-scoped advisory lock for that reference and check the completed `payment_transactions` ledger before updating the QR/order. This serializes concurrent callbacks using the same reference and fails closed when it has already been recorded. Already-settled QR callbacks remain idempotent. This is a source patch only; test suite and disposable-database concurrency checks remain pending.

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
- [ ] Exercise duplicate webhook delivery, invalid signatures, payment amount mismatch, reused provider transaction IDs, simultaneous payment callbacks, and payment/order reconciliation against a disposable database.
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
- **Payment settlement reference replay:** successful QR settlement now serializes callbacks sharing a provider transaction ID and rejects a reference already present in the completed payment ledger; disposable-database concurrency verification remains pending.
- **Supplier financial permissions:** Counter/Cafe Lite users can still maintain supplier contacts and use supplier workflows, but cannot create a non-zero opening balance or delete supplier records. The model also rejects negative opening balances so direct model calls cannot store an invalid starting balance. Regression source-contract coverage was added; runtime/API tests remain pending.
- **Supplier date validation:** supplier purchase and payment dates now use a shared strict `YYYY-MM-DD` calendar-date validator. This corrects an over-escaped payment-date regex that could reject valid dates and rejects impossible dates (for example, month 13 or February 30). Regression source-contract coverage was added; final suite and live API validation remain pending.
- **Supplier ledger date-filter validation:** purchase/payment list filters and supplier ledger filters now reject impossible dates and reversed `from`/`to` ranges before database queries. This avoids database cast errors turning malformed filter input into generic server errors. Source-contract regression coverage was added; final suite and live API validation remain pending.
- **Supplier aging FIFO allocation:** the aging report now allocates recorded supplier payments against oldest outstanding purchase balances in purchase-date/ID order before selecting the oldest unpaid invoice date. This prevents already-covered older invoices from incorrectly aging every remaining supplier balance. This is a FIFO reporting assumption, not invoice-level payment allocation; final suite and disposable-database reconciliation are still required.
- **Database TLS:** production PostgreSQL connections verify certificates by default and now support `DATABASE_SSL_CA` for a provider-supplied PEM CA. Deployment currently reports `self-signed certificate in certificate chain`; configure the correct provider CA and verify connectivity. `DATABASE_SSL_REJECT_UNAUTHORIZED=false` is an emergency temporary override only.
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

**Not yet certified production-ready from this static pass.** The source-level page-gating, password-rule consistency, POS-settings partial-update safety, and report-date validation patches are committed but await the one final full-suite run. Remaining high-risk release gates include completing a transactional or operator-supported reconciliation path for stale public/offline idempotency records, database TLS certificate verification (now enabled by default in production; deployment connection still needs verification), real database migration/restore drills, duplicate/concurrent payment settlement against a disposable database, browser/load testing, and implementing/certifying any automated payment-provider integration that is promised to customers. Do not claim production-ready until these are verified.
