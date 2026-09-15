const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');
const { authMiddleware } = require('../middleware/authMiddleware');
const pool = require('../config/db');

/* Create QR */
router.post('/qr/create', authMiddleware, async (req, res) => {
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
router.get('/qr/status/:qrId', authMiddleware, async (req, res) => {
    try {
        const result = await paymentService.getQrStatus(req.params.qrId);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* Manual confirm */
router.post('/qr/manual-confirm/:qrId', authMiddleware, async (req, res) => {
    try {
        const result = await paymentService.manualConfirmPayment(req.params.qrId, req.user.id);
        if (global.io) global.io.emit('qr_payment_update', { qr_id: req.params.qrId, status: 'paid' });
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

/* Cancel */
router.post('/qr/cancel/:qrId', authMiddleware, async (req, res) => {
    try {
        await pool.query(
            `UPDATE qr_payments SET status='cancelled', updated_at=NOW()
             WHERE qr_id=$1 AND status='pending'`,
            [req.params.qrId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* Webhook — no auth, bank calls this */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        let body;
        try { body = JSON.parse(req.body.toString()); } catch { body = req.body; }
        const result = await paymentService.handleWebhook({ headers: req.headers, body });
        res.json(result);
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(400).json({ ok: false, message: err.message });
    }
});

module.exports = router;