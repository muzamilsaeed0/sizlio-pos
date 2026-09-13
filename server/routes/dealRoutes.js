const express = require('express');

const router = express.Router();

const {
  authMiddleware
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
  createDeal
);

router.put(
  '/:id',
  authMiddleware,
  updateDeal
);

router.delete(
  '/:id',
  authMiddleware,
  removeDeal
);

module.exports = router;
