'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadCreateService(t, { provider = 'manual', merchantQr = '', scenario = 'normal' } = {}) {
    const dbPath = require.resolve('../config/db');
    const servicePath = require.resolve('../services/paymentService');
    const previousDb = require.cache[dbPath];
    const previousService = require.cache[servicePath];
    const previousProvider = process.env.PAYMENT_PROVIDER;
    const calls = [];

    const client = {
        async query(sql, params) {
            const q = String(sql).replace(/\s+/g, ' ').trim();
            calls.push({ sql: q, params });
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [] };
            if (q.includes('FROM orders') && q.includes('FOR UPDATE')) {
                return { rows: [{
                    id: 43, restaurant_id: 3, total_amount: '900.00',
                    paid_amount: '200.00', payment_status: 'unpaid', status: 'served',
                }] };
            }
            if (q.includes('FROM qr_payments') && q.includes("status = 'pending'")) {
                return { rows: [] };
            }
            if (q.startsWith('INSERT INTO qr_payments')) {
                return { rows: [{
                    id: 56, qr_id: params[2], amount: params[4],
                    expires_at: new Date(Date.now() + 600000), status: 'pending',
                }] };
            }
            if (q.startsWith('UPDATE qr_payments')) return { rows: [] };
            throw new Error('Unexpected SQL in QR creation test: ' + q);
        },
        release() { calls.push({ sql: 'RELEASE' }); },
    };

    const poolMock = {
        connect: async () => client,
        async query(sql, params) {
            const q = String(sql).replace(/\s+/g, ' ').trim();
            calls.push({ sql: q, params, poolQuery: true });
            if (q.includes('SELECT raast_qr_string')) {
                return { rows: merchantQr ? [{ raast_qr_string: merchantQr }] : [] };
            }
            throw new Error('Unexpected pool SQL in QR creation test: ' + q);
        },
    };

    process.env.PAYMENT_PROVIDER = provider;
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
    });
    return { service, calls };
}

function loadSettlementService(t, scenario = 'normal') {
    const dbPath = require.resolve('../config/db');
    const servicePath = require.resolve('../services/paymentService');
    const previousDb = require.cache[dbPath];
    const previousService = require.cache[servicePath];
    const previousProvider = process.env.PAYMENT_PROVIDER;
    const calls = [];

    const order = {
        id: 43, restaurant_id: 3, total_amount: '900.00', paid_amount: '200.00',
        payment_status: 'unpaid', status: 'served',
    };
    const payment = {
        id: 56, qr_id: 'QR-settle', order_id: 43, restaurant_id: 3,
        amount: '700.00', status: 'pending', expires_at: new Date(Date.now() + 600000),
        provider: 'manual', provider_ref: null,
    };
    if (scenario === 'paid-order') order.payment_status = 'paid';
    if (scenario === 'no-balance') order.paid_amount = '900.00';
    if (scenario === 'cancelled-order') order.status = 'cancelled';
    if (scenario === 'expired-qr') payment.expires_at = new Date(Date.now() - 60000);
    if (scenario === 'duplicate') payment.status = 'paid';

    const client = {
        async query(sql, params) {
            const q = String(sql).replace(/\s+/g, ' ').trim();
            calls.push({ sql: q, params });
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [] };
            if (q.includes('FROM qr_payments qp') && q.includes('INNER JOIN orders o')) {
                return { rows: [{ ...payment, order_restaurant_id: 3 }] };
            }
            if (q.startsWith('SELECT id, restaurant_id, total_amount')) {
                return { rows: [{ ...order }] };
            }
            if (q.startsWith('SELECT * FROM qr_payments')) {
                return { rows: [{ ...payment }] };
            }
            if (q.startsWith('UPDATE qr_payments')) {
                return { rows: [] };
            }
            if (q.startsWith('UPDATE orders')) {
                if (scenario === 'order-update-empty') return { rows: [] };
                return { rows: [{ ...order, payment_status: 'paid', paid_amount: '900.00' }] };
            }
            if (q.startsWith('INSERT INTO payment_transactions')) return { rows: [] };
            throw new Error('Unexpected SQL in settlement test: ' + q);
        },
        release() { calls.push({ sql: 'RELEASE' }); },
    };

    const poolMock = { connect: async () => client, query: async () => ({ rows: [] }) };
    process.env.PAYMENT_PROVIDER = 'manual';
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
    });
    return { service, calls };
}

test('manual QR creation uses and trims the restaurant-configured Raast QR string', async (t) => {
    const { service } = loadCreateService(t, { merchantQr: '  RAAST://merchant/custom  ' });
    const result = await service.createQrPayment({ restaurantId: 3, orderId: 43 });
    assert.equal(result.qr_string, 'RAAST://merchant/custom');
    assert.match(result.qr_image_url, /api\.qrserver\.com/);
});

test('manual QR creation falls back to a generated amount and reference string when merchant QR is blank', async (t) => {
    const { service } = loadCreateService(t, { merchantQr: '   ' });
    const result = await service.createQrPayment({ restaurantId: 3, orderId: 43 });
    assert.match(result.qr_string, /^RAAST:\/\/PAY\?amount=700&ref=QR-/);
    assert.ok(result.qr_image_url.includes(encodeURIComponent(result.qr_string)));
});

