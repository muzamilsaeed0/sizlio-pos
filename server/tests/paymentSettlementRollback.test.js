'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('ledger insert failure rolls back QR and order settlement transaction', async () => {
    const dbPath = require.resolve('../config/db');
    const servicePath = require.resolve('../services/paymentService');
    const previousDb = require.cache[dbPath];
    const previousService = require.cache[servicePath];
    const calls = [];

    const client = {
        async query(sql, params) {
            const normalized = String(sql).replace(/\s+/g, ' ').trim();
            calls.push(normalized);

            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) {
                return { rows: [] };
            }
            if (normalized.includes('FROM qr_payments qp') && normalized.includes('INNER JOIN orders o')) {
                return { rows: [{
                    id: 18, qr_id: 'QR-test-18', order_id: 43,
                    restaurant_id: 3, order_restaurant_id: 3,
                    status: 'pending', amount: '500.00', provider: 'manual',
                    expires_at: new Date(Date.now() + 600000),
                }] };
            }
            if (normalized.includes('FROM orders') && normalized.includes('FOR UPDATE')) {
                return { rows: [{
                    id: 43, restaurant_id: 3, total_amount: '500.00',
                    paid_amount: '0.00', payment_status: 'unpaid', status: 'served',
                }] };
            }
            if (normalized.includes('FROM qr_payments') && normalized.includes('FOR UPDATE')) {
                return { rows: [{
                    id: 18, qr_id: 'QR-test-18', order_id: 43,
                    restaurant_id: 3, status: 'pending', amount: '500.00',
                    provider: 'manual', expires_at: new Date(Date.now() + 600000),
                }] };
            }
            if (normalized.startsWith('UPDATE qr_payments')) return { rows: [{ id: 18 }] };
            if (normalized.startsWith('UPDATE orders')) {
                return { rows: [{
                    id: 43, restaurant_id: 3, total_amount: '500.00',
                    paid_amount: '500.00', payment_status: 'paid',
                }] };
            }
            if (normalized.includes('INSERT INTO payment_transactions')) {
                throw new Error('duplicate provider reference');
            }
            throw new Error('Unexpected SQL in test: ' + normalized);
        },
        release() { calls.push('RELEASE'); },
    };
    const poolMock = { connect: async () => client, query: async () => ({ rows: [] }) };

    process.env.PAYMENT_PROVIDER = 'manual';
    process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: poolMock };
    delete require.cache[servicePath];

    try {
        const { handleWebhook } = require('../services/paymentService');
        const body = {
            reference: 'QR-test-18',
            transaction_id: 'provider-txn-duplicate',
            amount: '500.00',
            status: 'SUCCESS',
            payment_method: 'raast',
        };
        const raw = JSON.stringify(body);
        const signature = crypto.createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET)
            .update(raw).digest('hex');

        await assert.rejects(
            handleWebhook({
                headers: { 'x-webhook-signature': signature },
                body,
                rawBody: Buffer.from(raw),
            }),
            /duplicate provider reference/
        );

        assert.ok(calls.includes('BEGIN'));
        assert.ok(calls.includes('ROLLBACK'));
        assert.equal(calls.includes('COMMIT'), false);
        assert.ok(calls.some((sql) => sql.startsWith('UPDATE qr_payments')));
        assert.ok(calls.some((sql) => sql.startsWith('UPDATE orders')));
        assert.ok(calls.some((sql) => sql.includes('INSERT INTO payment_transactions')));
        assert.ok(calls.includes('RELEASE'));
    } finally {
        if (previousDb) require.cache[dbPath] = previousDb;
        else delete require.cache[dbPath];
        if (previousService) require.cache[servicePath] = previousService;
        else delete require.cache[servicePath];
        delete process.env.PAYMENT_PROVIDER;
        delete process.env.PAYMENT_WEBHOOK_SECRET;
    }
});
