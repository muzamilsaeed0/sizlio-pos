const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const pool = require('../config/db');

const {
    authMiddleware,
    authorize
} = require('../middleware/authMiddleware');

// Setup VAPID
webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@sizlio.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

// =====================================================
// GET VAPID PUBLIC KEY (frontend)
// =====================================================

router.get('/vapid-public-key', (req, res) => {
    res.json({
        success: true,
        publicKey: process.env.VAPID_PUBLIC_KEY
    });
});

// =====================================================
// SAVE SUBSCRIPTION (frontend → backend)
// =====================================================

router.post(
    '/subscribe',
    authMiddleware,
    authorize('delivery', 'manager', 'counter', 'kitchen', 'waiter'),
    async (req, res) => {
        try {
            const subscription = req.body;
            const userId = req.user.id;
            const restaurantId = req.user.restaurant_id;

            if (!subscription || !subscription.endpoint) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid subscription'
                });
            }

            // Save or update subscription
            await pool.query(
                `
                INSERT INTO push_subscriptions
                (user_id, restaurant_id, endpoint, keys, created_at, updated_at)
                VALUES ($1, $2, $3, $4, NOW(), NOW())
                ON CONFLICT (endpoint) 
                DO UPDATE SET
                    user_id = EXCLUDED.user_id,
                    restaurant_id = EXCLUDED.restaurant_id,
                    keys = EXCLUDED.keys,
                    updated_at = NOW()
                `,
                [
                    userId,
                    restaurantId,
                    subscription.endpoint,
                    JSON.stringify(subscription.keys)
                ]
            );

            res.json({ success: true });

        } catch(err) {
            console.error('Save subscription error:', err);
            res.status(500).json({ 
                success: false, 
                message: 'Server error' 
            });
        }
    }
);

// =====================================================
// SEND PUSH (helper function - called from order controller)
// =====================================================

async function sendPushToUser(userId, payload) {
    try {
        const result = await pool.query(
            `SELECT endpoint, keys FROM push_subscriptions 
             WHERE user_id = $1`,
            [userId]
        );

        const subs = result.rows;
        const dead = [];

        for (const sub of subs) {
            const pushSub = {
                endpoint: sub.endpoint,
                keys: typeof sub.keys === 'string' 
                    ? JSON.parse(sub.keys) 
                    : sub.keys
            };

            try {
                await webpush.sendNotification(
                    pushSub,
                    JSON.stringify(payload)
                );
            } catch(err) {
                console.error('Push send failed:', err.statusCode, err.message);
                
                // 404/410 = subscription expired, remove it
                if (err.statusCode === 404 || err.statusCode === 410) {
                    dead.push(sub.endpoint);
                }
            }
        }

        // Cleanup dead subscriptions
        if (dead.length) {
            await pool.query(
                `DELETE FROM push_subscriptions 
                 WHERE endpoint = ANY($1::text[])`,
                [dead]
            );
        }

    } catch(err) {
        console.error('sendPushToUser error:', err);
    }
}

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;