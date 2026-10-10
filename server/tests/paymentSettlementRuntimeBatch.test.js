'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
process.env.PAYMENT_PROVIDER = 'manual';
const pool = require('../config/db');
const paymentService = require('../services/paymentService');

const FUTURE = new Date('2099-01-01T00:00:00.000Z');

function makeClient({ lookupRows, orderRows, lockedPaymentRows }) {
  const statements = [];
  let released = false;

  return {
    statements,
    get released() { return released; },
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\\s+/g, ' ').trim();
      statements.push({ sql: normalized, params });

      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) {
        return { rows: [] };
      }

      if (normalized.includes('SELECT qp.*, o.restaurant_id AS order_restaurant_id')) {
        return { rows: lookupRows };
      }

      if (normalized.startsWith('SELECT') && normalized.includes('FROM orders') &&
          normalized.includes('FOR UPDATE')) {
        return { rows: orderRows };
      }

      if (normalized.startsWith('SELECT') && normalized.includes('FROM qr_payments') &&
          normalized.includes('FOR UPDATE')) {
        return { rows: lockedPaymentRows };
      }

      // The expiry and cancellation branches intentionally persist a terminal
      // QR status before returning their business-rule error. The mock must
      // accept those UPDATE statements rather than treating them as unknown SQL.
      if (/^(UPDATE|INSERT INTO)\\b/i.test(normalized)) {
        return { rows: [] };
      }

      throw new Error('Unexpected SQL in payment settlement test: ' + normalized);
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

function pendingPayment(i, status = 'pending') {
  const amount = Number((10 + (i % 100) / 100).toFixed(2));
  return {
    id: 100000 + i,
    qr_id: 'QR-runtime-' + i,
    order_id: 200000 + i,
    restaurant_id: 7,
    order_restaurant_id: 7,
    provider: 'manual',
    amount: amount.toFixed(2),
    status,
    expires_at: FUTURE,
  };
}

function unpaidOrder(payment) {
  return {
    id: payment.order_id,
    restaurant_id: payment.restaurant_id,
    total_amount: payment.amount,
    paid_amount: '0.00',
    payment_status: 'unpaid',
    status: 'served',
  };
}

// 500 runtime cases: unknown or cross-tenant QR references must fail closed.
for (let i = 1; i <= 500; i++) {
  test('settlement rejects unknown/cross-tenant QR reference case ' + i, async () => {
    const client = makeClient({
      lookupRows: [],
      orderRows: [],
      lockedPaymentRows: [],
    });

    await withClient(client, async () => {
      await assert.rejects(
        paymentService.manualConfirmPayment('QR-unknown-' + i, 900 + (i % 13), 7),
        /Payment reference not found/
      );
    });

    assert.equal(client.statements[0].sql, 'BEGIN');
    assert.equal(client.statements.at(-1).sql, 'ROLLBACK');
    assert.equal(client.released, true);
    assert.equal(client.statements.filter(s => s.sql.startsWith('UPDATE')).length, 0);
  });
}

