const express = require('express');
const router = express.Router();
const controller = require('../controllers/supplierController');
const { authMiddleware, authorize } = require('../middleware/authMiddleware');

router.use(authMiddleware);

// Suppliers
router.get('/', authorize('manager', 'counter'), controller.list);
router.post('/', authorize('manager', 'counter'), controller.create);
router.get('/aging', authorize('manager', 'counter'), controller.getAging);              // must be BEFORE /:id
router.get('/:id', authorize('manager', 'counter'), controller.getOne);
router.put('/:id', authorize('manager', 'counter'), controller.update);
router.delete('/:id', authorize('manager', 'counter'), controller.remove);

// Ledger
router.get('/:id/ledger', authorize('manager', 'counter'), controller.getLedger);

// Purchases
router.get('/:id/purchases', authorize('manager', 'counter'), controller.listPurchases);
router.post('/:id/purchases', authorize('manager', 'counter'), controller.createPurchase);
router.delete('/purchases/:purchaseId', authorize('manager', 'counter'), controller.deletePurchase);

// Payments
router.get('/:id/payments', authorize('manager', 'counter'), controller.listPayments);
router.post('/:id/payments', authorize('manager', 'counter'), controller.createPayment);
router.delete('/payments/:paymentId', authorize('manager', 'counter'), controller.deletePayment);

module.exports = router;
