const pool = require('../config/db');

const ITEMS_AGG = `
  COALESCE(
    json_agg(
      json_build_object(
        'menu_item_id', di.menu_item_id,
        'variant_id', di.variant_id,
        'quantity', di.quantity,
        'name', mi.name,
        'category', mi.category,
        'variant_label', miv.label,
        'price', COALESCE(miv.price, mi.price)
      )
      ORDER BY mi.name
    ) FILTER (WHERE di.id IS NOT NULL),
    '[]'::json
  ) AS items
`;

// Validate every deal component against the same restaurant before writes.
const validateDealItems = async (client, items, restaurantId) => {
  if (!Array.isArray(items)) {
    const error = new Error('Deal items must be an array');
    error.code = 'INVALID_DEAL_ITEMS';
    throw error;
  }

  for (const item of items) {
    const menuItemId = Number(item?.menu_item_id);
    const variantId = item?.variant_id == null || item.variant_id === ''
      ? null
      : Number(item.variant_id);
    const quantity = Number(item?.quantity);

    if (!Number.isInteger(menuItemId) || menuItemId <= 0 ||
        (variantId !== null && (!Number.isInteger(variantId) || variantId <= 0)) ||
        !Number.isFinite(quantity) || quantity <= 0) {
      const error = new Error('Invalid deal item');
      error.code = 'INVALID_DEAL_ITEM';
      throw error;
    }

    const result = await client.query(
      `
      SELECT mi.id
      FROM menu_items mi
      LEFT JOIN menu_item_variants miv
        ON miv.id = $2
       AND miv.menu_item_id = mi.id
       AND miv.active = true
      WHERE mi.id = $1
        AND mi.restaurant_id = $3
        AND mi.active = true
        AND ($2::integer IS NULL OR miv.id IS NOT NULL)
      FOR UPDATE OF mi
      `,
      [menuItemId, variantId, restaurantId]
    );

    if (!result.rows[0]) {
      const error = new Error('Deal item or variant not found for this restaurant');
      error.code = 'INVALID_DEAL_ITEM';
      throw error;
    }
  }
};

const getAllDeals = async (restaurantId) => {
  const result = await pool.query(
    `
    SELECT
      d.id,
      d.name,
      d.price,
      d.type,
      d.category,
      d.image,
      d.active,
      d.created_at,
      ${ITEMS_AGG}
    FROM deals d
    LEFT JOIN deal_items di
      ON di.deal_id = d.id
    LEFT JOIN menu_items mi
      ON mi.id = di.menu_item_id
     AND mi.restaurant_id = d.restaurant_id
    LEFT JOIN menu_item_variants miv
      ON miv.id = di.variant_id
     AND miv.menu_item_id = mi.id
    WHERE d.restaurant_id = $1
      AND d.active = true
    GROUP BY d.id
    ORDER BY d.id DESC
    `,
    [restaurantId]
  );

  return result.rows;
};


const getDealById = async (id, restaurantId) => {
  const result = await pool.query(
    `
    SELECT
      d.id,
      d.name,
      d.price,
      d.type,
      d.category,
      d.image,
      d.active,
      ${ITEMS_AGG}
    FROM deals d
    LEFT JOIN deal_items di
      ON di.deal_id = d.id
    LEFT JOIN menu_items mi
      ON mi.id = di.menu_item_id
     AND mi.restaurant_id = d.restaurant_id
    LEFT JOIN menu_item_variants miv
      ON miv.id = di.variant_id
     AND miv.menu_item_id = mi.id
    WHERE d.id = $1
      AND d.restaurant_id = $2
      AND d.active = true
    GROUP BY d.id
    `,
    [id, restaurantId]
  );

  return result.rows[0];
};


const createDeal = async (
  name,
  price,
  type,
  category,
  image,
  restaurantId,
  items
) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await validateDealItems(client, items, restaurantId);
    const dealResult = await client.query(
      `
      INSERT INTO deals
        (name, price, type, category, image, restaurant_id)
      VALUES
        ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        name,
        price,
        type || 'deal',
        category || null,
        image || null,
        restaurantId
      ]
    );
    const deal = dealResult.rows[0];
    for (const item of items) {
      await client.query(
        `
        INSERT INTO deal_items
          (deal_id, menu_item_id, variant_id, quantity)
        VALUES
          ($1, $2, $3, $4)
        `,
        [
          deal.id,
          item.menu_item_id,
          item.variant_id || null,
          item.quantity
        ]
      );
    }
    await client.query('COMMIT');
    return getDealById(
      deal.id,
      restaurantId
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};


const updateDeal = async (
  id,
  name,
  price,
  type,
  category,
  image,
  restaurantId,
  items
) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await validateDealItems(client, items, restaurantId);
    const updateResult = await client.query(
      `
      UPDATE deals
      SET
        name = $1,
        price = $2,
        type = $3,
        category = $4,
        image = $5
      WHERE id = $6
        AND restaurant_id = $7
        AND active = true
      RETURNING *
      `,
      [
        name,
        price,
        type || 'deal',
        category || null,
        image || null,
        id,
        restaurantId
      ]
    );

    if (!updateResult.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `
      DELETE FROM deal_items
      WHERE deal_id = $1
      `,
      [id]
    );

    for (const item of items) {
      await client.query(
        `
        INSERT INTO deal_items
          (deal_id, menu_item_id, variant_id, quantity)
        VALUES
          ($1, $2, $3, $4)
        `,
        [
          id,
          item.menu_item_id,
          item.variant_id || null,
          item.quantity
        ]
      );
    }

    await client.query('COMMIT');

    return getDealById(
      id,
      restaurantId
    );

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};


const deactivateDeal = async (
  id,
  restaurantId
) => {
  const result = await pool.query(
    `
    UPDATE deals
    SET active = false
    WHERE id = $1
      AND restaurant_id = $2
      AND active = true
    RETURNING *
    `,
    [id, restaurantId]
  );

  return result.rows[0];
};


module.exports = {
  getAllDeals,
  getDealById,
  createDeal,
  updateDeal,
  deactivateDeal
};