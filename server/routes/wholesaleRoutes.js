const express = require('express');
const router = express.Router();
const { authMiddleware, authorize } = require('../middleware/authMiddleware');
const c = require('../controllers/wholesaleController');

const staff = authorize('counter', 'manager');

router.get('/products', authMiddleware, staff, c.getProducts);
router.post('/products', authMiddleware, staff, c.addProduct);
router.put('/products/:id', authMiddleware, staff, c.editProduct);
router.delete('/products/:id', authMiddleware, staff, c.removeProduct);
router.post('/products/:id/stock', authMiddleware, staff, c.adjustStock);

router.post('/sales', authMiddleware, staff, c.createSale);
router.get('/invoices', authMiddleware, staff, c.getInvoices);
router.get('/invoices/:id', authMiddleware, staff, c.getInvoice);
router.get('/reports/today', authMiddleware, staff, c.getTodaySummary);

module.exports = router;