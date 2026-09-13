const pool = require('../config/db');

const getCategories = async (restaurantId) => {
  const result = await pool.query(
    `
    SELECT
      id,
      name,
      restaurant_id,
      active,
      created_at
    FROM menu_categories
    WHERE restaurant_id = $1
      AND active = true
    ORDER BY name
    `,
    [restaurantId]
  );

  return result.rows;
};

const findCategory = async (name, restaurantId) => {
  const result = await pool.query(
    `
    SELECT id, name, restaurant_id, active
    FROM menu_categories
    WHERE restaurant_id = $1
      AND LOWER(TRIM(name)) = LOWER(TRIM($2))
    LIMIT 1
    `,
    [restaurantId, name]
  );

  return result.rows[0];
};

const createCategory = async (
  name,
  restaurantId
) => {
  const result = await pool.query(
    `
    INSERT INTO menu_categories
      (name, restaurant_id, active)
    VALUES
      ($1, $2, true)
    RETURNING *
    `,
    [name, restaurantId]
  );

  return result.rows[0];
};


const reactivateCategory = async (
  id,
  restaurantId
) => {
  const result = await pool.query(
    `
    UPDATE menu_categories
    SET active = true
    WHERE id = $1
      AND restaurant_id = $2
    RETURNING *
    `,
    [id, restaurantId]
  );

  return result.rows[0];
};

const updateCategory = async (
  id,
  name,
  restaurantId
) => {
  const result = await pool.query(
    `
    UPDATE menu_categories
    SET name = $1
    WHERE id = $2
      AND restaurant_id = $3
      AND active = true
    RETURNING *
    `,
    [name, id, restaurantId]
  );

  return result.rows[0];
};

const deactivateCategory = async (
  id,
  restaurantId
) => {
  const result = await pool.query(
    `
    UPDATE menu_categories
    SET active = false
    WHERE id = $1
      AND restaurant_id = $2
    RETURNING *
    `,
    [id, restaurantId]
  );

  return result.rows[0];
};

const categoryHasMenuItems = async (
  categoryName,
  restaurantId
) => {
  const result = await pool.query(
    `
    SELECT id
    FROM menu_items
    WHERE restaurant_id = $1
      AND active = true
      AND LOWER(TRIM(category)) = LOWER(TRIM($2))
    LIMIT 1
    `,
    [restaurantId, categoryName]
  );

  return result.rowCount > 0;
};

module.exports = {
  getCategories,
  findCategory,
  createCategory,
  reactivateCategory,
  updateCategory,
  deactivateCategory,
  categoryHasMenuItems
};
