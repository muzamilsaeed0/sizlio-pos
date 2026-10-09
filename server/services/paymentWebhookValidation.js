'use strict';

function validateSuccessfulWebhook({ amount, transactionId }) {
    const amountType = typeof amount;
    const amountIsNumeric = amountType === 'number' ||
        (amountType === 'string' && amount.trim() !== '');

    if (
        !amountIsNumeric ||
        !Number.isFinite(Number(amount)) ||
        Number(amount) <= 0
    ) {
        throw new Error('Missing or invalid amount in successful payment webhook');
    }

    if (
        transactionId === null ||
        transactionId === undefined ||
        !['string', 'number'].includes(typeof transactionId) ||
        String(transactionId).trim() === ''
    ) {
        throw new Error('Missing transaction_id in successful payment webhook');
    }

    return {
        amount: Number(amount),
        transactionId: String(transactionId).trim(),
    };
}

module.exports = { validateSuccessfulWebhook };
