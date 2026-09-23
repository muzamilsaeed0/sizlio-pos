const express = require('express');
const router = express.Router();
const fbrController = require('../controllers/fbrController');
const { authMiddleware, authorize } = require('../middleware/authMiddleware');

// ── Config (manager / super_admin only) ──────────────────────────────
router.get(
  '/config/:restaurantId',
  authMiddleware,
  authorize('manager', 'super_admin'),
  fbrController.getConfig
);

router.post(
  '/config/:restaurantId',
  authMiddleware,
  authorize('manager', 'super_admin'),
  fbrController.saveConfig
);

// ── Pending list + manual retry queue (manager / super_admin) ────────
router.get(
  '/pending',
  authMiddleware,
  authorize('manager', 'super_admin'),
  fbrController.getPendingInvoices
);

router.post(
  '/retry',
  authMiddleware,
  authorize('manager', 'super_admin'),
  fbrController.retryNow
);

// ── Per-order submit / status (manager, counter, super_admin) ────────
router.post(
  '/submit/:orderId',
  authMiddleware,
  authorize('manager', 'counter', 'super_admin'),
  fbrController.submitOrderInvoice
);

router.get(
  '/status/:orderId',
  authMiddleware,
  authorize('manager', 'counter', 'super_admin'),
  fbrController.getInvoiceStatus
);

module.exports = router;