const express = require('express');
const router = express.Router();
const fbrController = require('../controllers/fbrController');
const { authMiddleware } = require('../middleware/authMiddleware');

// Public routes (agar koi ho)
// router.get('/public-something', ...);

// Protected routes
router.get('/pending', authMiddleware, fbrController.getPendingInvoices);
router.get('/config/:restaurantId', authMiddleware, fbrController.getConfig);
router.post('/config/:restaurantId', authMiddleware, fbrController.saveConfig);
router.post('/submit/:orderId', authMiddleware, fbrController.submitOrderInvoice);
router.get('/status/:orderId', authMiddleware, fbrController.getInvoiceStatus);
router.post('/retry', authMiddleware, fbrController.retryNow);

module.exports = router;