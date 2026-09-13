const pool = require('../config/db');

const getAllMenuItems = async (restaurantId) => {

  const result = await pool.query(
    `
    SELECT
      mi.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', miv.id,
            'label', miv.label,
            'price', miv.price
          )
          ORDER BY miv.price
        ) FILTER (WHERE miv.id IS NOT NULL),
        '[]'::json
      ) AS variants
    FROM menu_items mi
    LEFT JOIN menu_item_variants miv
      ON miv.menu_item_id = mi.id
      AND miv.active = true
    WHERE mi.active = true
      AND mi.restaurant_id = $1
    GROUP BY mi.id
    ORDER BY mi.id
    `,
    [restaurantId]
  );

  return result.rows;

};

const createMenuItem = async (
  name,
  price,
  category,
  restaurantId
) => {

  // Duplicate check
  const exists = await pool.query(
    `
    SELECT id
    FROM menu_items
    WHERE restaurant_id = $1
      AND LOWER(name) = LOWER($2)
      AND active = true
    `,
    [restaurantId, name]
  );

  if (exists.rowCount) {
    throw new Error('Menu item already exists');
  }

  const image =
    '/images/' +
    name
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/\s+/g, '-')
      .replace(/[^\w-]/g, '') +
    '.jpg';

  const result = await pool.query(
    `
    INSERT INTO menu_items
    (name, price, category, image, restaurant_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
    `,
    [
      name,
      price,
      category || 'Other',
      image,
      restaurantId
    ]
  );

  return result.rows[0];

};

const updateMenuItem = async (
  id,
  name,
  price,
  category,
  restaurantId
) => {

  // Duplicate check
  const exists = await pool.query(
    `
    SELECT id
    FROM menu_items
    WHERE restaurant_id = $1
      AND LOWER(name) = LOWER($2)
      AND id <> $3
      AND active = true
    `,
    [restaurantId, name, id]
  );

  if (exists.rowCount) {
    throw new Error('Menu item already exists');
  }

  const result = await pool.query(
    `
    UPDATE menu_items
    SET
      name = $1,
      price = $2,
      category = $3
    WHERE id = $4
      AND restaurant_id = $5
    RETURNING *
    `,
    [
      name,
      price,
      category || 'Other',
      id,
      restaurantId
    ]
  );

  return result.rows[0];

};

const deactivateMenuItem = async (
  id,
  restaurantId
) => {

  const result = await pool.query(
    `
    UPDATE menu_items
    SET active = false
    WHERE id = $1
      AND restaurant_id = $2
    RETURNING *
    `,
    [id, restaurantId]
  );

  return result.rows[0];

};

module.exports = {
  getAllMenuItems,
  createMenuItem,
  updateMenuItem,
  deactivateMenuItem
};