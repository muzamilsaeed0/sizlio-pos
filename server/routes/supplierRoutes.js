const express = require('express');
const router = express.Router();
const controller = require('../controllers/supplierController');
const { authMiddleware } = require('../middleware/authMiddleware');

router.use(authMiddleware);

// Suppliers
router.get('/', controller.list);
router.post('/', controller.create);
router.get('/aging', controller.getAging);              // must be BEFORE /:id
router.get('/:id', controller.getOne);
router.put('/:id', controller.update);
router.delete('/:id', controller.remove);

// Ledger
router.get('/:id/ledger', controller.getLedger);

// Purchases
router.get('/:id/purchases', controller.listPurchases);
router.post('/:id/purchases', controller.createPurchase);
router.delete('/purchases/:purchaseId', controller.deletePurchase);

// Payments
router.get('/:id/payments', controller.listPayments);
router.post('/:id/payments', controller.createPayment);
router.delete('/payments/:paymentId', controller.deletePayment);

module.exports = router;
