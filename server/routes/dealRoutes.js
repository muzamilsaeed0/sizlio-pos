const express = require('express');

const router = express.Router();

const {
  authMiddleware,
  authorize
} = require('../middleware/authMiddleware');

const {
  getDeals,
  getDeal,
  createDeal,
  updateDeal,
  removeDeal
} = require('../controllers/dealController');

router.get(
  '/',
  authMiddleware,
  getDeals
);

router.get(
  '/:id',
  authMiddleware,
  getDeal
);

router.post(
  '/',
  authMiddleware,
  authorize('manager', 'counter'),
  createDeal
);

router.put(
  '/:id',
  authMiddleware,
  authorize('manager', 'counter'),
  updateDeal
);

router.delete(
  '/:id',
  authMiddleware,
  authorize('manager', 'counter'),
  removeDeal
);

module.exports = router;
