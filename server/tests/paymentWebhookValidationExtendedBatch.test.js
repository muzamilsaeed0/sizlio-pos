'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSuccessfulWebhook } = require('../services/paymentWebhookValidation');

// 1,000 valid runtime cases: decimal-string amounts are normalized to numbers,
// and numeric transaction IDs are normalized to strings.
for (let i = 1; i <= 1000; i++) {
  test('webhook validator normalizes valid amount and numeric transaction ID case ' + i, () => {
    const amount = (i / 100).toFixed(2);
    const transactionId = i * 7919;
    assert.deepEqual(
      validateSuccessfulWebhook({ amount, transactionId }),
      { amount: Number(amount), transactionId: String(transactionId) }
    );
  });
}

// 1,000 invalid amount cases across numeric boundaries and unsupported types.
// The validator must reject non-positive, non-finite, blank, and non-numeric input.
for (let i = 1; i <= 1000; i++) {
  const invalidAmounts = [
    0,
    -0.01 * i,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '',
    '   ',
    'NaN',
    'Infinity',
    'not-a-number',
    true,
    false,
    null,
    undefined,
    {},
    [],
    [i],
    '$' + i + '.00',
    String(i) + '.00.1',
    'invalid-' + i
  ];
  const amount = invalidAmounts[(i - 1) % invalidAmounts.length];

  test('webhook validator rejects invalid amount type or boundary case ' + i, () => {
    assert.throws(
      () => validateSuccessfulWebhook({ amount, transactionId: 'txn-' + i }),
      /amount/
    );
  });
}

// 1,000 invalid transaction ID cases: blank/whitespace strings, non-scalar
// values, and non-finite numbers must never pass as provider transaction IDs.
for (let i = 1; i <= 1000; i++) {
  const invalidIds = [
    undefined,
    null,
    '',
    '   ',
    '\\t',
    '\\n',
    true,
    false,
    {},
    [],
    [i],
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ];
  const transactionId = invalidIds[(i - 1) % invalidIds.length];

  test('webhook validator rejects invalid transaction ID case ' + i, () => {
    assert.throws(
      () => validateSuccessfulWebhook({
        amount: (i / 100 + 1).toFixed(2),
        transactionId
      }),
      /transaction_id/
    );
  });
}
