'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

test('replayed successful webhook returns duplicate without inserting another ledger entry', async () => {
    const dbPath = require.resolve('../config/db');
    const servicePath = require.resolve('../services/paymentService');
    const previousDb = require.cache[dbPath];
    const previousService = require.cache[servicePath];
    const calls = [];

    const client = {
        async query(sql, params) {
            const normalized = String(sql).replace(/\s+/g, ' ').trim();
            calls.push({ sql: normalized, params });

            if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
                return { rows: [] };
            }
            if (normalized.includes('FROM qr_payments qp') && normalized.includes('INNER JOIN orders o')) {
                return { rows: [{
                    id: 17,
                    qr_id: 'QR-test-17',
                    order_id: 42,
                    restaurant_id: 3,
                    order_restaurant_id: 3,
                    status: 'paid',
                    amount: '500.00',
                    provider: 'manual',
                }] };
            }
            if (normalized.includes('FROM orders') && normalized.includes('FOR UPDATE')) {
                return { rows: [{
                    id: 42,
                    restaurant_id: 3,
                    total_amount: '500.00',
                    paid_amount: '500.00',
                    payment_status: 'paid',
                    status: 'served',
                }] };
            }
            if (normalized.includes('FROM qr_payments') && normalized.includes('FOR UPDATE')) {
                return { rows: [{
                    id: 17,
                    qr_id: 'QR-test-17',
                    order_id: 42,
                    restaurant_id: 3,
                    status: 'paid',
                    amount: '500.00',
                    provider: 'manual',
                }] };
            }
            throw new Error('Unexpected SQL in test: ' + normalized);
        },
        release() { calls.push({ sql: 'RELEASE' }); },
    };

    const poolMock = {
        connect: async () => client,
        query: async () => ({ rows: [] }),
    };

    process.env.PAYMENT_PROVIDER = 'manual';
    process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: poolMock };
    delete require.cache[servicePath];

    try {
        const { handleWebhook } = require('../services/paymentService');
        const body = {
            reference: 'QR-test-17',
            transaction_id: 'provider-txn-17',
            amount: '500.00',
            status: 'SUCCESS',
            payment_method: 'raast',
        };
        const raw = JSON.stringify(body);
        const signature = crypto
            .createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET)
            .update(raw)
            .digest('hex');

        const result = await handleWebhook({
            headers: { 'x-webhook-signature': signature },
            body,
            rawBody: Buffer.from(raw),
        });

        assert.deepEqual(result, { ok: true, duplicate: true });
        assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO payment_transactions')).length, 0);
        assert.equal(calls.filter((call) => call.sql.startsWith('UPDATE qr_payments')).length, 0);
        assert.equal(calls.filter((call) => call.sql.startsWith('UPDATE orders')).length, 0);
        assert.ok(calls.some((call) => call.sql === 'COMMIT'));
        assert.ok(calls.some((call) => call.sql === 'RELEASE'));
    } finally {
        if (previousDb) require.cache[dbPath] = previousDb;
        else delete require.cache[dbPath];
        if (previousService) require.cache[servicePath] = previousService;
        else delete require.cache[servicePath];
        delete process.env.PAYMENT_PROVIDER;
        delete process.env.PAYMENT_WEBHOOK_SECRET;
    }
});
