'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function loadPaymentService(t, scenario) {
    const dbPath = require.resolve('../config/db');
    const servicePath = require.resolve('../services/paymentService');
    const previousDb = require.cache[dbPath];
    const previousService = require.cache[servicePath];
    const previousProvider = process.env.PAYMENT_PROVIDER;
    const previousSecret = process.env.PAYMENT_WEBHOOK_SECRET;
    const calls = [];

    const qr = {
        id: 18,
        qr_id: 'QR-test-18',
        order_id: 43,
        restaurant_id: 3,
        status: 'pending',
        amount: '500.00',
        provider: 'manual',
        expires_at: new Date(Date.now() + 600000),
    };
    const order = {
        id: 43,
        restaurant_id: 3,
        total_amount: '500.00',
        paid_amount: '0.00',
        payment_status: 'unpaid',
        status: 'served',
    };

    if (scenario === 'expired') qr.expires_at = new Date(Date.now() - 1000);
    if (scenario === 'cancelled-order') order.status = 'cancelled';
    if (scenario === 'outstanding-mismatch') order.total_amount = '700.00';
    if (scenario === 'tenant-mismatch') {
        qr.restaurant_id = 99;
        order.restaurant_id = 99;
    }

    const client = {
        async query(sql, params) {
            const q = String(sql).replace(/\s+/g, ' ').trim();
            calls.push({ sql: q, params });
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [] };

            if (q.includes('FROM qr_payments qp') && q.includes('INNER JOIN orders o')) {
                return { rows: [{ ...qr, order_restaurant_id: order.restaurant_id }] };
            }
            if (q.includes('FROM orders') && q.includes('FOR UPDATE')) {
                return { rows: scenario === 'missing-order' ? [] : [{ ...order }] };
            }
            if (q.includes('FROM qr_payments') && q.includes('FOR UPDATE')) {
                return { rows: [{ ...qr }] };
            }
            if (q.startsWith('UPDATE qr_payments')) return { rows: [{ ...qr, status: 'updated' }] };
            if (q.startsWith('UPDATE orders')) return { rows: [{ ...order, payment_status: 'paid' }] };
            if (q.includes('INSERT INTO payment_transactions')) return { rows: [] };
            throw new Error('Unexpected SQL in payment settlement test: ' + q);
        },
        release() { calls.push({ sql: 'RELEASE' }); },
    };

    const poolMock = {
        connect: async () => client,
        query: async () => ({ rows: [] }),
    };
    process.env.PAYMENT_PROVIDER = 'manual';
    process.env.PAYMENT_WEBHOOK_SECRET = 'payment-test-secret';
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: poolMock };
    delete require.cache[servicePath];

    const service = require('../services/paymentService');
    t.after(() => {
        if (previousDb) require.cache[dbPath] = previousDb;
        else delete require.cache[dbPath];
        if (previousService) require.cache[servicePath] = previousService;
        else delete require.cache[servicePath];
        if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
        else process.env.PAYMENT_PROVIDER = previousProvider;
        if (previousSecret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
        else process.env.PAYMENT_WEBHOOK_SECRET = previousSecret;
    });

    return { service, calls };
}

function signedSuccess(amount = '500.00') {
    const body = {
        reference: 'QR-test-18',
        transaction_id: 'provider-txn-test-18',
        amount,
        status: 'SUCCESS',
        payment_method: 'raast',
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    return {
        body,
        rawBody,
        headers: {
            'x-webhook-signature': crypto
                .createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET)
                .update(rawBody)
                .digest('hex'),
        },
    };
}

test('settlement rejects a received amount that differs from the QR amount', async (t) => {
    const { service, calls } = loadPaymentService(t, 'normal');
    await assert.rejects(
        service.handleWebhook(signedSuccess('499.99')),
        /Payment amount mismatch/
    );
    assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
    assert.equal(calls.some((c) => c.sql.startsWith('UPDATE qr_payments')), false);
    assert.equal(calls.some((c) => c.sql.includes('INSERT INTO payment_transactions')), false);
});

test('settlement expires an expired QR without inserting a payment ledger entry', async (t) => {
    const { service, calls } = loadPaymentService(t, 'expired');
    await assert.rejects(service.handleWebhook(signedSuccess()), /Payment QR has expired/);
    assert.ok(calls.some((c) => c.sql.startsWith('UPDATE qr_payments') && c.sql.includes("status = 'expired'")));
    assert.ok(calls.some((c) => c.sql === 'COMMIT'));
    assert.equal(calls.some((c) => c.sql.includes('INSERT INTO payment_transactions')), false);
});

test('settlement cancels a pending QR when its order is cancelled', async (t) => {
    const { service, calls } = loadPaymentService(t, 'cancelled-order');
    await assert.rejects(
        service.handleWebhook(signedSuccess()),
        /Cannot accept payment for a cancelled order/
    );
    assert.ok(calls.some((c) => c.sql.startsWith('UPDATE qr_payments') && c.sql.includes("status = 'cancelled'")));
    assert.equal(calls.some((c) => c.sql.includes('INSERT INTO payment_transactions')), false);
});

test('settlement rejects a QR whose amount no longer matches the order balance', async (t) => {
    const { service, calls } = loadPaymentService(t, 'outstanding-mismatch');
    await assert.rejects(
        service.handleWebhook(signedSuccess()),
        /QR amount no longer matches the order outstanding amount/
    );
    assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
    assert.equal(calls.some((c) => c.sql.startsWith('UPDATE qr_payments')), false);
    assert.equal(calls.some((c) => c.sql.includes('INSERT INTO payment_transactions')), false);
});

test('settlement rejects a payment when the order tenant does not match the requested tenant', async (t) => {
    const { service, calls } = loadPaymentService(t, 'tenant-mismatch');
    await assert.rejects(
        service.manualConfirmPayment('QR-test-18', 7, 3),
        /Payment does not belong to this restaurant/
    );
    assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
    assert.equal(calls.some((c) => c.sql.startsWith('UPDATE qr_payments')), false);
    assert.equal(calls.some((c) => c.sql.includes('INSERT INTO payment_transactions')), false);
});
