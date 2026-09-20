const express = require('express');
const router = express.Router();
const fbrController = require('../controllers/fbrController');

router.get('/pending', fbrController.getPendingInvoices);      
router.get('/config/:restaurantId', fbrController.getConfig);
router.post('/config/:restaurantId', fbrController.saveConfig);
router.post('/submit/:orderId', fbrController.submitOrderInvoice);
router.get('/status/:orderId', fbrController.getInvoiceStatus);
router.post('/retry', fbrController.retryNow);

module.exports = router;