// 500 runtime cases: provider amount differing from the QR amount is rejected
// before either the QR or order can be updated.
for (let i = 1; i <= 500; i++) {
  test('settlement rejects mismatched received amount case ' + i, async () => {
    const payment = pendingPayment(i);
    const client = makeClient({
      lookupRows: [payment],
      orderRows: [unpaidOrder(payment)],
      lockedPaymentRows: [payment],
    });
    const receivedAmount = Number((Number(payment.amount) + 0.01).toFixed(2));

    const body = {
      reference: payment.qr_id,
      transaction_id: 'provider-txn-' + i,
      amount: receivedAmount,
      status: 'SUCCESS',
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const secret = 'runtime-test-secret';
    process.env.PAYMENT_WEBHOOK_SECRET = secret;
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    await withClient(client, async () => {
      await assert.rejects(
        paymentService.handleWebhook({
          headers: { 'x-webhook-signature': signature },
          body,
          rawBody,
        }),
        /Payment amount mismatch/
      );
    });
    assert.equal(client.statements.filter(s => s.sql.startsWith('UPDATE')).length, 0);
    assert.equal(client.statements.at(-1).sql, 'ROLLBACK');
    assert.equal(client.released, true);
  });
}

// 500 runtime cases: repeated callbacks against an already-finalized QR are
// idempotent and do not issue any second payment/order update.
for (let i = 1; i <= 500; i++) {
  test('settlement treats finalized QR as duplicate case ' + i, async () => {
    const payment = pendingPayment(i, 'paid');
    const client = makeClient({
      lookupRows: [payment],
      orderRows: [unpaidOrder(payment)],
      lockedPaymentRows: [payment],
    });

    const result = await withClient(client, () =>
      paymentService.manualConfirmPayment(payment.qr_id, 1, payment.restaurant_id)
    );

    assert.equal(result.status, 'paid');
    assert.equal(client.statements.at(-1).sql, 'COMMIT');
    assert.equal(client.statements.filter(s => s.sql.startsWith('UPDATE')).length, 0);
    assert.equal(client.released, true);
  });
}


// 500 runtime cases: expired pending QRs must never settle successfully.
for (let i = 1; i <= 500; i++) {
  test('settlement expires stale QR instead of accepting payment case ' + i, async () => {
    const payment = {
      ...pendingPayment(2000 + i),
      expires_at: new Date('2000-01-01T00:00:00.000Z'),
    };
    const client = makeClient({
      lookupRows: [payment],
      orderRows: [unpaidOrder(payment)],
      lockedPaymentRows: [payment],
    });

    await withClient(client, async () => {
      await assert.rejects(
        paymentService.manualConfirmPayment(payment.qr_id, 1, payment.restaurant_id),
        /Payment QR has expired/
      );
    });

    assert.equal(client.statements.filter(s => s.sql.startsWith('UPDATE qr_payments')).length, 1);
    assert.equal(client.statements.some(s => s.sql.startsWith('UPDATE orders')), false);
    assert.equal(client.statements.some(s => s.sql === 'COMMIT'), true);
    assert.equal(client.released, true);
  });
}

// 500 runtime cases: cancelled orders cannot be paid using an existing QR.
for (let i = 1; i <= 500; i++) {
  test('settlement rejects payment for cancelled order case ' + i, async () => {
    const payment = pendingPayment(3000 + i);
    const order = { ...unpaidOrder(payment), status: 'cancelled' };
    const client = makeClient({
      lookupRows: [payment],
      orderRows: [order],
      lockedPaymentRows: [payment],
    });

    await withClient(client, async () => {
      await assert.rejects(
        paymentService.manualConfirmPayment(payment.qr_id, 1, payment.restaurant_id),
        /Cannot accept payment for a cancelled order/
      );
    });

    assert.equal(client.statements.filter(s => s.sql.startsWith('UPDATE qr_payments')).length, 1);
    assert.equal(client.statements.some(s => s.sql.startsWith('UPDATE orders')), false);
    assert.equal(client.released, true);
  });
}

// 500 runtime cases: an already-paid order must not be settled a second time.
for (let i = 1; i <= 500; i++) {
  test('settlement rejects payment when order is already paid case ' + i, async () => {
    const payment = pendingPayment(4000 + i);
    const order = {
      ...unpaidOrder(payment),
      payment_status: 'paid',
      paid_amount: payment.amount,
    };
    const client = makeClient({
      lookupRows: [payment],
      orderRows: [order],
      lockedPaymentRows: [payment],
    });

    await withClient(client, async () => {
      await assert.rejects(
        paymentService.manualConfirmPayment(payment.qr_id, 1, payment.restaurant_id),
        /Order is already paid/
      );
    });

    assert.equal(client.statements.filter(s => s.sql.startsWith('UPDATE')).length, 0);
    assert.equal(client.statements.filter(s => s.sql.includes('INSERT INTO payment_transactions')).length, 0);
    assert.equal(client.statements.at(-1).sql, 'ROLLBACK');
    assert.equal(client.released, true);
  });
}

// 500 runtime cases: a QR for an old balance cannot settle after the order total changes.
for (let i = 1; i <= 500; i++) {
  test('settlement rejects QR whose amount no longer matches outstanding balance case ' + i, async () => {
    const payment = pendingPayment(5000 + i);
    const order = {
      ...unpaidOrder(payment),
      total_amount: (Number(payment.amount) + 1).toFixed(2),
      paid_amount: '0.00',
    };
    const client = makeClient({
      lookupRows: [payment],
      orderRows: [order],
      lockedPaymentRows: [payment],
    });

    await withClient(client, async () => {
      await assert.rejects(
        paymentService.manualConfirmPayment(payment.qr_id, 1, payment.restaurant_id),
        /QR amount no longer matches the order outstanding amount/
      );
    });

    assert.equal(client.statements.filter(s => s.sql.startsWith('UPDATE')).length, 0);
    assert.equal(client.statements.filter(s => s.sql.includes('INSERT INTO payment_transactions')).length, 0);
    assert.equal(client.statements.at(-1).sql, 'ROLLBACK');
    assert.equal(client.released, true);
  });
}
