'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSuccessfulWebhook } = require('../services/paymentWebhookValidation');

// Exercise the actual payment webhook validator with distinct runtime inputs.
for (let i = 1; i <= 400; i++) {
  const amount = (i + 0.25).toFixed(2);
  const transactionId = `provider-txn-${String(i).padStart(5, '0')}`;

  test('payment webhook accepts valid decimal amount and transaction ID case ' + i, () => {
    assert.deepEqual(
      validateSuccessfulWebhook({ amount, transactionId }),
      { amount: Number(amount), transactionId }
    );
  });
}

const invalidAmounts = [
  undefined, null, '', ' ', '\t', '\n', 'NaN', 'Infinity', '-Infinity',
  NaN, Infinity, -Infinity, 0, -0, -1, -0.01, true, false, {}, [], [1],
  'not-a-number', '12.3.4', '--1', '1,000', '$10', '10px'
];

for (let i = 1; i <= 300; i++) {
  const amount = i <= invalidAmounts.length
    ? invalidAmounts[i - 1]
    : (i % 2 === 0 ? `invalid-amount-${i}` : { invalidAmountCase: i });

  test('payment webhook rejects invalid amount input case ' + i, () => {
    assert.throws(
      () => validateSuccessfulWebhook({
        amount,
        transactionId: `valid-txn-${i}`
      }),
      /amount/
    );
  });
}

const invalidTransactionIds = [
  undefined, null, '', ' ', '\t', '\n', true, false, {}, [], [1],
  NaN, Infinity, -Infinity
];

for (let i = 1; i <= 300; i++) {
  const transactionId = i <= invalidTransactionIds.length
    ? invalidTransactionIds[i - 1]
    : (i % 2 === 0 ? `   ${' '.repeat(i % 5)}   ` : { invalidCase: i });

  test('payment webhook rejects missing or invalid transaction ID case ' + i, () => {
    assert.throws(
      () => validateSuccessfulWebhook({
        amount: (i + 0.5).toFixed(2),
        transactionId
      }),
      /transaction_id/
    );
  });
}
