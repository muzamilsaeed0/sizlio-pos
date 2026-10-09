'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('webhook rejects missing or tampered signatures before touching the database', async () => {
    const dbPath = require.resolve('../config/db');
    const servicePath = require.resolve('../services/paymentService');
    const previousDb = require.cache[dbPath];
    const previousService = require.cache[servicePath];
    const previousProvider = process.env.PAYMENT_PROVIDER;
    const previousSecret = process.env.PAYMENT_WEBHOOK_SECRET;
    let connectCalls = 0;
    let queryCalls = 0;

    const poolMock = {
        connect: async () => {
            connectCalls += 1;
            throw new Error('Database must not be reached for invalid signatures');
        },
        query: async () => {
            queryCalls += 1;
            throw new Error('Database must not be reached for invalid signatures');
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
        const body = {
            reference: 'QR-signature-test',
            transaction_id: 'provider-txn-signature-test',
            amount: '250.00',
            status: 'SUCCESS',
        };
        const raw = JSON.stringify(body);
        const validSignature = crypto
            .createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET)
            .update(raw)
            .digest('hex');

        await assert.rejects(
            handleWebhook({ headers: {}, body, rawBody: Buffer.from(raw) }),
            /Invalid signature/
        );

        await assert.rejects(
            handleWebhook({
                headers: { 'x-webhook-signature': validSignature },
                body: { ...body, amount: '1.00' },
                rawBody: Buffer.from(JSON.stringify({ ...body, amount: '1.00' })),
            }),
            /Invalid signature/
        );

        await assert.rejects(
            handleWebhook({
                headers: { 'x-webhook-signature': 'not-a-valid-signature' },
                body,
                rawBody: Buffer.from(raw),
            }),
            /Invalid signature/
        );

        assert.equal(connectCalls, 0);
        assert.equal(queryCalls, 0);
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
