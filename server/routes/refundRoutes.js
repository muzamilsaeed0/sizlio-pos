const express = require('express');
const router = express.Router();
const { authMiddleware, authorize } = require('../middleware/authMiddleware');
const {
  requestRefund,
  listRefunds,
  approve,
  reject,
} = require('../controllers/refundController');

// List refunds (manager / counter)
router.get(
  '/',
  authMiddleware,
  authorize('manager', 'counter'),
  listRefunds
);

// Request refund (counter / manager / waiter)
router.post(
  '/',
  authMiddleware,
  authorize('counter', 'manager', 'waiter'),
  requestRefund
);

// Manager approve
router.put(
  '/:id/approve',
  authMiddleware,
  authorize('manager'),
  approve
);

// Manager reject
router.put(
  '/:id/reject',
  authMiddleware,
  authorize('manager'),
  reject
);

module.exports = router;
