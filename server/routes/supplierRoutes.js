const express = require('express');
const router = express.Router();
const controller = require('../controllers/supplierController');
const { authMiddleware, authorize } = require('../middleware/authMiddleware');

router.use(authMiddleware);

// Suppliers
router.get('/', authorize('manager'), controller.list);
router.post('/', authorize('manager'), controller.create);
router.get('/aging', authorize('manager'), controller.getAging);              // must be BEFORE /:id
router.get('/:id', authorize('manager'), controller.getOne);
router.put('/:id', authorize('manager'), controller.update);
router.delete('/:id', authorize('manager'), controller.remove);

// Ledger
router.get('/:id/ledger', authorize('manager'), controller.getLedger);

// Purchases
router.get('/:id/purchases', authorize('manager'), controller.listPurchases);
router.post('/:id/purchases', authorize('manager'), controller.createPurchase);
router.delete('/purchases/:purchaseId', authorize('manager'), controller.deletePurchase);

// Payments
router.get('/:id/payments', authorize('manager'), controller.listPayments);
router.post('/:id/payments', authorize('manager'), controller.createPayment);
router.delete('/payments/:paymentId', authorize('manager'), controller.deletePayment);

module.exports = router;
