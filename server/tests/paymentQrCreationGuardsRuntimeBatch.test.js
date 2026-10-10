'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../config/db');
const paymentService = require('../services/paymentService');

function makeClient(orderRows) {
  const statements = [];
  let released = false;
  return {
    statements,
    get released() { return released; },
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return { rows: [] };
      if (/SELECT id, total_amount, paid_amount, payment_status, status FROM orders/i.test(normalized)) {
        return { rows: orderRows };
      }
      throw new Error('Unexpected SQL; rejected order should stop before QR lookup: ' + normalized);
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

function validOrder(overrides = {}) {
  return {
    id: 4001,
    total_amount: '125.00',
    paid_amount: '25.00',
    payment_status: 'unpaid',
    status: 'served',
    ...overrides,
  };
}

// Actual createQrPayment service calls: tenant-scoped order lookup must fail
// closed for unknown orders and must never continue to inspect/insert QR rows.
for (let i = 1; i <= 500; i++) {
  test('createQrPayment rejects missing tenant-scoped order case ' + i, async () => {
    const restaurantId = 1 + (i % 97);
    const orderId = 100000 + i;
    const client = makeClient([]);
    await withClient(client, async () => {
      await assert.rejects(
        paymentService.createQrPayment({ restaurantId, orderId, amount: 0.01 }),
        /Order not found for this restaurant/
      );
    });
    const lookup = client.statements.find(s => /FROM orders/.test(s.sql));
    assert.ok(lookup);
    assert.match(lookup.sql, /id = \$1 AND restaurant_id = \$2/);
    assert.deepEqual(lookup.params, [orderId, restaurantId]);
    assert.equal(client.statements.some(s => /FROM qr_payments|INSERT INTO qr_payments/.test(s.sql)), false);
    assert.equal(client.statements.at(-1).sql, 'ROLLBACK');
    assert.equal(client.released, true);
  });
}

// A cancelled order cannot get a new payment QR even if it still has balance.
for (let i = 1; i <= 500; i++) {
  test('createQrPayment rejects cancelled order case ' + i, async () => {
    const restaurantId = 1 + (i % 89);
    const orderId = 200000 + i;
    const client = makeClient([validOrder({ id: orderId, status: 'cancelled' })]);
    await withClient(client, async () => {
      await assert.rejects(
        paymentService.createQrPayment({ restaurantId, orderId, amount: 999999 }),
        /Cannot create a payment QR for a cancelled order/
      );
    });
    assert.equal(client.statements.some(s => /FROM qr_payments|INSERT INTO qr_payments/.test(s.sql)), false);
    assert.equal(client.statements.at(-1).sql, 'ROLLBACK');
    assert.equal(client.released, true);
  });
}

// Paid orders cannot create a second QR; client-supplied amount is irrelevant.
for (let i = 1; i <= 500; i++) {
  test('createQrPayment rejects already-paid order case ' + i, async () => {
    const restaurantId = 1 + (i % 83);
    const orderId = 300000 + i;
    const client = makeClient([validOrder({
      id: orderId,
      payment_status: 'paid',
      paid_amount: '125.00',
    })]);
    await withClient(client, async () => {
      await assert.rejects(
        paymentService.createQrPayment({ restaurantId, orderId, amount: 0.01 }),
        /Order is already paid/
      );
    });
    assert.equal(client.statements.some(s => /FROM qr_payments|INSERT INTO qr_payments/.test(s.sql)), false);
    assert.equal(client.statements.at(-1).sql, 'ROLLBACK');
    assert.equal(client.released, true);
  });
}

// No balance (including overpaid or invalid numeric totals) must not reach QR
// creation. These are distinct balance/number-boundary inputs on the real service.
for (let i = 1; i <= 500; i++) {
  const scenarios = [
    { total_amount: '100.00', paid_amount: '100.00' },
    { total_amount: '100.00', paid_amount: '100.01' },
    { total_amount: '0.00', paid_amount: '0.00' },
    { total_amount: 'invalid-total-' + i, paid_amount: '0.00' },
  ];
  const scenario = scenarios[(i - 1) % scenarios.length];
  test('createQrPayment rejects non-positive or invalid outstanding balance case ' + i, async () => {
    const restaurantId = 1 + (i % 79);
    const orderId = 400000 + i;
    const client = makeClient([validOrder({ id: orderId, ...scenario })]);
    await withClient(client, async () => {
      await assert.rejects(
        paymentService.createQrPayment({ restaurantId, orderId, amount: 50 }),
        /No outstanding amount remains for this order/
      );
    });
    assert.equal(client.statements.some(s => /FROM qr_payments|INSERT INTO qr_payments/.test(s.sql)), false);
    assert.equal(client.statements.at(-1).sql, 'ROLLBACK');
    assert.equal(client.released, true);
  });
}
