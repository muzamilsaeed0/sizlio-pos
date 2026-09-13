const pool = require('../config/db');

const getVariantsForItem = async (menuItemId, restaurantId) => {
  const result = await pool.query(
    `
    SELECT miv.id, miv.menu_item_id, miv.label, miv.price
    FROM menu_item_variants miv
    JOIN menu_items mi
      ON mi.id = miv.menu_item_id
    WHERE miv.menu_item_id = $1
      AND miv.active = true
      AND mi.restaurant_id = $2
    ORDER BY miv.price
    `,
    [menuItemId, restaurantId]
  );

  return result.rows;
};

const findMenuItemForRestaurant = async (menuItemId, restaurantId) => {
  const result = await pool.query(
    `
    SELECT id
    FROM menu_items
    WHERE id = $1
      AND restaurant_id = $2
      AND active = true
    `,
    [menuItemId, restaurantId]
  );

  return result.rows[0];
};

const createVariant = async (menuItemId, label, price) => {
  const result = await pool.query(
    `
    INSERT INTO menu_item_variants
      (menu_item_id, label, price, active)
    VALUES
      ($1, $2, $3, true)
    RETURNING *
    `,
    [menuItemId, label, price]
  );

  return result.rows[0];
};

const updateVariant = async (id, label, price, restaurantId) => {
  const result = await pool.query(
    `
    UPDATE menu_item_variants miv
    SET
      label = $1,
      price = $2
    FROM menu_items mi
    WHERE miv.id = $3
      AND miv.menu_item_id = mi.id
      AND mi.restaurant_id = $4
      AND miv.active = true
    RETURNING miv.*
    `,
    [label, price, id, restaurantId]
  );

  return result.rows[0];
};

const deactivateVariant = async (id, restaurantId) => {
  const result = await pool.query(
    `
    UPDATE menu_item_variants miv
    SET active = false
    FROM menu_items mi
    WHERE miv.id = $1
      AND miv.menu_item_id = mi.id
      AND mi.restaurant_id = $2
    RETURNING miv.*
    `,
    [id, restaurantId]
  );

  return result.rows[0];
};

module.exports = {
  getVariantsForItem,
  findMenuItemForRestaurant,
  createVariant,
  updateVariant,
  deactivateVariant
};
