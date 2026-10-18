const {
  createRefundRequest,
  listRefunds,
  approveRefund,
  rejectRefund,
} = require('../models/refundModel');

function getRestaurantId(req) {
  return Number(req.user?.restaurant_id);
}

function isValidRestaurantId(id) {
  return Number.isInteger(id) && id > 0;
}

exports.requestRefund = async (req, res) => {
  if (!['counter', 'manager', 'waiter'].includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only counter, waiter or manager can request a refund',
    });
  }

  const restaurantId = getRestaurantId(req);
  if (!isValidRestaurantId(restaurantId)) {
    return res.status(401).json({ success: false, message: 'Restaurant missing' });
  }

  const orderId = Number(req.body?.order_id || req.params?.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ success: false, message: 'Valid order_id is required' });
  }

  try {
    const result = await createRefundRequest({
      restaurantId,
      orderId,
      amount: req.body?.amount,
      reason: req.body?.reason,
      requestedBy: req.user?.id,
    });

    if (result.error) {
      const status =
        result.error === 'NOT_FOUND' ? 404 : result.error === 'ALREADY_EXISTS' ? 409 : 400;
      return res.status(status).json({ success: false, error: result.error, message: result.message });
    }

    try {
      const io = req.app.get('io');
      if (io) {
        io.to(`restaurant_${restaurantId}`).emit('refund_requested', result.refund);
      }
    } catch (_) {}

    return res.status(201).json({
      success: true,
      message: 'Refund request submitted — waiting for manager approval',
      data: result.refund,
      order: result.order,
    });
  } catch (err) {
    console.error('requestRefund:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.listRefunds = async (req, res) => {
  if (!['manager', 'counter'].includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  const restaurantId = getRestaurantId(req);
  if (!isValidRestaurantId(restaurantId)) {
    return res.status(401).json({ success: false, message: 'Restaurant missing' });
  }

  try {
    const status = String(req.query.status || 'pending').toLowerCase();
    const rows = await listRefunds(restaurantId, status);
    return res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    console.error('listRefunds:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.approve = async (req, res) => {
  if (req.user?.role !== 'manager') {
    return res.status(403).json({
      success: false,
      message: 'Only manager can approve refunds',
    });
  }

  const restaurantId = getRestaurantId(req);
  const refundId = Number(req.params.id);
  if (!isValidRestaurantId(restaurantId) || !Number.isInteger(refundId) || refundId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }

  try {
    const result = await approveRefund(restaurantId, refundId, req.user?.id);
    if (result.error) {
      const status = result.error === 'NOT_FOUND' ? 404 : 409;
      return res.status(status).json({ success: false, error: result.error, message: result.message });
    }

    try {
      const io = req.app.get('io');
      if (io) {
        io.to(`restaurant_${restaurantId}`).emit('refund_approved', result.refund);
        io.to(`restaurant_${restaurantId}`).emit('order_updated', {
          id: result.refund.order_id,
          payment_status: 'refunded',
        });
      }
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Refund approved — order marked as refunded',
      data: result.refund,
    });
  } catch (err) {
    console.error('approveRefund:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.reject = async (req, res) => {
  if (req.user?.role !== 'manager') {
    return res.status(403).json({
      success: false,
      message: 'Only manager can reject refunds',
    });
  }

  const restaurantId = getRestaurantId(req);
  const refundId = Number(req.params.id);
  if (!isValidRestaurantId(restaurantId) || !Number.isInteger(refundId) || refundId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }

  try {
    const result = await rejectRefund(
      restaurantId,
      refundId,
      req.user?.id,
      req.body?.reason || req.body?.reject_reason
    );
    if (result.error) {
      const status = result.error === 'NOT_FOUND' ? 404 : 409;
      return res.status(status).json({ success: false, error: result.error, message: result.message });
    }

    try {
      const io = req.app.get('io');
      if (io) {
        io.to(`restaurant_${restaurantId}`).emit('refund_rejected', result.refund);
      }
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Refund request rejected',
      data: result.refund,
    });
  } catch (err) {
    console.error('rejectRefund:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
