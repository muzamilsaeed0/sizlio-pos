'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../config/db');
const paymentService = require('../services/paymentService');

const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2000-01-01T00:00:00.000Z');

function statusRow(i, status, expiresAt = FUTURE) {
  return {
    status,
    paid_at: status === 'paid' ? new Date('2026-01-01T00:00:00.000Z') : null,
    paid_amount: status === 'paid' ? (10 + i / 100).toFixed(2) : null,
    payment_method: status === 'paid' ? 'manual_confirm' : null,
    provider_ref: status === 'paid' ? 'provider-' + i : null,
    expires_at: expiresAt,
  };
}

async function withPoolQuery(mock, callback) {
  const originalQuery = pool.query;
  pool.query = mock;
  try {
    await callback();
  } finally {
    pool.query = originalQuery;
  }
}

function assertTenantScoped(sql, params, qrId, restaurantId) {
  assert.match(sql, /qr_id\s*=\s*\$1/i);
  assert.match(sql, /restaurant_id\s*=\s*\$2/i);
  assert.deepEqual(params, [qrId, restaurantId]);
}

// 1,000 real service calls: a missing QR is reported as not_found and does not
// trigger expiry/update work. IDs and tenant IDs vary to catch parameter mixups.
for (let i = 1; i <= 1000; i++) {
  test('getQrStatus returns not_found for unknown tenant-scoped QR case ' + i, async () => {
    const qrId = 'unknown-status-' + i;
    const restaurantId = 1 + (i % 97);
    let calls = 0;

    await withPoolQuery(async (sql, params) => {
      calls++;
      assertTenantScoped(sql, params, qrId, restaurantId);
      return { rows: [] };
    }, async () => {
      assert.deepEqual(
        await paymentService.getQrStatus(qrId, restaurantId),
        { status: 'not_found' }
      );
    });

    assert.equal(calls, 1);
  });
}

// 1,000 real service calls: terminal and non-pending statuses are returned
// without attempting to expire or mutate the QR.
for (let i = 1; i <= 1000; i++) {
  test('getQrStatus returns terminal state without mutation case ' + i, async () => {
    const qrId = 'terminal-status-' + i;
    const restaurantId = 1 + (i % 89);
    const status = ['paid', 'cancelled', 'expired'][i % 3];
    const row = statusRow(i, status, status === 'expired' ? PAST : FUTURE);
    let calls = 0;

    await withPoolQuery(async (sql, params) => {
      calls++;
      assertTenantScoped(sql, params, qrId, restaurantId);
      return { rows: [row] };
    }, async () => {
      assert.deepEqual(await paymentService.getQrStatus(qrId, restaurantId), {
        status: row.status,
        paid_at: row.paid_at,
        paid_amount: row.paid_amount,
        payment_method: row.payment_method,
        provider_ref: row.provider_ref,
        expires_at: row.expires_at,
      });
    });

    assert.equal(calls, 1);
  });
}

// 1,000 real service calls: when the guarded expiry UPDATE succeeds, return
// the database's returned expired row rather than stale pending data.
for (let i = 1; i <= 1000; i++) {
  test('getQrStatus returns guarded expiry result case ' + i, async () => {
    const qrId = 'expiry-status-' + i;
    const restaurantId = 1 + (i % 83);
    const pending = statusRow(i, 'pending', PAST);
    const expired = statusRow(i, 'expired', PAST);
    let calls = 0;

    await withPoolQuery(async (sql, params) => {
      calls++;
      if (calls === 1) {
        assertTenantScoped(sql, params, qrId, restaurantId);
        return { rows: [pending] };
      }

      assert.equal(calls, 2);
      assert.match(sql, /^UPDATE\s+qr_payments/i);
      assert.match(sql, /status\s*=\s*'pending'/i);
      assert.match(sql, /expires_at\s*<=\s*NOW\(\)/i);
      assert.deepEqual(params, [qrId, restaurantId]);
      return { rows: [expired] };
    }, async () => {
      assert.deepEqual(await paymentService.getQrStatus(qrId, restaurantId), {
        status: expired.status,
        paid_at: expired.paid_at,
        paid_amount: expired.paid_amount,
        payment_method: expired.payment_method,
        provider_ref: expired.provider_ref,
        expires_at: expired.expires_at,
      });
    });

    assert.equal(calls, 2);
  });
}

// 1,000 race-condition cases: if a concurrent webhook settles the QR after
// the initial read, the guarded expiry UPDATE returns no rows and getQrStatus
// must re-read and return the latest committed status instead of stale pending.
for (let i = 1; i <= 1000; i++) {
  test('getQrStatus re-reads state after concurrent expiry race case ' + i, async () => {
    const qrId = 'race-status-' + i;
    const restaurantId = 1 + (i % 79);
    const pending = statusRow(i, 'pending', PAST);
    const paid = statusRow(i, 'paid', PAST);
    let calls = 0;

    await withPoolQuery(async (sql, params) => {
      calls++;
      if (calls === 1) {
        assertTenantScoped(sql, params, qrId, restaurantId);
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
      assertTenantScoped(sql, params, qrId, restaurantId);
      return { rows: [paid] };
    }, async () => {
      assert.deepEqual(await paymentService.getQrStatus(qrId, restaurantId), {
        status: paid.status,
        paid_at: paid.paid_at,
        paid_amount: paid.paid_amount,
        payment_method: paid.payment_method,
        provider_ref: paid.provider_ref,
        expires_at: paid.expires_at,
      });
    });

    assert.equal(calls, 3);
  });
}
