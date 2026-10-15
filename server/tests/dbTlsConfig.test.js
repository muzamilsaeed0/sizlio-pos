'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('production database TLS validates certificates by default', () => {
    const dbPath = require.resolve('../config/db');
    const pgPath = require.resolve('pg');
    const previousDb = require.cache[dbPath];
    const previousPg = require.cache[pgPath];
    const envKeys = [
        'NODE_ENV',
        'DATABASE_URL',
        'DATABASE_SSL_REJECT_UNAUTHORIZED',
        'DATABASE_SSL_CA',
    ];
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    let poolOptions;

    class MockPool {
        constructor(options) {
            poolOptions = options;
        }
        on() { return this; }
    }

    try {
        require.cache[pgPath] = {
            id: pgPath,
            filename: pgPath,
            loaded: true,
            exports: { Pool: MockPool },
        };
        process.env.NODE_ENV = 'production';
        process.env.DATABASE_URL = 'postgres://test.invalid/test';
        delete process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
        delete process.env.DATABASE_SSL_CA;
        delete require.cache[dbPath];

        require('../config/db');
        assert.equal(poolOptions.ssl.rejectUnauthorized, true);

        delete require.cache[dbPath];
        process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = 'false';
        require('../config/db');
        assert.equal(poolOptions.ssl.rejectUnauthorized, false);

        delete require.cache[dbPath];
        process.env.DATABASE_SSL_CA = '-----BEGIN CERTIFICATE-----\\nexample\\n-----END CERTIFICATE-----';
        require('../config/db');
        assert.equal(poolOptions.ssl.rejectUnauthorized, true);
        assert.ok(poolOptions.ssl.ca.includes('\n'));
    } finally {
        if (previousDb) require.cache[dbPath] = previousDb;
        else delete require.cache[dbPath];
        if (previousPg) require.cache[pgPath] = previousPg;
        else delete require.cache[pgPath];

        for (const key of envKeys) {
            if (previousEnv[key] === undefined) delete process.env[key];
            else process.env[key] = previousEnv[key];
        }
    }
});
