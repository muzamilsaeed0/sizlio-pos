const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authMiddleware');

const {
  summary,
  salesDetails,
  topItems,
  paymentSummary,
  salesChart
} = require('../controllers/reportController');


router.get('/summary', authMiddleware, summary);


router.get('/sales/custom', authMiddleware, salesDetails);



router.get('/sales', authMiddleware, salesDetails);

router.get(
  '/top-items',
  authMiddleware,
  topItems
);

router.get('/payment-summary', authMiddleware, paymentSummary);

router.get('/sales-chart', authMiddleware, salesChart);


module.exports = router;