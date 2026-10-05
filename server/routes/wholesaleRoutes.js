const express = require('express');
const router = express.Router();
const { authMiddleware, authorize } = require('../middleware/authMiddleware');
const c = require('../controllers/wholesaleController');

// counter / manager of that shop
const staff = authorize('counter', 'manager', 'wholesale');

router.get('/products', authMiddleware, staff, c.getProducts);
router.post('/products', authMiddleware, staff, c.addProduct);
router.put('/products/:id', authMiddleware, staff, c.editProduct);
router.delete('/products/:id', authMiddleware, staff, c.removeProduct);

router.post('/sales', authMiddleware, staff, c.createSale);
router.get('/invoices', authMiddleware, staff, c.getInvoices);

module.exports = router;