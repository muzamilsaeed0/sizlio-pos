const fbrModel = require('../models/fbrModel');
const fbrService = require('../services/fbrService');
const { getOrderById, getOrderItemsByOrderId } = require('../models/orderModel');

/* =====================================================
   HELPERS
===================================================== */

function getRestaurantIdFromUser(req) {
  const id = Number(req.user?.restaurant_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function assertRestaurantAccess(req, restaurantIdParam) {
  const userRestaurantId = getRestaurantIdFromUser(req);
  const targetId = Number(restaurantIdParam);

  if (!userRestaurantId) {
    return { ok: false, status: 401, message: 'Restaurant information is missing' };
  }
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return { ok: false, status: 400, message: 'Invalid restaurant id' };
  }
  // super_admin allow karna ho to yahan role check add karo
  if (req.user?.role !== 'super_admin' && userRestaurantId !== targetId) {
    return { ok: false, status: 403, message: 'Not allowed for this restaurant' };
  }
  return { ok: true, restaurantId: targetId };
}

/* =====================================================
   CONFIG
===================================================== */

/** POST /fbr/config/:restaurantId */
exports.saveConfig = async (req, res) => {
  try {
    const access = assertRestaurantAccess(req, req.params.restaurantId);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const body = req.body || {};
    const existing = await fbrModel.getFbrConfig(access.restaurantId);

    // Token mask / empty → purana token mat chhedo
    let apiToken = body.fbr_api_token;
    if (
      apiToken == null ||
      String(apiToken).trim() === '' ||
      String(apiToken).includes('••') ||
      String(apiToken).includes('****')
    ) {
      apiToken = existing?.fbr_api_token || null;
    }

    const cfg = {
      fbr_enabled: !!body.fbr_enabled,
      fbr_pos_registration_no: body.fbr_pos_registration_no || null,
      fbr_api_token: apiToken,
      fbr_seller_ntn_cnic: body.fbr_seller_ntn_cnic || null,
      fbr_seller_business_name: body.fbr_seller_business_name || null,
      fbr_seller_province: body.fbr_seller_province || null,
      fbr_seller_address: body.fbr_seller_address || null,
      fbr_environment: body.fbr_environment === 'production' ? 'production' : 'sandbox',
    };

    if (cfg.fbr_enabled) {
      if (!cfg.fbr_api_token) {
        return res.status(400).json({
          success: false,
          message: 'API token required when FBR is enabled',
        });
      }
      if (!cfg.fbr_seller_ntn_cnic || !cfg.fbr_seller_business_name) {
        return res.status(400).json({
          success: false,
          message: 'Seller NTN and business name are required when FBR is enabled',
        });
      }
    }

    await fbrModel.saveFbrConfig(access.restaurantId, cfg);

    res.json({
      success: true,
      message: 'FBR settings saved',
      config: {
        ...cfg,
        fbr_api_token: cfg.fbr_api_token ? '••••••••' : null,
      },
    });
  } catch (err) {
    console.error('saveConfig:', err);
    res.status(500).json({ success: false, message: 'Could not save FBR config' });
  }
};

/** GET /fbr/config/:restaurantId */
exports.getConfig = async (req, res) => {
  try {
    const access = assertRestaurantAccess(req, req.params.restaurantId);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const cfg = await fbrModel.getFbrConfig(access.restaurantId);
    if (!cfg) {
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }

    res.json({
      success: true,
      config: {
        fbr_enabled: !!cfg.fbr_enabled,
        fbr_pos_registration_no: cfg.fbr_pos_registration_no || null,
        fbr_api_token: cfg.fbr_api_token ? '••••••••' : null,
        fbr_has_token: !!cfg.fbr_api_token,
        fbr_seller_ntn_cnic: cfg.fbr_seller_ntn_cnic || null,
        fbr_seller_business_name: cfg.fbr_seller_business_name || null,
        fbr_seller_province: cfg.fbr_seller_province || null,
        fbr_seller_address: cfg.fbr_seller_address || null,
        fbr_environment: cfg.fbr_environment || 'sandbox',
      },
    });
  } catch (err) {
    console.error('getConfig:', err);
    res.status(500).json({ success: false, message: 'Could not fetch FBR config' });
  }
};

/* =====================================================
   INVOICE SUBMISSION
===================================================== */

/** POST /fbr/submit/:orderId */
exports.submitOrderInvoice = async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order id' });
    }

    const restaurantId = getRestaurantIdFromUser(req);

    // Order scope check
    const order = await getOrderById(
      orderId,
      req.user?.role === 'super_admin' ? null : restaurantId
    );
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const orderItems = await getOrderItemsByOrderId(orderId);
    const result = await fbrService.submitInvoiceForOrder(order, orderItems);
    res.json({ success: !result.skipped && !!result.success, ...result });
  } catch (err) {
    console.error('submitOrderInvoice:', err);
    res.status(500).json({
      success: false,
      message: 'FBR submission failed',
      error: err.message,
    });
  }
};

/** GET /fbr/status/:orderId */
exports.getInvoiceStatus = async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order id' });
    }

    const restaurantId = getRestaurantIdFromUser(req);

    // ✅ Order scope check
    const order = await getOrderById(
      orderId,
      req.user?.role === 'super_admin' ? null : restaurantId
    );
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const invoice = await fbrModel.getInvoiceByOrder(orderId);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'No FBR invoice found for this order',
      });
    }

    // ✅ Extra safety: invoice.restaurant_id check
    if (
      req.user?.role !== 'super_admin' &&
      Number(invoice.restaurant_id) !== Number(restaurantId)
    ) {
      return res.status(403).json({ success: false, message: 'Not allowed' });
    }

    res.json({ success: true, invoice });
  } catch (err) {
    console.error('getInvoiceStatus:', err);
    res.status(500).json({ success: false, message: 'Could not fetch invoice status' });
  }
};

/** POST /fbr/retry */
exports.retryNow = async (req, res) => {
  try {
    const restaurantId = getRestaurantIdFromUser(req);

    if (!restaurantId) {
      return res.status(401).json({
        success: false,
        message: 'Restaurant information is missing',
      });
    }

    // ✅ Restaurant-scoped retry
    const results = await fbrService.retryPendingInvoices(restaurantId);
    res.json({ success: true, results });
  } catch (err) {
    console.error('retryNow:', err);
    res.status(500).json({ success: false, message: 'Retry run failed' });
  }
};

/** GET /fbr/pending */
exports.getPendingInvoices = async (req, res) => {
  try {
    const restaurantId = getRestaurantIdFromUser(req);

    if (!restaurantId) {
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