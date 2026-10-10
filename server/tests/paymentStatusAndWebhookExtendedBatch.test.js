'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../config/db');
const paymentService = require('../services/paymentService');
const { validateSuccessfulWebhook } = require('../services/paymentWebhookValidation');

const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2000-01-01T00:00:00.000Z');

async function withPoolQuery(mock, callback) {
  const originalQuery = pool.query;
  pool.query = mock;
  try {
    await callback();
  } finally {
    pool.query = originalQuery;
  }
}

function statusRow(i, status, expiresAt) {
  return {
    status,
    paid_at: null,
    paid_amount: null,
    payment_method: null,
    provider_ref: 'runtime-ref-' + i,
    expires_at: expiresAt,
  };
}

function assertScoped(sql, params, qrId, restaurantId) {
  assert.match(sql, /qr_id\s*=\s*\$1/i);
  assert.match(sql, /restaurant_id\s*=\s*\$2/i);
  assert.deepEqual(params, [qrId, restaurantId]);
}

// 2,500 real service calls: the service attempts a guarded expiry UPDATE,
// but the database condition must leave a future-expiring QR pending. When the
// UPDATE returns no rows, the service re-reads the tenant-scoped current state.
for (let i = 1; i <= 2500; i++) {
  test('getQrStatus preserves non-expired pending QR after guarded expiry check case ' + i, async () => {
    const qrId = 'pending-future-' + i;
    const restaurantId = 1 + (i % 997);
    const row = statusRow(i, 'pending', FUTURE);
    let calls = 0;

    await withPoolQuery(async (sql, params) => {
      calls++;
      if (calls === 1) {
        assertScoped(sql, params, qrId, restaurantId);
        assert.match(sql, /^SELECT/i);
        return { rows: [row] };
      }
      if (calls === 2) {
        assert.match(sql, /^UPDATE\\s+qr_payments/i);
        assert.match(sql, /status\\s*=\\s*'pending'/i);
        assert.match(sql, /expires_at\\s*<=\\s*NOW\\(\\)/i);
        assert.deepEqual(params, [qrId, restaurantId]);
        return { rows: [] };
      }
      assert.equal(calls, 3);
      assertScoped(sql, params, qrId, restaurantId);
      assert.match(sql, /^SELECT/i);
      return { rows: [row] };
    }, async () => {
      assert.deepEqual(await paymentService.getQrStatus(qrId, restaurantId), {
        status: 'pending',
        paid_at: null,
        paid_amount: null,
        payment_method: null,
        provider_ref: row.provider_ref,
        expires_at: FUTURE,
      });
    });

    assert.equal(calls, 3);
  });
}

// 2,500 real service calls: if a QR disappears between the first SELECT and
// the guarded expiry UPDATE, the service's final tenant-scoped reread must
// safely return not_found rather than stale pending information.
for (let i = 1; i <= 2500; i++) {
  test('getQrStatus handles QR removed during expiry race case ' + i, async () => {
    const qrId = 'removed-during-expiry-' + i;
    const restaurantId = 1 + (i % 991);
    const pending = statusRow(i, 'pending', PAST);
    let calls = 0;

    await withPoolQuery(async (sql, params) => {
      calls++;
      if (calls === 1) {
        assertScoped(sql, params, qrId, restaurantId);
        return { rows: [pending] };
      }
      if (calls === 2) {
        assert.match(sql, /^UPDATE\s+qr_payments/i);
        assert.match(sql, /status\s*=\s*'pending'/i);
        assert.match(sql, /expires_at\s*<=\s*NOW\(\)/i);
        assert.deepEqual(params, [qrId, restaurantId]);
        return { rows: [] };
      }
      assert.equal(calls, 3);
      assertScoped(sql, params, qrId, restaurantId);
      return { rows: [] };
    }, async () => {
      assert.deepEqual(await paymentService.getQrStatus(qrId, restaurantId), {
        status: 'not_found',
      });
    });

    assert.equal(calls, 3);
  });
}

// 2,500 validator calls: numeric strings and numeric provider transaction IDs
// are normalized into stable application-level types.
for (let i = 1; i <= 2500; i++) {
  test('webhook validator normalizes valid amount and numeric transaction ID case ' + i, () => {
    const amount = (0.01 + i * 0.17).toFixed(2);
    const transactionId = i * 7919;
    assert.deepEqual(
      validateSuccessfulWebhook({ amount, transactionId }),
      { amount: Number(amount), transactionId: String(transactionId) }
    );
  });
}

// 1,250 validator calls: non-positive and non-finite amount variants fail closed.
for (let i = 1; i <= 1250; i++) {
  test('webhook validator rejects non-positive or non-finite amount case ' + i, () => {
    const amount = [
      0,
      -i,
      '-0.00',
      'Infinity',
      '-Infinity',
      'NaN',
      '',
      '   ',
      '1e' + (1000 + (i % 20)),
      'invalid-' + i,
    ][i % 10];

    assert.throws(
      () => validateSuccessfulWebhook({
        amount,
        transactionId: 'valid-reference-' + i,
      }),
      /amount/
    );
  });
}

// 1,250 validator calls: blank, non-finite numeric, or unsupported transaction
// reference values are rejected even when the amount is valid.
for (let i = 1; i <= 1250; i++) {
  test('webhook validator rejects invalid transaction reference case ' + i, () => {
    const transactionId = [
      '',
      '   ',
      '\t',
      '\n',
      null,
      undefined,
      true,
      false,
      {},
      [],
      NaN,
      Infinity,
      -Infinity,
      '   ' + ' '.repeat(i % 7) + '   ',
      [i],
    ][i % 15];

    assert.throws(
      () => validateSuccessfulWebhook({
        amount: (i + 0.75).toFixed(2),
        transactionId,
      }),
      /transaction_id/
    );
  });
}
