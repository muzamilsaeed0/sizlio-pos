'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.PAYMENT_PROVIDER = 'manual';

const pool = require('../config/db');
const paymentService = require('../services/paymentService');

const FUTURE = new Date('2099-01-01T00:00:00.000Z');

function makeClient(handler) {
  const statements = [];
  let released = false;
  return {
    statements,
    get released() { return released; },
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return { rows: [] };
      return handler(normalized, params, statements.length);
    },
    release() { released = true; },
  };
}

async function withClient(client, callback) {
  const originalConnect = pool.connect;
  pool.connect = async () => client;
  try {
    return await callback();
  } finally {
    pool.connect = originalConnect;
  }
}

function orderRow(i, overrides = {}) {
  return {
    id: 100000 + i,
    total_amount: '125.50',
    paid_amount: '25.50',
    payment_status: 'unpaid',
    status: 'served',
    ...overrides,
  };
}

function assertTransactionClosed(client, expectedEnd) {
  assert.equal(client.statements[0].sql, 'BEGIN');
  assert.equal(client.statements.at(-1).sql, expectedEnd);
  assert.equal(client.released, true);
}

// 300 service-level cases: a QR request for an unknown order must fail closed.
for (let i = 1; i <= 300; i++) {
  test('createQrPayment rejects an order absent from the requested tenant case ' + i, async () => {
    const client = makeClient((sql, params) => {
      assert.match(sql, /FROM orders WHERE id = \$1 AND restaurant_id = \$2 FOR UPDATE/i);
      assert.deepEqual(params, [100000 + i, 10 + (i % 41)]);
      return { rows: [] };
    });

    await withClient(client, async () => {
      await assert.rejects(
        paymentService.createQrPayment({
          restaurantId: 10 + (i % 41),
          orderId: 100000 + i,
          amount: 0.01,
          description: 'test'
        }),
        /Order not found for this restaurant/
      );
    });

    assert.equal(client.statements.filter(s => /INSERT INTO qr_payments/i.test(s.sql)).length, 0);
    assertTransactionClosed(client, 'ROLLBACK');
  });
}

// 300 service-level cases: cancelled orders cannot obtain a new payment QR.
for (let i = 1; i <= 300; i++) {
  test('createQrPayment rejects cancelled order case ' + i, async () => {
    const client = makeClient((sql, params) => {
      assert.match(sql, /FROM orders WHERE id = \$1 AND restaurant_id = \$2 FOR UPDATE/i);
      assert.deepEqual(params, [200000 + i, 20 + (i % 37)]);
      return { rows: [orderRow(i, { status: 'cancelled' })] };
    });

    await withClient(client, async () => {
      await assert.rejects(
        paymentService.createQrPayment({
          restaurantId: 20 + (i % 37),
          orderId: 200000 + i,
          amount: 0.01
        }),
        /Cannot create a payment QR for a cancelled order/
      );
    });

    assert.equal(client.statements.filter(s => /FROM qr_payments/i.test(s.sql)).length, 0);
    assert.equal(client.statements.filter(s => /INSERT INTO qr_payments/i.test(s.sql)).length, 0);
    assertTransactionClosed(client, 'ROLLBACK');
  });
}

// 300 service-level cases: paid orders cannot create another QR.
for (let i = 1; i <= 300; i++) {
  test('createQrPayment rejects already-paid order case ' + i, async () => {
    const client = makeClient((sql, params) => {
      assert.match(sql, /FROM orders WHERE id = \$1 AND restaurant_id = \$2 FOR UPDATE/i);
      assert.deepEqual(params, [300000 + i, 30 + (i % 31)]);
      return { rows: [orderRow(i, { payment_status: 'paid', paid_amount: '125.50' })] };
    });

    await withClient(client, async () => {
      await assert.rejects(
        paymentService.createQrPayment({
          restaurantId: 30 + (i % 31),
          orderId: 300000 + i,
          amount: 0.01
        }),
        /Order is already paid/
      );
    });

    assert.equal(client.statements.filter(s => /FROM qr_payments/i.test(s.sql)).length, 0);
    assert.equal(client.statements.filter(s => /INSERT INTO qr_payments/i.test(s.sql)).length, 0);
    assertTransactionClosed(client, 'ROLLBACK');
  });
}

