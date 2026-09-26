const pool = require('../config/db');

const getAllMenuItems = async (restaurantId) => {
  const result = await pool.query(
    `
    SELECT
      id, name, price, category, image, active, restaurant_id,
      package_size, package_unit
    FROM menu_items
    WHERE restaurant_id = $1
      AND active = true
    ORDER BY category, name
    `,
    [restaurantId]
  );
  return result.rows;
};

const createMenuItem = async (
  name,
  price,
  category,
  restaurantId,
  packageSize = null,
  packageUnit = null
) => {
  const exists = await pool.query(
    `
    SELECT id FROM menu_items
    WHERE restaurant_id = $1
      AND LOWER(name) = LOWER($2)
      AND active = true
    `,
    [restaurantId, name]
  );
  if (exists.rowCount) throw new Error('Menu item already exists');

  const image =
    '/images/' +
    name
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/\s+/g, '-')
      .replace(/[^\w-]/g, '') +
    '.jpg';

  const unit = packageUnit && String(packageUnit).trim()
    ? String(packageUnit).trim().toLowerCase()
    : null;
  const size =
    packageSize !== null && packageSize !== '' && !Number.isNaN(Number(packageSize))
      ? Number(packageSize)
      : null;

  const result = await pool.query(
    `
    INSERT INTO menu_items
      (name, price, category, image, restaurant_id, package_size, package_unit)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [name, price, category || 'Other', image, restaurantId, size, unit]
  );
  return result.rows[0];
};

const updateMenuItem = async (
  id,
  name,
  price,
  category,
  restaurantId,
  packageSize = null,
  packageUnit = null
) => {
  const exists = await pool.query(
    `
    SELECT id FROM menu_items
    WHERE restaurant_id = $1
      AND LOWER(name) = LOWER($2)
      AND id <> $3
      AND active = true
    `,
    [restaurantId, name, id]
  );
  if (exists.rowCount) throw new Error('Menu item already exists');

  const unit = packageUnit && String(packageUnit).trim()
    ? String(packageUnit).trim().toLowerCase()
    : null;
  const size =
    packageSize !== null && packageSize !== '' && !Number.isNaN(Number(packageSize))
      ? Number(packageSize)
      : null;

  const result = await pool.query(
    `
    UPDATE menu_items
    SET
      name = $1,
      price = $2,
      category = $3,
      package_size = $4,
      package_unit = $5
    WHERE id = $6
      AND restaurant_id = $7
    RETURNING *
    `,
    [name, price, category || 'Other', size, unit, id, restaurantId]
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