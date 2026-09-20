const pool = require('../config/db');

const getActiveShift = async (userId, restaurantId) => {
  const result = await pool.query(
    `
    SELECT *
    FROM shifts
    WHERE user_id = $1
      AND restaurant_id = $2
      AND status = 'active'
    ORDER BY started_at DESC
    LIMIT 1
    `,
    [userId, restaurantId]
  );

  return result.rows[0] || null;
};

const startShift = async (userId, restaurantId) => {
  const result = await pool.query(
    `
    INSERT INTO shifts
      (user_id, restaurant_id, status)
    VALUES
      ($1, $2, 'active')
    RETURNING *
    `,
    [userId, restaurantId]
  );

  return result.rows[0];
};

const endShift = async (shiftId, userId, restaurantId) => {
  const result = await pool.query(
    `
    UPDATE shifts
    SET
      status = 'closed',
      ended_at = NOW()
    WHERE id = $1
      AND user_id = $2
      AND restaurant_id = $3
      AND status = 'active'
    RETURNING *
    `,
    [shiftId, userId, restaurantId]
  );

  return result.rows[0] || null;
};

const getShiftById = async (shiftId, restaurantId) => {
  const result = await pool.query(
    `
    SELECT *
    FROM shifts
    WHERE id = $1
      AND restaurant_id = $2
    `,
    [shiftId, restaurantId]
  );

  return result.rows[0] || null;
};

const getShiftSummary = async (shiftId, restaurantId) => {

  const shift = await getShiftById(shiftId, restaurantId);

  if (!shift) return null;

  const endTime = shift.ended_at || new Date();

  const summaryResult = await pool.query(
    `
    SELECT

      COUNT(*)::int AS orders_count,

      COALESCE(SUM(total_amount), 0) AS total_sales,

      COALESCE(
        SUM(
          CASE
            WHEN payment_status = 'paid' AND paid_by_user_id = $1
              THEN paid_amount
            ELSE 0
          END
        ),
        0
      ) AS total_collected

    FROM orders

    WHERE created_by_user_id = $1

      AND restaurant_id = $2

      AND created_at >= $3

      AND created_at <= $4
    `,
    [
      shift.user_id,
      restaurantId,
      shift.started_at,
      endTime
    ]
  );

  const ordersResult = await pool.query(
    `
    SELECT

      id,

      table_no,

      order_type,

      status,

      payment_status,

      payment_method,

      total_amount,

      paid_amount,

      created_at,

      paid_at

    FROM orders

    WHERE created_by_user_id = $1

      AND restaurant_id = $2

      AND created_at >= $3

      AND created_at <= $4

    ORDER BY created_at DESC
    `,
    [
      shift.user_id,
      restaurantId,
      shift.started_at,
      endTime
    ]
  );

  const userResult = await pool.query(
    `
    SELECT username, full_name
    FROM users
    WHERE id = $1
    `,
    [shift.user_id]
  );

  return {
    ...shift,
    ...summaryResult.rows[0],
    username: userResult.rows[0]?.username || null,
    full_name: userResult.rows[0]?.full_name || null,
    orders: ordersResult.rows
  };
};

const listShifts = async (restaurantId, filters = {}) => {

  const conditions = ['s.restaurant_id = $1'];
  const params = [restaurantId];

  if (filters.date) {
    params.push(filters.date);
    conditions.push(`s.started_at::date = $${params.length}::date`);
  }

  if (filters.username) {
    params.push('%' + filters.username + '%');
    conditions.push(`u.username ILIKE $${params.length}`);
  }

  // Non-manager roles (kitchen / rider / counter) are restricted to
  // their own shifts only — never other staff's, even of the same
  // role. Managers omit this filter and see everyone.
  if (filters.own_user_id) {
    params.push(filters.own_user_id);
    conditions.push(`s.user_id = $${params.length}`);
  }

  const result = await pool.query(
    `
    SELECT

      s.id,

      s.user_id,

      u.username,

      u.full_name,

      u.role,

      s.started_at,

      s.ended_at,

      s.status,

      COALESCE(o_stats.orders_count, 0) AS orders_count,

      COALESCE(o_stats.total_sales, 0) AS total_sales,

      COALESCE(o_stats.total_collected, 0) AS total_collected

    FROM shifts s

    INNER JOIN users u
      ON u.id = s.user_id

    LEFT JOIN LATERAL (

      SELECT

        COUNT(*)::int AS orders_count,

        COALESCE(SUM(total_amount), 0) AS total_sales,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid' AND paid_by_user_id = s.user_id
                THEN paid_amount
            ELSE 0
          END
        ),
        0
      ) AS total_collected

      FROM orders

      WHERE created_by_user_id = s.user_id

        AND restaurant_id = s.restaurant_id

        AND created_at >= s.started_at

        AND created_at <= COALESCE(s.ended_at, NOW())

    ) o_stats ON true

    WHERE ${conditions.join(' AND ')}

    ORDER BY s.started_at DESC

    LIMIT 200
    `,
    params
  );

  return result.rows;
};


