'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');

test('webhook route preserves exact raw bytes for signature verification', async () => {
    const dbPath = require.resolve('../config/db');
    const servicePath = require.resolve('../services/paymentService');
    const routesPath = require.resolve('../routes/paymentRoutes');
    const previousDb = require.cache[dbPath];
    const previousService = require.cache[servicePath];
    const previousRoutes = require.cache[routesPath];
    const previousSecret = process.env.PAYMENT_WEBHOOK_SECRET;
    const previousProvider = process.env.PAYMENT_PROVIDER;
    const secret = 'raw-body-route-test-secret';
    const calls = [];

    process.env.PAYMENT_PROVIDER = 'manual';
    process.env.PAYMENT_WEBHOOK_SECRET = secret;

    const poolMock = { query: async () => ({ rows: [] }), connect: async () => {
        throw new Error('Database should not be accessed by this route test');
    } };
    const serviceMock = {
        async handleWebhook(args) {
            calls.push(args);
            const expected = crypto.createHmac('sha256', secret)
                .update(args.rawBody)
                .digest('hex');
            const supplied = String(args.headers['x-webhook-signature'] || '');
            assert.equal(supplied, expected);
            assert.deepEqual(args.rawBody, Buffer.from('  { "status" : "PING" }  '));
            assert.deepEqual(args.body, { status: 'PING' });
            return { ok: true };
        },
        createQrPayment() {},
        getQrStatus() {},
        manualConfirmPayment() {},
    };

    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: poolMock };
    require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: serviceMock };
    delete require.cache[routesPath];

    let server;
    try {
        const router = require('../routes/paymentRoutes');
        const app = express();
        // Deliberately do not install express.json() before the webhook router.
        app.use('/api/payments', router);
        server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        const raw = Buffer.from('  { "status" : "PING" }  ');
        const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');

        const response = await new Promise((resolve, reject) => {
            const request = http.request({
                hostname: '127.0.0.1',
                port: address.port,
                path: '/api/payments/webhook',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': raw.length,
                    'x-webhook-signature': signature,
                },
            }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            });
            request.once('error', reject);
            request.end(raw);
        });

        assert.equal(response.status, 200, response.body);
        assert.deepEqual(JSON.parse(response.body), { ok: true });
        assert.equal(calls.length, 1);
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (previousDb) require.cache[dbPath] = previousDb;
        else delete require.cache[dbPath];
        if (previousService) require.cache[servicePath] = previousService;
        else delete require.cache[servicePath];
        if (previousRoutes) require.cache[routesPath] = previousRoutes;
        else delete require.cache[routesPath];

        if (previousSecret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
        else process.env.PAYMENT_WEBHOOK_SECRET = previousSecret;
        if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
        else process.env.PAYMENT_PROVIDER = previousProvider;
    }
});
