const fbrModel = require('../models/fbrModel');
const fbrService = require('../services/fbrService');

// ADJUST: import whatever your existing orderModel uses to fetch an order
// + its line items. Replace these two lines with the real function names
// from server/models/orderModel.js.
const { getOrderById, getOrderItemsByOrderId } = require('../models/orderModel');

/** POST /fbr/config/:restaurantId — save a restaurant's FBR credentials (admin/manager only). */
exports.saveConfig = async (req, res) => {
  try {
    const { restaurantId } = req.params;

    // ✅ SAFETY: agar body undefined ho to empty object use karo
    const body = req.body || {};

    console.log('📥 saveConfig body:', body); // debug ke liye

    const saved = await fbrModel.saveFbrConfig(restaurantId, body);
    res.json({ success: true, restaurant: saved });
  } catch (err) {
    console.error('saveConfig:', err);
    res.status(500).json({ success: false, message: 'Could not save FBR config' });
  }
};

/** GET /fbr/config/:restaurantId — fetch current FBR settings (mask the token before returning). */
exports.getConfig = async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const cfg = await fbrModel.getFbrConfig(restaurantId);
    if (!cfg) return res.status(404).json({ success: false, message: 'Restaurant not found' });
    res.json({
      success: true,
      config: { ...cfg, fbr_api_token: cfg.fbr_api_token ? '••••••••' : null },
    });
  } catch (err) {
    console.error('getConfig:', err);
    res.status(500).json({ success: false, message: 'Could not fetch FBR config' });
  }
};

/** POST /fbr/submit/:orderId — manually (re)submit a specific order's invoice. */
exports.submitOrderInvoice = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const orderItems = await getOrderItemsByOrderId(orderId);
    const result = await fbrService.submitInvoiceForOrder(order, orderItems);
    res.json(result);
  } catch (err) {
    console.error('submitOrderInvoice:', err);
    res.status(500).json({ success: false, message: 'FBR submission failed', error: err.message });
  }
};

/** GET /fbr/status/:orderId — check whether an order's invoice went through, and its QR/invoice number. */
exports.getInvoiceStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const invoice = await fbrModel.getInvoiceByOrder(orderId);
    if (!invoice) return res.status(404).json({ success: false, message: 'No FBR invoice found for this order' });
    res.json({ success: true, invoice });
  } catch (err) {
    console.error('getInvoiceStatus:', err);
    res.status(500).json({ success: false, message: 'Could not fetch invoice status' });
  }
};

/** POST /fbr/retry — manually trigger the retry queue (also runs automatically via fbrRetryWorker). */
exports.retryNow = async (req, res) => {
  try {
    const results = await fbrService.retryPendingInvoices();
    res.json({ success: true, results });
  } catch (err) {
    console.error('retryNow:', err);
    res.status(500).json({ success: false, message: 'Retry run failed' });
  }
};

/** GET /fbr/pending — list pending/failed FBR invoices for this restaurant. */
exports.getPendingInvoices = async (req, res) => {
  try {
    const restaurantId = Number(req.user?.restaurant_id);

    if (!Number.isInteger(restaurantId) || restaurantId <= 0) {
      return res.status(401).json({
        success: false,
        message: 'Restaurant information is missing',
      });
    }

    const invoices = await fbrModel.getPendingInvoicesForRestaurant(restaurantId);

    return res.json({
      success: true,
      count: invoices.length,
      invoices,
    });
  } catch (err) {
    console.error('getPendingInvoices:', err);
    return res.status(500).json({
      success: false,
      message: 'Could not fetch pending invoices',
    });
  }
};
