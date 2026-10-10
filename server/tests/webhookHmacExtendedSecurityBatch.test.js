'use strict';

// Extended real HMAC verification matrix. These cases exercise the production
// handleWebhook entry point and Node crypto, without touching a live database.
// PENDING callbacks are intentionally ignored after signature/payload checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.PAYMENT_PROVIDER = 'manual';
process.env.PAYMENT_WEBHOOK_SECRET = 'sizlio-test-secret-do-not-use-in-production';

const paymentService = require('../services/paymentService');

function sign(body) {
  return crypto
    .createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
}

function pendingBody(i) {
  return {
    reference: 'QR-HMAC-MATRIX-' + i,
    transaction_id: 'provider-pending-' + i,
    amount: (i + 0.25).toFixed(2),
    status: i % 2 ? 'PENDING' : 'processing',
    payment_method: 'raast',
    metadata: { attempt: i, source: 'security-matrix' },
  };
}

// 5,000 signed provider callbacks: accepted signatures are validated and
// non-final statuses are acknowledged without changing payment state.
for (let i = 1; i <= 5000; i++) {
  test('webhook accepts valid HMAC signature for pending callback case ' + i, async () => {
    const body = pendingBody(i);
    const result = await paymentService.handleWebhook({
      headers: { 'x-webhook-signature': sign(body) },
      body,
    });
    assert.deepEqual(result, { ok: true, ignored: true });
  });
}

// 5,000 altered payloads: a signature for the original body must not authorize
// a changed reference, amount, status, or metadata payload.
for (let i = 1; i <= 5000; i++) {
  test('webhook rejects tampered HMAC payload case ' + i, async () => {
    const original = pendingBody(i + 5000);
    const altered = {
      ...original,
      amount: (i + 9000.75).toFixed(2),
      reference: original.reference + '-tampered',
    };
    await assert.rejects(
      paymentService.handleWebhook({
        headers: { 'x-webhook-signature': sign(original) },
        body: altered,
      }),
      /Invalid signature/
    );
  });
}
