'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSuccessfulWebhook } = require('../services/paymentWebhookValidation');

test('accepts a positive numeric amount and trims transaction ID', () => {
    assert.deepEqual(
        validateSuccessfulWebhook({ amount: '125.50', transactionId: '  bank-123  ' }),
        { amount: 125.5, transactionId: 'bank-123' }
    );
});

test('rejects missing, blank, non-finite, zero, negative, and non-numeric amounts', () => {
    for (const amount of [undefined, null, '', '   ', 'NaN', 'Infinity', NaN, Infinity, 0, -1, true, {}]) {
        assert.throws(
            () => validateSuccessfulWebhook({ amount, transactionId: 'txn-1' }),
            /amount/
        );
    }
});

test('rejects missing or invalid provider transaction IDs', () => {
    for (const transactionId of [undefined, null, '', '   ', true, {}]) {
        assert.throws(
            () => validateSuccessfulWebhook({ amount: 10, transactionId }),
            /transaction_id/
        );
    }
});

test('accepts numeric provider transaction IDs and normalizes them to strings', () => {
    assert.deepEqual(
        validateSuccessfulWebhook({ amount: 10, transactionId: 12345 }),
        { amount: 10, transactionId: '12345' }
    );
});