// 300 service-level cases: fully paid or invalid outstanding balances are rejected.
for (let i = 1; i <= 300; i++) {
  test('createQrPayment rejects zero outstanding amount case ' + i, async () => {
    const total = (50 + i / 100).toFixed(2);
    const client = makeClient((sql, params) => {
      assert.match(sql, /FROM orders WHERE id = \$1 AND restaurant_id = \$2 FOR UPDATE/i);
      assert.deepEqual(params, [400000 + i, 40 + (i % 29)]);
      return {
        rows: [orderRow(i, {
          total_amount: total,
          paid_amount: total,
          payment_status: 'unpaid'
        })]
      };
    });

    await withClient(client, async () => {
      await assert.rejects(
        paymentService.createQrPayment({
          restaurantId: 40 + (i % 29),
          orderId: 400000 + i,
          amount: 999999
        }),
        /No outstanding amount remains for this order/
      );
    });

    assert.equal(client.statements.filter(s => /FROM qr_payments/i.test(s.sql)).length, 0);
    assert.equal(client.statements.filter(s => /INSERT INTO qr_payments/i.test(s.sql)).length, 0);
    assertTransactionClosed(client, 'ROLLBACK');
  });
}

// 300 service-level cases: a matching pending QR is reused and the client-provided
// amount is ignored in favor of the server-calculated outstanding balance.
for (let i = 1; i <= 300; i++) {
  test('createQrPayment reuses matching pending QR using server balance case ' + i, async () => {
    const restaurantId = 50 + (i % 23);
    const orderId = 500000 + i;
    const qrAmount = 100 + (i / 100);
    const expectedAmount = Number(qrAmount.toFixed(2));
    const existing = {
      id: 900000 + i,
      qr_id: 'QR-existing-' + i,
      amount: expectedAmount.toFixed(2),
      qr_string: 'RAAST://existing/' + i,
      qr_image_url: 'https://example.invalid/qr/' + i,
      expires_at: FUTURE,
      status: 'pending'
    };

    const client = makeClient((sql, params) => {
      if (/FROM orders WHERE id = \$1 AND restaurant_id = \$2 FOR UPDATE/i.test(sql)) {
        assert.deepEqual(params, [orderId, restaurantId]);
        return {
          rows: [orderRow(i, {
            total_amount: (expectedAmount + 20).toFixed(2),
            paid_amount: '20.00',
            payment_status: 'unpaid'
          })]
        };
      }
      if (/FROM qr_payments WHERE order_id = \$1 AND restaurant_id = \$2/i.test(sql)) {
        assert.match(sql, /status = 'pending'/i);
        assert.match(sql, /expires_at > NOW\(\)/i);
        assert.deepEqual(params, [orderId, restaurantId]);
        return { rows: [existing] };
      }
      throw new Error('Unexpected SQL in QR reuse test: ' + sql);
    });

    await withClient(client, async () => {
      const result = await paymentService.createQrPayment({
        restaurantId,
        orderId,
        amount: -99999,
        description: 'client supplied description'
      });

      assert.deepEqual(result, {
        qr_id: existing.qr_id,
        order_id: orderId,
        amount: expectedAmount,
        qr_string: existing.qr_string,
        qr_image_url: existing.qr_image_url,
        expires_at: existing.expires_at,
        status: 'pending',
        reused: true
      });
    });

    assert.equal(client.statements.filter(s => /INSERT INTO qr_payments/i.test(s.sql)).length, 0);
    assert.equal(client.statements.filter(s => /^UPDATE qr_payments/i.test(s.sql)).length, 0);
    assertTransactionClosed(client, 'COMMIT');
  });
}
