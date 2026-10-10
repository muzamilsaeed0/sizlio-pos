'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSuccessfulWebhook } = require('../services/paymentWebhookValidation');

// Batch A: accepted amount representations and boundary values (10 tests).
const validAmounts = [
    ['integer number', 1, 1],
    ['decimal number', 12.75, 12.75],
    ['small positive fraction', 0.01, 0.01],
    ['numeric integer string', '125', 125],
    ['numeric decimal string', '125.50', 125.5],
    ['trimmed numeric string', '  42.25  ', 42.25],
    ['large finite amount', 999999999.99, 999999999.99],
    ['small finite positive number', 0.0001, 0.0001],
    ['numeric string with leading zeros', '0012.50', 12.5],
    ['numeric string with plus sign', '+7.25', 7.25],
];

for (const [label, amount, expected] of validAmounts) {
    test('webhook validation accepts ' + label, () => {
        const result = validateSuccessfulWebhook({ amount, transactionId: 'txn-1' });
        assert.equal(result.amount, expected);
        assert.equal(result.transactionId, 'txn-1');
    });
}

// Batch B: malformed, unsafe, or non-positive amounts (10 tests).
const invalidAmounts = [
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace-only string', '   '],
    ['NaN string', 'NaN'],
    ['positive infinity string', 'Infinity'],
    ['negative infinity string', '-Infinity'],
    ['numeric NaN', NaN],
    ['zero including negative zero', -0],
    ['boolean masquerading as a number', true],
];

for (const [label, amount] of invalidAmounts) {
    test('webhook validation rejects ' + label + ' amount', () => {
        assert.throws(
            () => validateSuccessfulWebhook({ amount, transactionId: 'txn-1' }),
            /amount/
        );
    });
}

// Batch C: valid provider transaction identifiers normalize consistently (5 tests).
const validTransactionIds = [
    ['plain string', 'bank-123', 'bank-123'],
    ['string with surrounding spaces', '  bank-123  ', 'bank-123'],
    ['positive numeric ID', 12345, '12345'],
    ['zero numeric ID', 0, '0'],
    ['numeric-looking string with leading zeros', '000123', '000123'],
];

for (const [label, transactionId, expected] of validTransactionIds) {
    test('webhook validation accepts ' + label + ' transaction ID', () => {
        const result = validateSuccessfulWebhook({ amount: 10, transactionId });
        assert.equal(result.transactionId, expected);
        assert.equal(result.amount, 10);
    });
}

// Batch D: invalid provider transaction identifiers must fail closed (5 tests).
const invalidTransactionIds = [
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace-only string', '   '],
    ['object value', { id: 'txn-1' }],
];

for (const [label, transactionId] of invalidTransactionIds) {
    test('webhook validation rejects ' + label + ' transaction ID', () => {
        assert.throws(
            () => validateSuccessfulWebhook({ amount: 10, transactionId }),
            /transaction_id/
        );
    });
}