test('unsupported payment provider fails closed and rolls back the inserted pending QR', async (t) => {
    const { service, calls } = loadCreateService(t, { provider: 'unsupported-provider' });
    await assert.rejects(
        service.createQrPayment({ restaurantId: 3, orderId: 43 }),
        /Unknown provider: unsupported-provider/
    );
    assert.ok(calls.some((c) => c.sql.startsWith('INSERT INTO qr_payments')));
    assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
    assert.ok(calls.some((c) => c.sql === 'RELEASE'));
    assert.equal(calls.some((c) => c.sql === 'COMMIT'), false);
});

test('settlement rejects an order already marked paid without writing a ledger entry', async (t) => {
    const { service, calls } = loadSettlementService(t, 'paid-order');
    await assert.rejects(
        service.settleQrPayment({ qrId: 'QR-settle', restaurantId: 3, receivedAmount: 700 }),
        /Order is already paid/
    );
    assert.equal(calls.some((c) => c.sql.startsWith('INSERT INTO payment_transactions')), false);
    assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
});

test('settlement rejects an order with no remaining balance', async (t) => {
    const { service, calls } = loadSettlementService(t, 'no-balance');
    await assert.rejects(
        service.settleQrPayment({ qrId: 'QR-settle', restaurantId: 3, receivedAmount: 700 }),
        /No outstanding amount remains/
    );
    assert.equal(calls.some((c) => c.sql.startsWith('UPDATE orders')), false);
    assert.equal(calls.some((c) => c.sql.startsWith('INSERT INTO payment_transactions')), false);
});

test('settlement commits QR cancellation before rejecting a cancelled order', async (t) => {
    const { service, calls } = loadSettlementService(t, 'cancelled-order');
    await assert.rejects(
        service.settleQrPayment({ qrId: 'QR-settle', restaurantId: 3, receivedAmount: 700 }),
        /cancelled order/
    );
    const cancellationIndex = calls.findIndex((c) =>
        c.sql.startsWith('UPDATE qr_payments') && c.sql.includes("SET status = 'cancelled'")
    );
    const commitIndex = calls.findIndex((c) => c.sql === 'COMMIT');
    assert.ok(cancellationIndex >= 0);
    assert.ok(commitIndex > cancellationIndex);
    assert.equal(calls.some((c) => c.sql.startsWith('INSERT INTO payment_transactions')), false);
});

test('settlement commits QR expiry before rejecting an expired QR', async (t) => {
    const { service, calls } = loadSettlementService(t, 'expired-qr');
    await assert.rejects(
        service.settleQrPayment({ qrId: 'QR-settle', restaurantId: 3, receivedAmount: 700 }),
        /Payment QR has expired/
    );
    const expiryIndex = calls.findIndex((c) =>
        c.sql.startsWith('UPDATE qr_payments') && c.sql.includes("SET status = 'expired'")
    );
    const commitIndex = calls.findIndex((c) => c.sql === 'COMMIT');
    assert.ok(expiryIndex >= 0);
    assert.ok(commitIndex > expiryIndex);
    assert.equal(calls.some((c) => c.sql.startsWith('INSERT INTO payment_transactions')), false);
});

test('settlement treats an already-settled QR as a duplicate and does not insert another ledger row', async (t) => {
    const { service, calls } = loadSettlementService(t, 'duplicate');
    const result = await service.settleQrPayment({
        qrId: 'QR-settle', restaurantId: 3, receivedAmount: 700,
    });
    assert.equal(result.duplicate, true);
    assert.equal(calls.some((c) => c.sql.startsWith('INSERT INTO payment_transactions')), false);
    assert.ok(calls.some((c) => c.sql === 'COMMIT'));
});

test('settlement writes the order and ledger only after validating the outstanding amount', async (t) => {
    const { service, calls } = loadSettlementService(t, 'normal');
    const result = await service.settleQrPayment({
        qrId: 'QR-settle', restaurantId: 3, receivedAmount: 700,
        paymentMethod: 'raast', providerRef: 'bank-tx-43',
    });
    assert.equal(result.duplicate, false);
    assert.equal(result.qrPayment.status, 'paid');
    assert.ok(calls.some((c) => c.sql.startsWith('UPDATE orders')));
    const ledger = calls.find((c) => c.sql.startsWith('INSERT INTO payment_transactions'));
    assert.ok(ledger);
    assert.equal(ledger.params[0], 3);
    assert.equal(ledger.params[1], 43);
    assert.equal(ledger.params[3], '700.00');
    assert.equal(ledger.params[6], 'QR-settle');
    assert.ok(calls.some((c) => c.sql === 'COMMIT'));
});

test('settlement rolls back if the guarded order update returns no row', async (t) => {
    const { service, calls } = loadSettlementService(t, 'order-update-empty');
    await assert.rejects(
        service.settleQrPayment({ qrId: 'QR-settle', restaurantId: 3, receivedAmount: 700 }),
        /Order payment could not be finalized/
    );
    assert.equal(calls.some((c) => c.sql.startsWith('INSERT INTO payment_transactions')), false);
    assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
});

test('settlement rejects a received amount mismatch before updating the order or ledger', async (t) => {
    const { service, calls } = loadSettlementService(t, 'normal');
    await assert.rejects(
        service.settleQrPayment({ qrId: 'QR-settle', restaurantId: 3, receivedAmount: 699.99 }),
        /Payment amount mismatch/
    );
    assert.equal(calls.some((c) => c.sql.startsWith('UPDATE orders')), false);
    assert.equal(calls.some((c) => c.sql.startsWith('INSERT INTO payment_transactions')), false);
});
