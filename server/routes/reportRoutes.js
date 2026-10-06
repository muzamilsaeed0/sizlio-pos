const express = require('express');
const router = express.Router();

const { authMiddleware, authorize } = require('../middleware/authMiddleware');

const {
  summary,
  salesDetails,
  topItems,
  paymentSummary,
  salesChart
} = require('../controllers/reportController');


router.get('/summary', authMiddleware, authorize('manager', 'counter'), summary);


router.get('/sales/custom', authMiddleware, authorize('manager', 'counter'), salesDetails);



router.get('/sales', authMiddleware, salesDetails);

router.get(
  '/top-items',
  authMiddleware,
  authorize('manager', 'counter'),
  topItems
);

router.get('/payment-summary', authMiddleware, authorize('manager', 'counter'), paymentSummary);

router.get('/sales-chart', authMiddleware, authorize('manager', 'counter'), salesChart);


module.exports = router;