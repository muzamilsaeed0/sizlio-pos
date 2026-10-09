const crypto = require('crypto');
const pool = require('../config/db');

const PAYMENT_CONFIG = {
    provider: process.env.PAYMENT_PROVIDER || 'manual',
    raast: {
        merchantId: process.env.RAAST_MERCHANT_ID || '',
        apiKey: process.env.RAAST_API_KEY || '',
        apiSecret: process.env.RAAST_API_SECRET || '',
        baseUrl: process.env.RAAST_BASE_URL || 'https://api.raast.test',
    },
};

/* ============================================================
   CREATE QR
   ============================================================ */
async function createQrPayment({ restaurantId, orderId, amount, description }) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Tenant boundary + server-side amount calculation.
        const orderCheck = await client.query(
            `SELECT id, total_amount, paid_amount, payment_status, status
             FROM orders
             WHERE id = $1 AND restaurant_id = $2
             FOR UPDATE`,
            [orderId, restaurantId]
        );

        if (!orderCheck.rows.length) {
            throw new Error('Order not found for this restaurant');
        }

        const order = orderCheck.rows[0];

        if (order.status === 'cancelled') {
            throw new Error('Cannot create a payment QR for a cancelled order');
        }

        if (order.payment_status === 'paid') {
            throw new Error('Order is already paid');
        }

        const orderTotal = Number(order.total_amount || 0);
        const paidAmount = Number(order.paid_amount || 0);
        const outstandingAmount = Number((orderTotal - paidAmount).toFixed(2));

        if (!Number.isFinite(outstandingAmount) || outstandingAmount <= 0) {
            throw new Error('No outstanding amount remains for this order');
        }

        // Only one pending QR is allowed for an order at a time.
        const existingQr = await client.query(
            `SELECT *
             FROM qr_payments
             WHERE order_id = $1
               AND restaurant_id = $2
               AND status = 'pending'
               AND expires_at > NOW()
             ORDER BY id DESC
             LIMIT 1
             FOR UPDATE`,
            [orderId, restaurantId]
        );

        if (existingQr.rows.length) {
            const existing = existingQr.rows[0];

            await client.query('COMMIT');

            return {
                qr_id: existing.qr_id,
                order_id: orderId,
                amount: Number(existing.amount),
                qr_string: existing.qr_string,
                qr_image_url: existing.qr_image_url,
                expires_at: existing.expires_at,
                status: existing.status,
                reused: true,
            };
        }

        const qrId = `QR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        const result = await client.query(
            `INSERT INTO qr_payments
                (restaurant_id, order_id, qr_id, provider, amount, status, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'pending', NOW() + INTERVAL '10 minutes')
             RETURNING *`,
            [restaurantId, orderId, qrId, PAYMENT_CONFIG.provider, outstandingAmount]
        );
        const payment = result.rows[0];

        let providerData;
        try {
            providerData = await createQrWithProvider({
                qrId,
                amount: outstandingAmount,
                description: description || `Order #${orderId}`,
                restaurantId,
            });
        } catch (err) {
            console.warn('Provider failed, using manual fallback:', err.message);
            providerData = await buildManualQr(qrId, outstandingAmount, restaurantId);
        }

        await client.query(
            `UPDATE qr_payments
             SET qr_string = $1, qr_image_url = $2, provider_ref = $3, updated_at = NOW()
             WHERE id = $4`,
            [providerData.qrString, providerData.qrImageUrl, providerData.providerRef, payment.id]
        );

        await client.query('COMMIT');

        return {
            qr_id: qrId,
            order_id: orderId,
            amount: outstandingAmount,
            qr_string: providerData.qrString,
            qr_image_url: providerData.qrImageUrl,
            expires_at: payment.expires_at,
            status: 'pending',
            reused: false,
        };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
    } finally {
        client.release();
    }
}

/* ============================================================
   PROVIDER ADAPTER — bank API yahan aayegi
   ============================================================ */
async function createQrWithProvider({ qrId, amount, description, restaurantId }) {
    const provider = PAYMENT_CONFIG.provider;

    if (provider === 'manual') {
        return await buildManualQr(qrId, amount, restaurantId);
    }

    // Raast / PayFast code baad mein yahan add hoga
    throw new Error(`Unknown provider: ${provider}`);
}

/* ============================================================
   MANUAL QR — restaurant ke Raast string se
   ============================================================ */
