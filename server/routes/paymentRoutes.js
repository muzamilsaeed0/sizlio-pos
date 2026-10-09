const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');
const { authMiddleware, authorize } = require('../middleware/authMiddleware');
const pool = require('../config/db');

/* Create QR */
router.post('/qr/create', authMiddleware, authorize('manager', 'counter'), async (req, res) => {
    try {
        const { order_id, amount, description } = req.body;
        const restaurantId = req.user.restaurant_id;
        if (!order_id || !amount) {
            return res.status(400).json({ success: false, message: 'order_id and amount required' });
        }
        const result = await paymentService.createQrPayment({
            restaurantId, orderId: order_id, amount, description,
        });
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('QR create error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/* Poll status */
router.get('/qr/status/:qrId', authMiddleware, authorize('manager', 'counter'), async (req, res) => {
    try {
        const result = await paymentService.getQrStatus(req.params.qrId, req.user.restaurant_id);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* Manual confirm */
router.post('/qr/manual-confirm/:qrId', authMiddleware, authorize('manager', 'counter'), async (req, res) => {
    try {
        const result = await paymentService.manualConfirmPayment(req.params.qrId, req.user.id, req.user.restaurant_id);
        if (global.io) {
            global.io
                .to(`restaurant_${req.user.restaurant_id}`)
                .emit('qr_payment_update', {
                    qr_id: req.params.qrId,
                    status: 'paid',
                    order_id: result?.order_id || null
                });
        }
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

/* Cancel */
router.post('/qr/cancel/:qrId', authMiddleware, authorize('manager', 'counter'), async (req, res) => {
    try {
        await pool.query(
            `UPDATE qr_payments SET status='cancelled', updated_at=NOW()
             WHERE qr_id=$1 AND restaurant_id=$2 AND status='pending'`,
            [req.params.qrId, req.user.restaurant_id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* Webhook — no auth, bank calls this */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        // Signature verification must use the exact bytes received from the
        // provider. JSON.parse/stringify can change whitespace or serialization.
        const rawBody = Buffer.isBuffer(req.body) ? Buffer.from(req.body) : null;
        let body;
        try {
            body = rawBody ? JSON.parse(rawBody.toString('utf8')) : req.body;
        } catch {
            return res.status(400).json({ ok: false, message: 'Invalid JSON webhook payload' });
        }

        const result = await paymentService.handleWebhook({
            headers: req.headers,
            body,
            rawBody
        });
        res.json(result);
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(400).json({ ok: false, message: err.message });
    }
});

module.exports = router;