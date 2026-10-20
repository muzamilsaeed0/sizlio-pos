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
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Serialize concurrent shift starts for the same user/restaurant.
    // This prevents two simultaneous requests from creating two active shifts.
    await client.query(
      'SELECT pg_advisory_xact_lock($1, $2)',
      [Number(userId), Number(restaurantId)]
    );

    const existing = await client.query(
      `
      SELECT *
      FROM shifts
      WHERE user_id = $1
        AND restaurant_id = $2
        AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [userId, restaurantId]
    );

    if (existing.rowCount) {
      await client.query('COMMIT');
      return existing.rows[0];
    }

    const result = await client.query(
      `
      INSERT INTO shifts
        (user_id, restaurant_id, status)
      VALUES
        ($1, $2, 'active')
      RETURNING *
      `,
      [userId, restaurantId]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
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
      COUNT(*) FILTER (
        WHERE COALESCE(payment_status, '') <> 'refunded'
      )::int AS orders_count,

      COALESCE(
        SUM(total_amount) FILTER (
          WHERE COALESCE(payment_status, '') <> 'refunded'
        ),
        0
      ) AS total_sales,

      COALESCE(
        SUM(
          CASE
            WHEN payment_status = 'paid' AND paid_by_user_id = $1
              THEN total_amount
            ELSE 0
          END
        ),
        0
      ) AS total_collected,

      COALESCE(
        SUM(total_amount) FILTER (
          WHERE payment_status = 'refunded'
        ),
        0
      ) AS total_refunded

    FROM orders
    WHERE created_by_user_id = $1
      AND restaurant_id = $2
      AND created_at >= $3
      AND created_at <= $4
    `,
    [shift.user_id, restaurantId, shift.started_at, endTime]
  );

  const ordersResult = await pool.query(
    `
    SELECT
      id,
      local_number,
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
    [shift.user_id, restaurantId, shift.started_at, endTime]
  );

  const orders = ordersResult.rows;
  const orderIds = orders.map(o => o.id);

  let itemsByOrder = {};
  let dealsByOrder = {};

   if (orderIds.length) {
    // order_items me name/variant_label nahi — join se lao
    const itemsResult = await pool.query(
      `
      SELECT
        oi.order_id,
        m.name,
        oi.quantity,
        oi.unit_price,
        miv.label AS variant_label
      FROM order_items oi
      INNER JOIN menu_items m
        ON m.id = oi.menu_item_id
      LEFT JOIN menu_item_variants miv
        ON miv.id = oi.variant_id
      WHERE oi.order_id = ANY($1::int[])
      ORDER BY oi.id
      `,
      [orderIds]
    );
    for (const row of itemsResult.rows) {
      if (!itemsByOrder[row.order_id]) itemsByOrder[row.order_id] = [];
      itemsByOrder[row.order_id].push(row);
    }

    try {
      const dealsResult = await pool.query(
        `
        SELECT
          od.order_id,
          d.name AS deal_name,
          od.quantity
        FROM order_deals od
        INNER JOIN deals d
          ON d.id = od.deal_id
        WHERE od.order_id = ANY($1::int[])
        ORDER BY od.id
        `,
        [orderIds]
      );
      for (const d of dealsResult.rows) {
        if (!dealsByOrder[d.order_id]) dealsByOrder[d.order_id] = [];
        dealsByOrder[d.order_id].push({
          deal_name: d.deal_name,
          quantity: d.quantity,
          items: []
        });
      }
    } catch (e) {
      // order_deals / deals missing → ignore
    }
  }

  const ordersWithItems = orders.map(o => ({
    ...o,
    items: itemsByOrder[o.id] || [],
    deals: dealsByOrder[o.id] || []
  }));

  const userResult = await pool.query(
    `
    SELECT username, full_name
    FROM users
    WHERE id = $1 AND restaurant_id = $2
    `,
    [shift.user_id, restaurantId]
  );

  return {
    ...shift,
    ...summaryResult.rows[0],
    username: userResult.rows[0]?.username || null,
    full_name: userResult.rows[0]?.full_name || null,
    orders: ordersWithItems
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
      COALESCE(o_stats.total_collected, 0) AS total_collected,
      COALESCE(o_stats.total_refunded, 0) AS total_refunded

    FROM shifts s

    INNER JOIN users u
      ON u.id = s.user_id

    LEFT JOIN LATERAL (

      SELECT
        COUNT(*) FILTER (
          WHERE COALESCE(payment_status, '') <> 'refunded'
        )::int AS orders_count,

        COALESCE(
          SUM(total_amount) FILTER (
            WHERE COALESCE(payment_status, '') <> 'refunded'
          ),
          0
        ) AS total_sales,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid' AND paid_by_user_id = s.user_id
                THEN total_amount
              ELSE 0
            END
          ),
          0
        ) AS total_collected,

        COALESCE(
          SUM(total_amount) FILTER (
            WHERE payment_status = 'refunded'
          ),
          0
        ) AS total_refunded

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

          COALESCE(o_stats.orders_count, 0)       AS orders_count,
      COALESCE(o_stats.total_sales, 0)        AS total_sales,
      COALESCE(o_stats.total_collected, 0)    AS total_collected,
      COALESCE(o_stats.total_refunded, 0)     AS total_refunded,
      COALESCE(o_stats.orders_prepared, 0)    AS orders_prepared,
      COALESCE(o_stats.items_prepared, 0)     AS items_prepared,
      COALESCE(o_stats.ingredients_used, 0)   AS ingredients_used

    FROM shifts s

    INNER JOIN users u
      ON u.id = s.user_id

       LEFT JOIN LATERAL (

      SELECT
        -- Counter / Rider / Waiter
        COUNT(*) FILTER (
          WHERE COALESCE(payment_status, '') <> 'refunded'
            AND (
              (u.role = 'delivery' AND delivery_rider_id = s.user_id)
              OR (u.role IN ('counter', 'waiter') AND created_by_user_id = s.user_id)
            )
        )::int AS orders_count,

        COALESCE(
          SUM(total_amount) FILTER (
            WHERE COALESCE(payment_status, '') <> 'refunded'
              AND (
                (u.role = 'delivery' AND delivery_rider_id = s.user_id)
                OR (u.role IN ('counter', 'waiter') AND created_by_user_id = s.user_id)
              )
          ),
          0
        ) AS total_sales,

        COALESCE(
          SUM(total_amount) FILTER (
            WHERE payment_status = 'paid'
              AND (
                (u.role = 'delivery' AND delivery_rider_id = s.user_id)
                OR (u.role IN ('counter', 'waiter') AND created_by_user_id = s.user_id)
              )
          ),
          0
        ) AS total_collected,

        COALESCE(
          SUM(total_amount) FILTER (
            WHERE payment_status = 'refunded'
              AND (
                (u.role = 'delivery' AND delivery_rider_id = s.user_id)
                OR (u.role IN ('counter', 'waiter') AND created_by_user_id = s.user_id)
              )
          ),
          0
        ) AS total_refunded,

        -- Kitchen: shift window me prepared orders (ready/served/completed)
        CASE WHEN u.role = 'kitchen' THEN (
          SELECT COUNT(*)::int
          FROM orders o2
          WHERE o2.restaurant_id = s.restaurant_id
            AND o2.created_at >= s.started_at
            AND o2.created_at <= COALESCE(s.ended_at, NOW())
            AND o2.status IN ('ready', 'served', 'completed', 'delivered', 'handed_over')
            AND COALESCE(o2.payment_status, '') <> 'refunded'
        ) ELSE 0 END AS orders_prepared,

        CASE WHEN u.role = 'kitchen' THEN (
          SELECT COALESCE(SUM(oi.quantity), 0)::int
          FROM orders o3
          JOIN order_items oi ON oi.order_id = o3.id
          WHERE o3.restaurant_id = s.restaurant_id
            AND o3.created_at >= s.started_at
            AND o3.created_at <= COALESCE(s.ended_at, NOW())
            AND o3.status IN ('ready', 'served', 'completed', 'delivered', 'handed_over')
            AND COALESCE(o3.payment_status, '') <> 'refunded'
        ) ELSE 0 END AS items_prepared,

        CASE WHEN u.role = 'kitchen' THEN (
          SELECT COALESCE(SUM(t.quantity), 0)
          FROM kitchen_inventory_transactions t
          JOIN kitchen_inventory ki ON ki.id = t.kitchen_inventory_id
          WHERE ki.restaurant_id = s.restaurant_id
            AND t.type = 'OUT'
            AND t.order_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM orders o4
              WHERE o4.id = t.order_id
                AND o4.restaurant_id = s.restaurant_id
                AND o4.created_at >= s.started_at
                AND o4.created_at <= COALESCE(s.ended_at, NOW())
            )
        ) ELSE 0 END AS ingredients_used

      FROM orders
      WHERE restaurant_id = s.restaurant_id
        AND created_at >= s.started_at
        AND created_at <= COALESCE(s.ended_at, NOW())
        AND (
          (u.role = 'delivery' AND delivery_rider_id = s.user_id)
          OR (u.role IN ('counter', 'waiter') AND created_by_user_id = s.user_id)
          OR (u.role = 'kitchen')
        )

    ) o_stats ON true

    WHERE ${conditions.join(' AND ')}

    ORDER BY s.started_at DESC

    LIMIT 300
    `,
    params
  );

     const shifts = result.rows.map(row => ({
    id:               row.id,
    user_id:          row.user_id,
    username:         row.username,
    full_name:        row.full_name,
    role:             row.role,
    started_at:       row.started_at,
    ended_at:         row.ended_at,
    status:           row.status,
    orders_count:     Number(row.orders_count || 0),
    total_sales:      Number(row.total_sales || 0),
    total_collected:  Number(row.total_collected || 0),
    total_refunded:   Number(row.total_refunded || 0),
    orders_prepared:  Number(row.orders_prepared || 0),
    items_prepared:   Number(row.items_prepared || 0),
    ingredients_used: Number(row.ingredients_used || 0)
  }));
  // Role-wise totals
      const totalsByRole = {
    rider:   { shifts: 0, orders: 0, sales: 0, collected: 0, refunded: 0, orders_prepared: 0, items_prepared: 0, ingredients_used: 0 },
    kitchen: { shifts: 0, orders: 0, sales: 0, collected: 0, refunded: 0, orders_prepared: 0, items_prepared: 0, ingredients_used: 0 },
    counter: { shifts: 0, orders: 0, sales: 0, collected: 0, refunded: 0, orders_prepared: 0, items_prepared: 0, ingredients_used: 0 },
    waiter:  { shifts: 0, orders: 0, sales: 0, collected: 0, refunded: 0, orders_prepared: 0, items_prepared: 0, ingredients_used: 0 },
    other:   { shifts: 0, orders: 0, sales: 0, collected: 0, refunded: 0, orders_prepared: 0, items_prepared: 0, ingredients_used: 0 }
  };

  const roleMap = {
    delivery: 'rider',
    kitchen:  'kitchen',
    counter:  'counter',
    waiter:   'waiter'
  };

    for (const s of shifts) {
    const key = roleMap[s.role] || 'other';
    totalsByRole[key].shifts            += 1;
    totalsByRole[key].orders            += s.orders_count;
    totalsByRole[key].sales             += s.total_sales;
    totalsByRole[key].collected         += s.total_collected;
    totalsByRole[key].refunded          += s.total_refunded;
    totalsByRole[key].orders_prepared   += s.orders_prepared;
    totalsByRole[key].items_prepared    += s.items_prepared;
    totalsByRole[key].ingredients_used  += s.ingredients_used;
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
  getAllShiftsForManager  
};