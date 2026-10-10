'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadService(t, scenario) {
    const dbPath = require.resolve('../config/db');
    const servicePath = require.resolve('../services/paymentService');
    const previousDb = require.cache[dbPath];
    const previousService = require.cache[servicePath];
    const previousProvider = process.env.PAYMENT_PROVIDER;
    const calls = [];

    const order = {
        id: 43,
        restaurant_id: 3,
        total_amount: '900.00',
        paid_amount: '200.00',
        payment_status: 'unpaid',
        status: 'served',
    };

    const client = {
        async query(sql, params) {
            const q = String(sql).replace(/\s+/g, ' ').trim();
            calls.push({ sql: q, params });
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [] };

            if (q.includes('FROM orders') && q.includes('FOR UPDATE')) {
                return { rows: scenario === 'missing-order' ? [] : [{ ...order }] };
            }
            if (q.includes('FROM qr_payments') && q.includes("status = 'pending'")) {
                if (scenario === 'reusable-qr') {
                    return { rows: [{
                        id: 55,
                        qr_id: 'QR-existing',
                        amount: '700.00',
                        qr_string: 'RAAST://existing',
                        qr_image_url: 'https://example.test/qr.png',
                        expires_at: new Date(Date.now() + 300000),
                        status: 'pending',
                    }] };
                }
                return { rows: [] };
            }
            if (q.startsWith('INSERT INTO qr_payments')) {
                return { rows: [{
                    id: 56,
                    qr_id: params[2],
                    amount: params[4],
                    expires_at: new Date(Date.now() + 600000),
                    status: 'pending',
                }] };
            }
            if (q.startsWith('UPDATE qr_payments')) return { rows: [] };
            throw new Error('Unexpected SQL in QR creation test: ' + q);
        },
        release() { calls.push({ sql: 'RELEASE' }); },
    };

    const poolMock = {
        connect: async () => client,
        query: async (sql, params) => {
            const q = String(sql).replace(/\s+/g, ' ').trim();
            calls.push({ sql: q, params, poolQuery: true });
            if (q.includes('SELECT raast_qr_string')) {
                return { rows: [{ raast_qr_string: 'RAAST://merchant' }] };
            }
            return { rows: [] };
        },
    };

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

test('QR creation ignores client-supplied amount and uses the server-calculated outstanding balance', async (t) => {
    const { service, calls } = loadService(t, 'normal');
    const result = await service.createQrPayment({
        restaurantId: 3,
        orderId: 43,
        amount: 1,
        description: 'test order',
    });

    assert.equal(result.amount, 700);
    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO qr_payments'));
    assert.ok(insert);
    assert.equal(Number(insert.params[4]), 700);
    assert.ok(calls.some((c) => c.sql === 'COMMIT'));
    assert.equal(calls.some((c) => c.sql === 'ROLLBACK'), false);
});

test('QR creation rejects an order that does not belong to the requested restaurant', async (t) => {
    const { service, calls } = loadService(t, 'missing-order');
    await assert.rejects(
        service.createQrPayment({ restaurantId: 77, orderId: 43, amount: 700 }),
        /Order not found for this restaurant/
    );
    assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
    assert.equal(calls.some((c) => c.sql.startsWith('INSERT INTO qr_payments')), false);
});

test('QR creation reuses a valid pending QR only when it matches outstanding balance', async (t) => {
    const { service, calls } = loadService(t, 'reusable-qr');
    const result = await service.createQrPayment({
        restaurantId: 3,
        orderId: 43,
        amount: 9999,
    });

    assert.equal(result.qr_id, 'QR-existing');
    assert.equal(result.amount, 700);
    assert.equal(result.reused, true);
    assert.equal(calls.some((c) => c.sql.startsWith('INSERT INTO qr_payments')), false);
    assert.ok(calls.some((c) => c.sql === 'COMMIT'));
});
