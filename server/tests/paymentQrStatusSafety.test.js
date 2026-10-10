'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadService(t, scenario) {
    const dbPath = require.resolve('../config/db');
    const servicePath = require.resolve('../services/paymentService');
    const previousDb = require.cache[dbPath];
    const previousService = require.cache[servicePath];
    const calls = [];
    let selectCount = 0;

    const pending = {
        status: 'pending',
        paid_at: null,
        paid_amount: null,
        payment_method: null,
        provider_ref: null,
        expires_at: new Date(Date.now() + 300000),
    };
    const paid = {
        status: 'paid',
        paid_at: new Date(),
        paid_amount: '700.00',
        payment_method: 'raast',
        provider_ref: 'provider-tx-1',
        expires_at: new Date(Date.now() - 1000),
    };

    const poolMock = {
        async query(sql, params) {
            const q = String(sql).replace(/\\s+/g, ' ').trim();
            calls.push({ sql: q, params });

            if (q.startsWith('SELECT status, paid_at')) {
                selectCount += 1;
                if (scenario === 'not-found') return { rows: [] };
                if (scenario === 'race-paid' && selectCount > 1) return { rows: [paid] };
                return { rows: [pending] };
            }

            if (q.startsWith('UPDATE qr_payments')) {
                if (scenario === 'expired') {
                    return { rows: [{ ...pending, status: 'expired' }] };
                }
                // Models either a not-yet-expired row or a concurrent state change.
                return { rows: [] };
            }

            throw new Error('Unexpected SQL in QR status test: ' + q);
        },
    };

    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: poolMock,
    };
    delete require.cache[servicePath];
    const service = require('../services/paymentService');

    t.after(() => {
        if (previousDb) require.cache[dbPath] = previousDb;
        else delete require.cache[dbPath];
        if (previousService) require.cache[servicePath] = previousService;
        else delete require.cache[servicePath];
    });

    return { service, calls };
}

test('QR status returns not_found without attempting an expiry update', async (t) => {
    const { service, calls } = loadService(t, 'not-found');
    const result = await service.getQrStatus('QR-missing', 3);

    assert.deepEqual(result, { status: 'not_found' });
    assert.equal(calls.some((c) => c.sql.startsWith('UPDATE qr_payments')), false);
});

test('QR status expires a pending QR only when the database confirms it is expired', async (t) => {
    const { service, calls } = loadService(t, 'expired');
    const result = await service.getQrStatus('QR-expired', 3);

    assert.equal(result.status, 'expired');
    const update = calls.find((c) => c.sql.startsWith('UPDATE qr_payments'));
    assert.ok(update);
    assert.match(update.sql, /status = 'pending'/);
    assert.match(update.sql, /expires_at <= NOW\(\)/);
    assert.deepEqual(update.params, ['QR-expired', 3]);
});

test('QR status returns the latest state if a concurrent webhook settles the QR', async (t) => {
    const { service, calls } = loadService(t, 'race-paid');
    const result = await service.getQrStatus('QR-race', 3);

    assert.equal(result.status, 'paid');
    assert.equal(result.paid_amount, '700.00');
    assert.equal(result.provider_ref, 'provider-tx-1');
    assert.equal(calls.filter((c) => c.sql.startsWith('SELECT status, paid_at')).length, 2);
    assert.ok(calls.some((c) => c.sql.startsWith('UPDATE qr_payments')));
});

test('QR status query scopes both reads and expiry update to the restaurant', async (t) => {
    const { service, calls } = loadService(t, 'race-paid');
    await service.getQrStatus('QR-tenant', 88);

    for (const call of calls) {
        assert.match(call.sql, /restaurant_id = \$2/);
        assert.deepEqual(call.params, ['QR-tenant', 88]);
    }
});
