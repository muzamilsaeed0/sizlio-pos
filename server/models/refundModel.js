const pool = require('../config/db');

/**
 * Full refund request for a paid completed/served order.
 * Manager approval required before payment_status becomes refunded.
 */
const createRefundRequest = async ({
  restaurantId,
  orderId,
  amount,
  reason,
  requestedBy,
}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      `SELECT id, status, payment_status, total_amount, local_number, customer_name
       FROM orders
       WHERE id = $1 AND restaurant_id = $2
       FOR UPDATE`,
      [orderId, restaurantId]
    );

    if (!orderRes.rows.length) {
      await client.query('ROLLBACK');
      return { error: 'NOT_FOUND', message: 'Order not found' };
    }

    const order = orderRes.rows[0];

    if (String(order.payment_status).toLowerCase() !== 'paid') {
      await client.query('ROLLBACK');
      return { error: 'NOT_PAID', message: 'Only paid orders can be refunded' };
    }

    if (!['completed', 'served', 'delivered'].includes(String(order.status).toLowerCase())) {
      await client.query('ROLLBACK');
      return {
        error: 'INVALID_STATUS',
        message: 'Refund only allowed for served, delivered, or completed paid orders',
      };
    }

    const existing = await client.query(
      `SELECT id, status FROM order_refunds
       WHERE order_id = $1 AND restaurant_id = $2
         AND status IN ('pending', 'approved')
       LIMIT 1`,
      [orderId, restaurantId]
    );

    if (existing.rows.length) {
      await client.query('ROLLBACK');
      const st = existing.rows[0].status;
      return {
        error: 'ALREADY_EXISTS',
        message:
          st === 'pending'
            ? 'A refund request is already pending for this order'
            : 'This order has already been refunded',
      };
    }

    const orderTotal = Number(order.total_amount || 0);
    let refundAmount = amount != null ? Number(amount) : orderTotal;
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      await client.query('ROLLBACK');
      return { error: 'INVALID_AMOUNT', message: 'Refund amount must be greater than 0' };
    }
    // Phase A: full refund only
    refundAmount = orderTotal;

    const ins = await client.query(
      `INSERT INTO order_refunds
         (restaurant_id, order_id, amount, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING *`,
      [
        restaurantId,
        orderId,
        refundAmount,
        reason ? String(reason).trim().slice(0, 500) : null,
        requestedBy || null,
      ]
    );

    await client.query('COMMIT');
    return {
      refund: ins.rows[0],
      order: {
        id: order.id,
        local_number: order.local_number,
        customer_name: order.customer_name,
        total_amount: order.total_amount,
        status: order.status,
      },
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
};

const listRefunds = async (restaurantId, status = 'pending') => {
  const params = [restaurantId];
  let statusFilter = '';
  if (status && status !== 'all') {
    statusFilter = ' AND r.status = $2 ';
    params.push(status);
  }

  const result = await pool.query(
    `
    SELECT
      r.*,
      o.local_number,
      o.customer_name,
      o.order_type,
      o.total_amount AS order_total,
      o.status AS order_status,
      o.payment_status AS order_payment_status,
      o.payment_method,
      req.username AS requested_by_username,
      req.full_name AS requested_by_name,
      rev.username AS reviewed_by_username,
      rev.full_name AS reviewed_by_name
    FROM order_refunds r
    INNER JOIN orders o ON o.id = r.order_id AND o.restaurant_id = r.restaurant_id
    LEFT JOIN users req ON req.id = r.requested_by
    LEFT JOIN users rev ON rev.id = r.reviewed_by
    WHERE r.restaurant_id = $1
      ${statusFilter}
    ORDER BY r.created_at DESC
    LIMIT 100
    `,
    params
  );

  return result.rows;
};

const approveRefund = async (restaurantId, refundId, reviewedBy) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const refRes = await client.query(
      `SELECT * FROM order_refunds
       WHERE id = $1 AND restaurant_id = $2
       FOR UPDATE`,
      [refundId, restaurantId]
    );

    if (!refRes.rows.length) {
      await client.query('ROLLBACK');
      return { error: 'NOT_FOUND', message: 'Refund request not found' };
    }

    const refund = refRes.rows[0];
    if (refund.status !== 'pending') {
      await client.query('ROLLBACK');
      return { error: 'NOT_PENDING', message: `Request is already ${refund.status}` };
    }

    const orderRes = await client.query(
      `SELECT id, payment_status, status, total_amount
       FROM orders
       WHERE id = $1 AND restaurant_id = $2
       FOR UPDATE`,
      [refund.order_id, restaurantId]
    );

    if (!orderRes.rows.length) {
      await client.query('ROLLBACK');
      return { error: 'ORDER_NOT_FOUND', message: 'Order not found' };
    }

    const order = orderRes.rows[0];
    if (String(order.payment_status).toLowerCase() !== 'paid') {
      await client.query('ROLLBACK');
      return { error: 'NOT_PAID', message: 'Order is no longer paid' };
    }

    await client.query(
      `UPDATE orders
       SET payment_status = 'refunded'
       WHERE id = $1 AND restaurant_id = $2`,
      [refund.order_id, restaurantId]
    );

    const updated = await client.query(
      `UPDATE order_refunds
       SET status = 'approved',
           reviewed_by = $1,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND restaurant_id = $3
       RETURNING *`,
      [reviewedBy || null, refundId, restaurantId]
    );

    await client.query('COMMIT');
    return { refund: updated.rows[0] };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
};

const rejectRefund = async (restaurantId, refundId, reviewedBy, rejectReason) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const refRes = await client.query(
      `SELECT * FROM order_refunds
       WHERE id = $1 AND restaurant_id = $2
       FOR UPDATE`,
      [refundId, restaurantId]
    );

    if (!refRes.rows.length) {
      await client.query('ROLLBACK');
      return { error: 'NOT_FOUND', message: 'Refund request not found' };
    }

    if (refRes.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return { error: 'NOT_PENDING', message: `Request is already ${refRes.rows[0].status}` };
    }

    const updated = await client.query(
      `UPDATE order_refunds
       SET status = 'rejected',
           reviewed_by = $1,
           reviewed_at = NOW(),
           reject_reason = $2,
           updated_at = NOW()
       WHERE id = $3 AND restaurant_id = $4
       RETURNING *`,
      [
        reviewedBy || null,
        rejectReason ? String(rejectReason).trim().slice(0, 500) : null,
        refundId,
        restaurantId,
      ]
    );

    await client.query('COMMIT');
    return { refund: updated.rows[0] };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
};

module.exports = {
  createRefundRequest,
  listRefunds,
  approveRefund,
  rejectRefund,
};