// ======================================================
// MANAGER — ALL STAFF SHIFTS (rider / kitchen / counter / waiter)
// ======================================================

/**
 * Returns all shifts for a restaurant with role, order count, sales,
 * collected. Also returns totals_by_role summary.
 *
 * Filters:
 *   - date     (YYYY-MM-DD)      → exact day
 *   - from,to  (YYYY-MM-DD range)
 *   - role     ('delivery' | 'kitchen' | 'counter' | 'waiter')
 *   - username (partial match)
 */
const getAllShiftsForManager = async (restaurantId, filters = {}) => {

  const conditions = ['s.restaurant_id = $1'];
  const params = [restaurantId];

  // Date filters
  if (filters.date) {
    params.push(filters.date);
    conditions.push(`s.started_at::date = $${params.length}::date`);
  } else {
    if (filters.from) {
      params.push(filters.from);
      conditions.push(`s.started_at >= $${params.length}::date`);
    }
    if (filters.to) {
      params.push(filters.to);
      conditions.push(`s.started_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
  }

  // Role filter
  if (filters.role && filters.role !== 'all') {
    params.push(filters.role);
    conditions.push(`u.role = $${params.length}`);
  }

  // Username filter
  if (filters.username) {
    params.push(`%${filters.username}%`);
    conditions.push(`u.username ILIKE $${params.length}`);
  }

  const result = await pool.query(
    `
    SELECT

      s.id,
      s.user_id,
      u.username,
      u.full_name,
      u.role,
      s.started_at,
      s.ended_at,
      s.status,

      COALESCE(o_stats.orders_count, 0)     AS orders_count,
      COALESCE(o_stats.total_sales, 0)      AS total_sales,
      COALESCE(o_stats.total_collected, 0)  AS total_collected

    FROM shifts s

    INNER JOIN users u
      ON u.id = s.user_id

    LEFT JOIN LATERAL (

      SELECT

        COUNT(*)::int AS orders_count,

        COALESCE(SUM(total_amount), 0) AS total_sales,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid'
                THEN COALESCE(paid_amount, total_amount)
              ELSE 0
            END
          ),
          0
        ) AS total_collected

      FROM orders

      WHERE restaurant_id = s.restaurant_id

        AND created_at >= s.started_at

        AND created_at <= COALESCE(s.ended_at, NOW())

        -- ✅ Rider ke liye: assigned delivery orders count karo
        --    Baaki roles ke liye: created_by_user_id
        AND (
          (u.role = 'delivery' AND delivery_rider_id = s.user_id)
          OR
          (u.role <> 'delivery' AND created_by_user_id = s.user_id)
        )

    ) o_stats ON true

    WHERE ${conditions.join(' AND ')}

    ORDER BY s.started_at DESC

    LIMIT 300
    `,
    params
  );

  const shifts = result.rows.map(row => ({
    id:            row.id,
    user_id:       row.user_id,
    username:      row.username,
    full_name:     row.full_name,
    role:          row.role,
    started_at:    row.started_at,
    ended_at:      row.ended_at,
    status:        row.status,
    orders_count:  Number(row.orders_count || 0),
    total_sales:   Number(row.total_sales || 0),
    total_collected: Number(row.total_collected || 0)
  }));

  // Role-wise totals
  const totalsByRole = {
    rider:   { shifts: 0, orders: 0, sales: 0, collected: 0 },
    kitchen: { shifts: 0, orders: 0, sales: 0, collected: 0 },
    counter: { shifts: 0, orders: 0, sales: 0, collected: 0 },
    waiter:  { shifts: 0, orders: 0, sales: 0, collected: 0 },
    other:   { shifts: 0, orders: 0, sales: 0, collected: 0 }
  };

  const roleMap = {
    delivery: 'rider',
    kitchen:  'kitchen',
    counter:  'counter',
    waiter:   'waiter'
  };

  for (const s of shifts) {
    const key = roleMap[s.role] || 'other';
    totalsByRole[key].shifts    += 1;
    totalsByRole[key].orders    += s.orders_count;
    totalsByRole[key].sales     += s.total_sales;
    totalsByRole[key].collected += s.total_collected;
  }

  return { shifts, totals_by_role: totalsByRole };
};


module.exports = {
  getActiveShift,
  startShift,
  endShift,
  getShiftById,
  getShiftSummary,
  listShifts,
  getAllShiftsForManager   // ✅ NEW
};