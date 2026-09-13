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

      o.subtotal,

      o.discount_amount,

      o.gst_amount,

      o.tax_amount,

      o.total_amount::numeric(10,2) AS total,

      /* =========================
         NORMAL ITEMS
         ========================= */

      COALESCE(
        (
          SELECT json_agg(
            json_build_object(

              'type', 'item',

              'name', m.name,

              'qty', oi.quantity,

              'price',
              m.price::numeric(10,2),

              'total',
              (
                oi.quantity * m.price
              )::numeric(10,2)

            )

            ORDER BY m.name

          )

          FROM order_items oi

          INNER JOIN menu_items m
            ON m.id = oi.menu_item_id

          WHERE oi.order_id = o.id

            AND oi.order_deal_id IS NULL
        ),

        '[]'::json

      ) AS items,


      /* =========================
         DEALS
         ========================= */

      COALESCE(
        (
          SELECT json_agg(
            json_build_object(

              'type', 'deal',

              'deal_id', x.deal_id,

              'name', x.name,

              'qty', x.quantity,

              'price',
              x.price::numeric(10,2),

              'total',
              (
                x.quantity * x.price
              )::numeric(10,2),

              'items', x.items

            )

            ORDER BY x.name

          )

          FROM (

            SELECT DISTINCT ON (od.id)

              od.id AS order_deal_row_id,

              od.deal_id,

              d.name,

              od.quantity,

              d.price,

              COALESCE(
                (
                  SELECT json_agg(
                    json_build_object(

                      'name',
                      m2.name,

                      'quantity',
                      oi2.quantity,

                      'variant_label',
                      miv2.label

                    )

                    ORDER BY
                      m2.name,
                      miv2.label

                  )

                  FROM order_items oi2

                  INNER JOIN menu_items m2
                    ON m2.id = oi2.menu_item_id

                  LEFT JOIN menu_item_variants miv2
                    ON miv2.id = oi2.variant_id

                  WHERE
                    oi2.order_deal_id = od.id

                ),

                '[]'::json

              ) AS items

            FROM order_deals od

            INNER JOIN deals d
              ON d.id = od.deal_id

            WHERE
              od.order_id = o.id

              AND d.restaurant_id = $1

            ORDER BY od.id

          ) x

        ),

        '[]'::json

      ) AS deals


    FROM orders o

    WHERE
      o.restaurant_id = $1

      AND o.payment_status = 'paid'

      AND o.paid_at IS NOT NULL

      ${condition}


    ORDER BY
      o.paid_at DESC

    `,
    values
  );

  return result.rows;

};

const getTopItems = async (restaurantId) => {

  const result = await pool.query(
    `
    SELECT

      m.name,

      SUM(oi.quantity) AS qty,

      COALESCE(
        SUM(
          oi.quantity * m.price
        ),
        0
      )::numeric(10,2) AS sales

    FROM orders o

    JOIN order_items oi
      ON oi.order_id = o.id

    JOIN menu_items m
      ON m.id = oi.menu_item_id

    WHERE o.restaurant_id = $1

      AND o.payment_status = 'paid'

      AND oi.order_deal_id IS NULL

    GROUP BY
      m.id,
      m.name

    ORDER BY
      qty DESC

    LIMIT 10
    `,
    [restaurantId]
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
      AND o.paid_at::date
      BETWEEN $2 AND $3
    `;

    params.push(from, to);

  } else {

    dateFilter = `
      AND o.payment_status = 'paid'
    `;

  }

  const result = await pool.query(
    `
    SELECT
      COALESCE(
        o.payment_method,
        'Other'
      ) AS payment_method,

      COUNT(*) AS orders

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