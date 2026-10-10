'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('webhook normalizes status and ignores pending updates without touching the database', async () => {
    const dbPath = require.resolve('../config/db');
    const servicePath = require.resolve('../services/paymentService');
    const previousDb = require.cache[dbPath];
    const previousService = require.cache[servicePath];
    const previousProvider = process.env.PAYMENT_PROVIDER;
    const previousSecret = process.env.PAYMENT_WEBHOOK_SECRET;
    let databaseCalls = 0;

    const poolMock = {
        connect: async () => {
            databaseCalls += 1;
            throw new Error('Database must not be touched by non-final webhook status');
        },
        query: async () => {
            databaseCalls += 1;
            throw new Error('Database must not be touched by non-final webhook status');
        },
    };

    process.env.PAYMENT_PROVIDER = 'manual';
    process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';
    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: poolMock,
    };
    delete require.cache[servicePath];

    try {
        const { handleWebhook } = require('../services/paymentService');
        const sign = (body) => {
            const raw = JSON.stringify(body);
            return {
                body,
                rawBody: Buffer.from(raw),
                headers: {
                    'x-webhook-signature': crypto
                        .createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET)
                        .update(raw)
                        .digest('hex'),
                },
            };
        };

        const pending = sign({
            reference: 'QR-pending-test',
            status: ' pending ',
        });
        assert.deepEqual(await handleWebhook(pending), { ok: true, ignored: true });

        const processing = sign({
            reference: 'QR-processing-test',
            status: 'processing',
        });
        assert.deepEqual(await handleWebhook(processing), { ok: true, ignored: true });

        const unsupported = sign({
            reference: 'QR-unsupported-test',
            status: 'mystery',
        });
        await assert.rejects(
            handleWebhook(unsupported),
            /Unsupported webhook status/
        );

        assert.equal(databaseCalls, 0);
    } finally {
        if (previousDb) require.cache[dbPath] = previousDb;
        else delete require.cache[dbPath];
        if (previousService) require.cache[servicePath] = previousService;
        else delete require.cache[servicePath];

        if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
        else process.env.PAYMENT_PROVIDER = previousProvider;

        if (previousSecret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
        else process.env.PAYMENT_WEBHOOK_SECRET = previousSecret;
    }
});
