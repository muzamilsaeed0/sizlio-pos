'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

test('payment webhook forwards exact original JSON bytes to signature verification', async (t) => {
    const routePath = require.resolve('../routes/paymentRoutes');
    const servicePath = require.resolve('../services/paymentService');
    const authPath = require.resolve('../middleware/authMiddleware');
    const dbPath = require.resolve('../config/db');
    const paths = [routePath, servicePath, authPath, dbPath];
    const previousCache = new Map(paths.map((path) => [path, require.cache[path]]));

    let received;
    require.cache[servicePath] = {
        id: servicePath,
        filename: servicePath,
        loaded: true,
        exports: {
            handleWebhook: async (args) => {
                received = args;
                return { ok: true };
            },
        },
    };
    require.cache[authPath] = {
        id: authPath,
        filename: authPath,
        loaded: true,
        exports: {
            authMiddleware: (_req, _res, next) => next(),
            authorize: () => (_req, _res, next) => next(),
        },
    };
    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: { query: async () => ({ rows: [] }) },
    };
    delete require.cache[routePath];

    let server;
    try {
        const router = require('../routes/paymentRoutes');
        const app = express();

        // Match the production middleware order: JSON parser first, then routes.
        app.use(express.json({
            verify: (req, _res, buffer) => {
                req.rawBody = Buffer.from(buffer);
            },
        }));
        app.use('/api/payments', router);

        server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        t.after(async () => {
            if (server?.listening) {
                await new Promise((resolve) => server.close(resolve));
            }
            for (const path of paths) {
                if (previousCache.get(path)) require.cache[path] = previousCache.get(path);
                else delete require.cache[path];
            }
        });

        // Deliberately include whitespace and a noncanonical key order. A
        // JSON.stringify(body) reconstruction would not equal these bytes.
        const raw = '{\n  "status": "SUCCESS", "amount": "125.00",\n  "reference": "QR-raw-bytes"\n}';
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: raw,
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        assert.ok(Buffer.isBuffer(received.rawBody));
        assert.equal(received.rawBody.toString('utf8'), raw);
        assert.deepEqual(received.body, {
            status: 'SUCCESS',
            amount: '125.00',
            reference: 'QR-raw-bytes',
        });
    } finally {
        if (server?.listening) {
            await new Promise((resolve) => server.close(resolve));
        }
        for (const path of paths) {
            if (previousCache.get(path)) require.cache[path] = previousCache.get(path);
            else delete require.cache[path];
        }
    }
});