async function buildManualQr(qrId, amount, restaurantId) {
    const r = await pool.query(
        `SELECT raast_qr_string FROM restaurants WHERE id = $1`,
        [restaurantId]
    );

    const staticQrString = r.rows[0]?.raast_qr_string || '';

    const qrString = staticQrString.trim()
        || `RAAST://PAY?amount=${amount}&ref=${qrId}`;

    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(qrString)}`;

    return { qrString, qrImageUrl, providerRef: null };
}

/* ============================================================
   GET STATUS (polling)
   ============================================================ */
async function getQrStatus(qrId, restaurantId) {
    const r = await pool.query(
        `SELECT status, paid_at, paid_amount, payment_method, provider_ref, expires_at
         FROM qr_payments
         WHERE qr_id = $1 AND restaurant_id = $2`,
        [qrId, restaurantId]
    );
    if (!r.rows.length) return { status: 'not_found' };
    const p = r.rows[0];

    if (p.status === 'pending' && new Date(p.expires_at) < new Date()) {
        await pool.query(`UPDATE qr_payments SET status = 'expired' WHERE qr_id = $1 AND restaurant_id = $2`, [qrId, restaurantId]);
        p.status = 'expired';
    }

    return {
        status: p.status,
        paid_at: p.paid_at,
        paid_amount: p.paid_amount,
        payment_method: p.payment_method,
        provider_ref: p.provider_ref,
        expires_at: p.expires_at,
    };
}

/* ============================================================
   ATOMIC QR SETTLEMENT
   QR payment + order payment MUST commit together.
   ============================================================ */
async function settleQrPayment({
    qrId,
    restaurantId = null,
    receivedAmount,
    paymentMethod = 'raast',
    paidAt = null,
    providerRef = null,
    rawResponse = null,
}) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Read the QR without locking first to discover its order. All
        // payment creation/settlement paths then lock rows in the same order:
        // order first, QR second. This avoids order↔QR deadlocks.
        const paymentLookup = await client.query(
            `SELECT qp.*, o.restaurant_id AS order_restaurant_id
             FROM qr_payments qp
             INNER JOIN orders o ON o.id = qp.order_id
             WHERE qp.qr_id = $1
               AND ($2::integer IS NULL OR qp.restaurant_id = $2)`,
            [qrId, restaurantId]
        );

        if (!paymentLookup.rows.length) {
            throw new Error('Payment reference not found');
        }

        let payment = paymentLookup.rows[0];
        const tenantId = Number(payment.order_restaurant_id);

        if (restaurantId !== null && tenantId !== Number(restaurantId)) {
            throw new Error('Payment does not belong to this restaurant');
        }

        // Lock the order before the QR row, matching createQrPayment().
        const orderResult = await client.query(
            `SELECT
                id,
                restaurant_id,
                total_amount,
                paid_amount,
                payment_status,
                status
             FROM orders
             WHERE id = $1
               AND restaurant_id = $2
             FOR UPDATE`,
            [payment.order_id, tenantId]
        );

        if (!orderResult.rows.length) {
            throw new Error('Order not found for this payment');
        }

        const order = orderResult.rows[0];

        // Re-read and lock the QR only after the order lock is held. Another
        // callback may have settled it between the initial lookup and lock.
        const lockedPaymentResult = await client.query(
            `SELECT *
             FROM qr_payments
             WHERE id = $1
               AND order_id = $2
               AND restaurant_id = $3
             FOR UPDATE`,
            [payment.id, order.id, tenantId]
        );

        if (!lockedPaymentResult.rows.length) {
            throw new Error('Payment reference not found for this order');
        }

        payment = lockedPaymentResult.rows[0];

        // A replayed webhook/manual-confirm is harmless.
        if (payment.status !== 'pending') {
            await client.query('COMMIT');
            return {
                duplicate: true,
                qrPayment: payment,
                order: null,
            };
        }

        const expectedQrAmount = Number(payment.amount);
        const amount = receivedAmount === null || receivedAmount === undefined
            ? expectedQrAmount
            : Number(receivedAmount);

        if (!Number.isFinite(amount) || amount !== expectedQrAmount) {
            throw new Error('Payment amount mismatch');
        }

        if (payment.expires_at && new Date(payment.expires_at) < new Date()) {
            await client.query(
                `UPDATE qr_payments
                 SET status = 'expired',
                     raw_response = $1,
                     updated_at = NOW()
                 WHERE id = $2 AND status = 'pending'`,
                [rawResponse, payment.id]
            );
            await client.query('COMMIT');
            throw new Error('Payment QR has expired');
        }

        if (order.status === 'cancelled') {
            // The QR may have been scanned before cancellation. Never settle
            // it after the order has been cancelled.
            await client.query(
                `UPDATE qr_payments
                 SET status = 'cancelled',
                     updated_at = NOW()
                 WHERE id = $1
                   AND status = 'pending'`,
                [payment.id]
            );
            await client.query('COMMIT');
            throw new Error('Cannot accept payment for a cancelled order');
        }

        if (order.payment_status === 'paid') {
            throw new Error('Order is already paid');
        }

        const totalAmount = Number(order.total_amount || 0);
        const currentPaidAmount = Number(order.paid_amount || 0);
        const outstandingAmount = Number(
            (totalAmount - currentPaidAmount).toFixed(2)
        );

        if (
            !Number.isFinite(outstandingAmount) ||
            outstandingAmount <= 0
        ) {
            throw new Error('No outstanding amount remains for this order');
        }

        if (amount !== outstandingAmount) {
            throw new Error(
                'QR amount no longer matches the order outstanding amount'
            );
        }

        const finalPaidAmount = Number(
            (currentPaidAmount + amount).toFixed(2)
        );

        // Keep the QR payment and order payment in the SAME transaction.
        await client.query(
            `UPDATE qr_payments
             SET status = 'paid',
                 paid_at = $1,
                 paid_amount = $2,
                 payment_method = $3,
                 provider_ref = $4,
                 raw_response = $5,
                 updated_at = NOW()
             WHERE id = $6
               AND status = 'pending'`,
            [
                paidAt || new Date(),
                amount.toFixed(2),
                paymentMethod,
                providerRef,
                rawResponse,
                payment.id
            ]
        );

        const orderUpdate = await client.query(
            `UPDATE orders
             SET payment_status = 'paid',
                 payment_method = $3,
                 paid_amount = $4,
                 paid_at = $5
             WHERE id = $1
               AND restaurant_id = $2
               AND payment_status = 'unpaid'
             RETURNING *`,
            [
                order.id,
                tenantId,
                paymentMethod,
                finalPaidAmount.toFixed(2),
                paidAt || new Date()
            ]
        );

        if (!orderUpdate.rows.length) {
            throw new Error('Order payment could not be finalized');
        }

        // Immutable accounting event for the successful QR settlement.
        await client.query(
            `
            INSERT INTO payment_transactions
            (
                restaurant_id,
                order_id,
                qr_payment_id,
                amount,
                payment_method,
                status,
                provider_ref,
                reference,
                metadata
            )
            VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8::jsonb)
            `,
            [
                tenantId,
                order.id,
                payment.id,
                amount.toFixed(2),
                paymentMethod,
                providerRef,
                qrId,
                JSON.stringify({
                    source: 'qr_payment',
                    provider: payment.provider || null,
                    expected_qr_amount: expectedQrAmount
                })
            ]
        );

        await client.query('COMMIT');

        return {
            duplicate: false,
            qrPayment: {
                ...payment,
                status: 'paid',
                paid_amount: amount.toFixed(2),
                payment_method: paymentMethod,
                provider_ref: providerRef,
            },
            order: orderUpdate.rows[0],
            restaurantId: tenantId,
        };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
    } finally {
        client.release();
    }
}

/* ============================================================
   MANUAL CONFIRM
   ============================================================ */
async function manualConfirmPayment(qrId, staffUserId, restaurantId) {
    const result = await settleQrPayment({
        qrId,
        restaurantId,
        receivedAmount: null,
        paymentMethod: 'manual_confirm',
    });

    return result.qrPayment;
}

/* ============================================================
   WEBHOOK — bank yahan call karega
   ============================================================ */
async function handleWebhook({ headers, body, rawBody = null }) {
    if (!verifyWebhookSignature(headers, body, rawBody)) {
        throw new Error('Invalid signature');
    }

    const {
        reference,
        transaction_id,
        amount,
        status,
        payment_method,
        paid_at
    } = body;

    if (!reference) {
        throw new Error('Missing reference in webhook');
    }

    if (status === 'SUCCESS' || status === 'PAID') {
        const result = await settleQrPayment({
            qrId: reference,
            receivedAmount: amount,
            paymentMethod: payment_method || 'raast',
            paidAt: paid_at || new Date(),
            providerRef: transaction_id || null,
            rawResponse: body,
        });

        if (global.io && result.restaurantId) {
            global.io
                .to(`restaurant_${result.restaurantId}`)
                .emit('qr_payment_update', {
                    qr_id: reference,
                    status: 'PAID',
                    order_id: result.order?.id || null,
                });
        }

        return {
            ok: true,
            duplicate: result.duplicate
        };
    }

    if (status === 'FAILED') {
        const result = await pool.query(
            `UPDATE qr_payments qp
             SET status = 'cancelled',
                 raw_response = $1,
                 updated_at = NOW()
             FROM orders o
             WHERE qp.qr_id = $2
               AND qp.order_id = o.id
               AND qp.status = 'pending'
             RETURNING qp.restaurant_id, qp.order_id`,
            [body, reference]
        );

        if (global.io && result.rows.length) {
            global.io
                .to(`restaurant_${result.rows[0].restaurant_id}`)
                .emit('qr_payment_update', {
                    qr_id: reference,
                    status: 'FAILED',
                    order_id: result.rows[0].order_id,
                });
        }
    }

    return { ok: true };
}

function verifyWebhookSignature(headers, body, rawBody = null) {
    if (PAYMENT_CONFIG.provider === 'manual') {
        const secret = process.env.PAYMENT_WEBHOOK_SECRET;
        if (!secret) return false;

        const signature = headers['x-webhook-signature'] || headers['x-signature'];
        if (!signature) return false;

        const payload = rawBody && Buffer.isBuffer(rawBody)
            ? rawBody
            : (typeof body === 'string' ? body : JSON.stringify(body));
        const expected = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex');

        const provided = String(signature).replace(/^sha256=/i, '').trim();
        const expectedBuf = Buffer.from(expected, 'utf8');
        const providedBuf = Buffer.from(provided, 'utf8');

        return expectedBuf.length === providedBuf.length &&
            crypto.timingSafeEqual(expectedBuf, providedBuf);
    }

    return false;
}

module.exports = {
    createQrPayment,
    getQrStatus,
    manualConfirmPayment,
    handleWebhook,
};