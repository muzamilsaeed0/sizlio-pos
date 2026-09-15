const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware } = require('../middleware/authMiddleware');

/* Get Raast QR */
router.get('/raast-qr', authMiddleware, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT raast_qr_string FROM restaurants WHERE id = $1`,
            [req.user.restaurant_id]
        );
        res.json({
            success: true,
            data: { raast_qr_string: r.rows[0]?.raast_qr_string || '' }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* Save Raast QR */
router.put('/raast-qr', authMiddleware, async (req, res) => {
    try {
        const { raast_qr_string } = req.body;
        await pool.query(
            `UPDATE restaurants SET raast_qr_string = $1 WHERE id = $2`,
            [raast_qr_string || '', req.user.restaurant_id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;