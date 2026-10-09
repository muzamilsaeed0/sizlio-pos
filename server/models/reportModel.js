const pool = require('../config/db');


const getSummary = async (restaurantId) => {

  const today = await pool.query(
  `
  SELECT
    COUNT(*) AS orders_count,
    COALESCE(SUM(o.total_amount), 0)::numeric(10,2) AS total_sales
  FROM orders o
  WHERE o.restaurant_id = $1
    AND o.payment_status = 'paid'
    AND o.status = 'completed'
    AND o.paid_at::date = CURRENT_DATE
  `,
  [restaurantId]
);


  const month = await pool.query(
  `
  SELECT
    COUNT(*) AS orders_count,
    COALESCE(SUM(o.total_amount), 0)::numeric(10,2) AS total_sales
  FROM orders o
  WHERE o.restaurant_id = $1
    AND o.payment_status = 'paid'
    AND o.status = 'completed'
    AND date_trunc('month', o.paid_at)
        = date_trunc('month', CURRENT_DATE)
  `,
  [restaurantId]
);


  return {
    today: today.rows[0],
    month: month.rows[0]
  };
};



const getSalesDetails = async (
  restaurantId,
  from,
  to
) => {

  let condition = '';

  const values = [
    restaurantId
  ];

  if (from && to) {

    condition = `
      AND o.paid_at::date
      BETWEEN $2 AND $3
    `;

    values.push(from, to);
  }

  const result = await pool.query(
    `
    SELECT

      o.id,

      o.table_no,

      o.order_type,

      o.customer_name,

      o.delivery_phone,

      o.delivery_address,

      o.paid_at,

      o.created_at,

      o.payment_method,

      o.payment_status,

      o.status,

      o.local_number,

      o.subtotal,

      o.discount_amount,

      o.gst_amount,

      o.tax_amount,

      COALESCE(o.delivery_charge, 0)::numeric(10,2) AS delivery_charge,

      COALESCE(o.dine_charge, 0)::numeric(10,2) AS dine_charge,

      COALESCE(o.card_charge, 0)::numeric(10,2) AS card_charge,

      COALESCE(o.bank_charge, 0)::numeric(10,2) AS bank_charge,

     o.total_amount::numeric(10,2) AS total_amount,

    o.total_amount::numeric(10,2) AS total,
    
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'type', 'item',
              'menu_item_id', oi.menu_item_id,
              'variant_id', oi.variant_id,
              'variant_label', miv.label,
              'name', m.name,
              'qty', oi.quantity,
              'price', oi.unit_price::numeric(10,2),
              'total', oi.line_total::numeric(10,2)
            )
            ORDER BY m.name
          )
          FROM order_items oi
          INNER JOIN menu_items m
            ON m.id = oi.menu_item_id
            AND m.restaurant_id = o.restaurant_id
          LEFT JOIN menu_item_variants miv
            ON miv.id = oi.variant_id
            AND miv.menu_item_id = oi.menu_item_id
          WHERE oi.order_id = o.id
            AND oi.order_deal_id IS NULL
        ),
        '[]'::json
      ) AS items,

      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'type', 'deal',
              'deal_id', od.deal_id,
              'name', d.name,
              'qty', od.quantity,
              'price', od.unit_price::numeric(10,2),
              'total', od.line_total::numeric(10,2)
            )
            ORDER BY d.name
          )
          FROM order_deals od
          INNER JOIN deals d
            ON d.id = od.deal_id
            AND d.restaurant_id = o.restaurant_id
          WHERE od.order_id = o.id
        ),
        '[]'::json
      ) AS deals

    FROM orders o

    WHERE o.restaurant_id = $1

      AND o.payment_status = 'paid'

      AND o.status = 'completed'

      ${condition}

    ORDER BY o.paid_at DESC NULLS LAST, o.id DESC
    `,
    values
  );

  return result.rows;
};



const getTopItems = async (
  restaurantId,
  from,
  to
) => {

  let dateFilter = "";
  const params = [restaurantId];

  if (from && to) {
    dateFilter = `AND o.paid_at::date BETWEEN $2 AND $3`;
    params.push(from, to);
  }

  const result = await pool.query(
    `
    SELECT

      m.name,

      SUM(oi.quantity) AS qty,

      COALESCE(
        SUM(
          oi.line_total
        ),
        0
      )::numeric(10,2) AS sales

    FROM orders o

    JOIN order_items oi
      ON oi.order_id = o.id

    JOIN menu_items m
      ON m.id = oi.menu_item_id
      AND m.restaurant_id = o.restaurant_id

    LEFT JOIN menu_item_variants miv
      ON miv.id = oi.variant_id

    WHERE o.restaurant_id = $1

      AND o.payment_status = 'paid'

      AND o.status = 'completed'

      AND oi.order_deal_id IS NULL

      ${dateFilter}

    GROUP BY
      m.id,
      m.name

    ORDER BY
      qty DESC

    LIMIT 10
    `,
    params
  );

  return result.rows;
};

const getPaymentSummary = async (
  restaurantId,
  from,
  to
) => {

  let dateFilter = "";

  const params = [
    restaurantId
  ];

  if (from && to) {

    dateFilter = `
      AND o.payment_status = 'paid'
      AND o.status = 'completed'
      AND o.paid_at::date
      BETWEEN $2 AND $3
    `;

    params.push(from, to);

  } else {

    dateFilter = `
      AND o.payment_status = 'paid'
      AND o.status = 'completed'
    `;

  }

  const result = await pool.query(
    `
    SELECT
      COALESCE(
        o.payment_method,
        'Other'
      ) AS payment_method,

      COUNT(*) AS orders,

      COALESCE(SUM(o.total_amount), 0)::numeric(10,2) AS total

    FROM orders o

    WHERE o.restaurant_id = $1

    ${dateFilter}

    GROUP BY
      COALESCE(
        o.payment_method,
        'Other'
      )

    ORDER BY orders DESC
    `,
    params
  );

  return result.rows;
};

const getSalesChart = async(
  restaurantId,
  from,
  to
) => {

  let dateFilter = "";

  let params = [
    restaurantId
  ];

  if (from && to) {

    dateFilter = `
      AND o.paid_at::date
      BETWEEN $2 AND $3
    `;

    params.push(from, to);
  }

  const result = await pool.query(
    `
    SELECT

      o.paid_at::date AS date,

      COALESCE(
        SUM(o.total_amount),
        0
      )::numeric(10,2) AS sales

    FROM orders o

    WHERE o.restaurant_id = $1

      AND o.payment_status = 'paid'

      AND o.status = 'completed'

      ${dateFilter}

    GROUP BY
      o.paid_at::date

    ORDER BY
      date ASC
    `,
    params
  );

  return result.rows;
};

module.exports = {
  getSummary,
  getSalesDetails,
  getTopItems,
  getPaymentSummary,
  getSalesChart
};
