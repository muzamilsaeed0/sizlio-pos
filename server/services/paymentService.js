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
    const qrId = `QR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const result = await pool.query(
        `INSERT INTO qr_payments
            (restaurant_id, order_id, qr_id, provider, amount, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', NOW() + INTERVAL '10 minutes')
         RETURNING *`,
        [restaurantId, orderId, qrId, PAYMENT_CONFIG.provider, amount]
    );
    const payment = result.rows[0];

    let providerData;
    try {
        providerData = await createQrWithProvider({
            qrId, amount,
            description: description || `Order #${orderId}`,
            restaurantId,
        });
    } catch (err) {
        console.warn('Provider failed, using manual fallback:', err.message);
        providerData = await buildManualQr(qrId, amount, restaurantId);
    }

    await pool.query(
        `UPDATE qr_payments
         SET qr_string = $1, qr_image_url = $2, provider_ref = $3, updated_at = NOW()
         WHERE id = $4`,
        [providerData.qrString, providerData.qrImageUrl, providerData.providerRef, payment.id]
    );

    return {
        qr_id: qrId,
        order_id: orderId,
        amount,
        qr_string: providerData.qrString,
        qr_image_url: providerData.qrImageUrl,
        expires_at: payment.expires_at,
        status: 'pending',
    };
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
async function getQrStatus(qrId) {
    const r = await pool.query(
        `SELECT status, paid_at, paid_amount, payment_method, provider_ref, expires_at
         FROM qr_payments WHERE qr_id = $1`,
        [qrId]
    );
    if (!r.rows.length) return { status: 'not_found' };
    const p = r.rows[0];

    if (p.status === 'pending' && new Date(p.expires_at) < new Date()) {
        await pool.query(`UPDATE qr_payments SET status = 'expired' WHERE qr_id = $1`, [qrId]);
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
async function manualConfirmPayment(qrId, staffUserId) {
    const r = await pool.query(
        `UPDATE qr_payments
         SET status = 'paid', paid_at = NOW(), paid_amount = amount,
             payment_method = 'manual_confirm', updated_at = NOW()
         WHERE qr_id = $1 AND status = 'pending'
         RETURNING *`,
        [qrId]
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
        await pool.query(
            `UPDATE qr_payments
             SET status = 'paid', paid_at = $1, paid_amount = $2,
                 payment_method = $3, provider_ref = $4, raw_response = $5, updated_at = NOW()
             WHERE qr_id = $6 AND status = 'pending'`,
            [paid_at || new Date(), amount, payment_method || 'raast', transaction_id, body, reference]
        );
    } else if (status === 'FAILED') {
        await pool.query(
            `UPDATE qr_payments SET status = 'cancelled', raw_response = $1 WHERE qr_id = $2`,
            [body, reference]
        );
    }

    if (global.io) {
        global.io.emit('qr_payment_update', { qr_id: reference, status });
    }
    return { ok: true };
}

function verifyWebhookSignature(headers, body) {
    if (PAYMENT_CONFIG.provider === 'manual') return true;
    return true;
}

module.exports = {
    createQrPayment,
    getQrStatus,
    manualConfirmPayment,
    handleWebhook,
};