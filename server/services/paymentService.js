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
            `SELECT id, total_amount, paid_amount, payment_status
             FROM orders
             WHERE id = $1 AND restaurant_id = $2
             FOR UPDATE`,
            [orderId, restaurantId]
        );

        if (!orderCheck.rows.length) {
            throw new Error('Order not found for this restaurant');
        }

        const order = orderCheck.rows[0];

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
   MANUAL CONFIRM
   ============================================================ */
async function manualConfirmPayment(qrId, staffUserId, restaurantId) {
    const r = await pool.query(
        `UPDATE qr_payments
         SET status = 'paid', paid_at = NOW(), paid_amount = amount,
             payment_method = 'manual_confirm', updated_at = NOW()
         WHERE qr_id = $1 AND restaurant_id = $2 AND status = 'pending'
         RETURNING *`,
        [qrId, restaurantId]
    );
    if (!r.rows.length) throw new Error('QR not found or already processed');
    return r.rows[0];
}

/* ============================================================
   WEBHOOK — bank yahan call karega
   ============================================================ */
async function handleWebhook({ headers, body }) {
    if (!verifyWebhookSignature(headers, body)) {
        throw new Error('Invalid signature');
    }
    const { reference, transaction_id, amount, status, payment_method, paid_at } = body;
    if (!reference) throw new Error('Missing reference in webhook');

    if (status === 'SUCCESS' || status === 'PAID') {
        const payment = await pool.query(
            `SELECT id, amount, status, expires_at
             FROM qr_payments
             WHERE qr_id = $1
             LIMIT 1`,
            [reference]
        );

        if (!payment.rows.length) {
            throw new Error('Payment reference not found');
        }

        const current = payment.rows[0];

        // Ignore duplicate/replayed webhooks after the payment is already processed.
        if (current.status !== 'pending') {
            return { ok: true, duplicate: true };
        }

        // Never mark a payment as paid when the provider-reported amount differs.
        const expectedAmount = Number(current.amount);
        const receivedAmount = Number(amount);
        if (!Number.isFinite(receivedAmount) || receivedAmount !== expectedAmount) {
            throw new Error('Webhook amount mismatch');
        }

        // Do not accept a successful webhook for an expired QR payment.
        if (current.expires_at && new Date(current.expires_at) < new Date()) {
            await pool.query(
                `UPDATE qr_payments
                 SET status = 'expired', raw_response = $1, updated_at = NOW()
                 WHERE id = $2 AND status = 'pending'`,
                [body, current.id]
            );
            throw new Error('Payment QR has expired');
        }

        await pool.query(
            `UPDATE qr_payments
             SET status = 'paid', paid_at = $1, paid_amount = $2,
                 payment_method = $3, provider_ref = $4, raw_response = $5, updated_at = NOW()
             WHERE id = $6 AND status = 'pending' AND amount = $7`,
            [paid_at || new Date(), receivedAmount, payment_method || 'raast', transaction_id, body, current.id, expectedAmount]
        );
    } else if (status === 'FAILED') {
        await pool.query(
            `UPDATE qr_payments
             SET status = 'cancelled', raw_response = $1, updated_at = NOW()
             WHERE qr_id = $2 AND status = 'pending'`,
            [body, reference]
        );
    }

    if (global.io) {
        global.io.emit('qr_payment_update', { qr_id: reference, status });
    }
    return { ok: true };
}

function verifyWebhookSignature(headers, body) {
    if (PAYMENT_CONFIG.provider === 'manual') {
        const secret = process.env.PAYMENT_WEBHOOK_SECRET;
        if (!secret) return false;

        const signature = headers['x-webhook-signature'] || headers['x-signature'];
        if (!signature) return false;

        const payload = typeof body === 'string' ? body : JSON.stringify(body);
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