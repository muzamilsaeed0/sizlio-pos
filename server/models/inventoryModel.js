const pool = require("../config/db");

// ======================================================
// GET ALL INVENTORY ITEMS
// ======================================================

async function getAllItems(restaurantId, status = "all") {
  let query = `
    SELECT
      id,
      name,
      category,
      unit,
      package_size,
      package_unit,
      stock_quantity,
      minimum_stock,
      purchase_price,
      supplier,
      restaurant_id,
      created_at,
      is_active,
      CASE
        WHEN stock_quantity <= minimum_stock THEN true
        ELSE false
      END AS low_stock
    FROM inventory_items
    WHERE restaurant_id = $1
  `;

  const values = [restaurantId];

  if (status === "active") {
    query += ` AND is_active = TRUE`;
  }

  if (status === "inactive") {
    query += ` AND is_active = FALSE`;
  }

  query += `
    ORDER BY name ASC
  `;

  const result = await pool.query(query, values);

  return result.rows;
}

// ======================================================
// GET SINGLE INVENTORY ITEM
// ======================================================

async function getItemById(id, restaurantId) {
  const query = `
    SELECT
      id,
      name,
      category,
      unit,
      package_size,
      package_unit,
      stock_quantity,
      minimum_stock,
      purchase_price,
      supplier,
      restaurant_id,
      created_at,
      is_active,
      CASE
        WHEN stock_quantity <= minimum_stock THEN true
        ELSE false
      END AS low_stock
    FROM inventory_items
    WHERE id = $1
      AND restaurant_id = $2
  `;

  const result = await pool.query(query, [
    id,
    restaurantId
  ]);

  return result.rows[0] || null;
}

// ======================================================
// CREATE INVENTORY ITEM
// ======================================================

async function createItem({
  name,
  category = "Other",
  unit,
  package_size = null,
  package_unit = null,
  stock_quantity = 0,
  minimum_stock = 0,
  purchase_price = 0,
  supplier = null,
  restaurant_id
}) {
  const query = `
    INSERT INTO inventory_items (
      name,
      category,
      unit,
      package_size,
      package_unit,
      stock_quantity,
      minimum_stock,
      purchase_price,
      supplier,
      restaurant_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `;

  const values = [
    name,
    category,
    unit,
    package_size,
    package_unit,
    stock_quantity,
    minimum_stock,
    purchase_price,
    supplier,
    restaurant_id
  ];

  const result = await pool.query(query, values);

  return result.rows[0];
}

// ======================================================
// UPDATE INVENTORY ITEM
// ======================================================

async function updateItem(id, restaurantId, data) {
  const allowedFields = {
    name: "name",
    category: "category",
    unit: "unit",
    package_size: "package_size",
    package_unit: "package_unit",
    minimum_stock: "minimum_stock",
    purchase_price: "purchase_price",
    supplier: "supplier"
  };

  const updates = [];
  const values = [];

  let index = 1;

  for (const [key, column] of Object.entries(allowedFields)) {
    if (data[key] !== undefined) {
      updates.push(`${column} = $${index}`);
      values.push(data[key]);
      index++;
    }
  }

  if (updates.length === 0) {
    return getItemById(id, restaurantId);
  }

  values.push(id);
  values.push(restaurantId);

  const query = `
    UPDATE inventory_items
    SET ${updates.join(", ")}
    WHERE id = $${index}
      AND restaurant_id = $${index + 1}
    RETURNING *
  `;

  const result = await pool.query(query, values);

  return result.rows[0] || null;
}

// ======================================================
// ACTIVATE / DEACTIVATE INVENTORY ITEM
// ======================================================

async function setItemActive(id, restaurantId, isActive) {
  const query = `
    UPDATE inventory_items
    SET is_active = $1
    WHERE id = $2
      AND restaurant_id = $3
    RETURNING *
  `;

  const result = await pool.query(query, [
    isActive,
    id,
    restaurantId
  ]);

  return result.rows[0] || null;
}

// ======================================================
// ADD INVENTORY TRANSACTION
// IN / OUT / ADJUSTMENT
// ======================================================

async function addTransaction({
  inventory_id,
  restaurant_id,
  type,
  quantity,
  note = null
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const itemResult = await client.query(
      `
        SELECT
          id,
          stock_quantity,
          is_active
        FROM inventory_items
        WHERE id = $1
          AND restaurant_id = $2
        FOR UPDATE
      `,
      [
        inventory_id,
        restaurant_id
      ]
    );

    if (itemResult.rows.length === 0) {
      throw new Error("Inventory item not found");
    }

    const item = itemResult.rows[0];

    if (!item.is_active) {
      throw new Error("Inventory item is inactive");
    }

    const currentStock =
      Number(item.stock_quantity);

    const amount =
      Number(quantity);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      throw new Error(
        "Quantity must be greater than 0"
      );
    }

    const normalizedType =
      String(type).trim().toLowerCase();

    let newStock;
    let transactionType;

    // ==================================================
    // STOCK IN
    // ==================================================

    if (
      [
        "in",
        "purchase",
        "add",
        "restock"
      ].includes(normalizedType)
    ) {
      newStock =
        currentStock + amount;

      transactionType = "IN";
    }

    // ==================================================
    // STOCK OUT
    // ==================================================

    else if (
      [
        "out",
        "usage",
        "sale",
        "remove",
        "waste"
      ].includes(normalizedType)
    ) {
      newStock =
        currentStock - amount;

      if (newStock < 0) {
        throw new Error(
          "Insufficient stock"
        );
      }

      transactionType = "OUT";
    }

    // ==================================================
    // STOCK ADJUSTMENT
    // ==================================================

    else if (
      normalizedType === "adjustment"
    ) {
      newStock = amount;
      transactionType = "ADJUSTMENT";
    }

    else {
      throw new Error(
        "Invalid transaction type"
      );
    }

    // ==================================================
    // CREATE TRANSACTION
    // ==================================================

    const transactionResult =
      await client.query(
        `
          INSERT INTO inventory_transactions (
            inventory_id,
            type,
            quantity,
            note
          )
          VALUES ($1,$2,$3,$4)
          RETURNING *
        `,
        [
          inventory_id,
          transactionType,
          amount,
          note
        ]
      );

    // ==================================================
    // UPDATE STOCK
    // ==================================================

    const itemUpdate =
      await client.query(
        `
          UPDATE inventory_items
          SET stock_quantity = $1
          WHERE id = $2
            AND restaurant_id = $3
          RETURNING *
        `,
        [
          newStock,
          inventory_id,
          restaurant_id
        ]
      );

    await client.query("COMMIT");

    return {
      transaction:
        transactionResult.rows[0],

      item:
        itemUpdate.rows[0]
    };

  } catch (error) {

    await client.query("ROLLBACK");

    throw error;

  } finally {

    client.release();

  }
}

// ======================================================
// GET INVENTORY TRANSACTIONS
// ======================================================

async function getTransactions(
  inventoryId,
  restaurantId
) {
  const query = `
    SELECT
      t.id,
      t.inventory_id,
      t.type,
      t.quantity,
      t.note,
      t.created_at,
      i.name AS inventory_name,
      i.unit
    FROM inventory_transactions t

    INNER JOIN inventory_items i
      ON i.id = t.inventory_id

    WHERE t.inventory_id = $1
      AND i.restaurant_id = $2

    ORDER BY
      t.created_at DESC,
      t.id DESC
  `;

  const result =
    await pool.query(
      query,
      [
        inventoryId,
        restaurantId
      ]
    );

  return result.rows;
}

// ======================================================
// GET RECIPE
// ======================================================

async function getRecipe(
  menuItemId,
  restaurantId,
  variantId = null 
) {
  let query = `
    SELECT
      mii.id,
      mii.menu_item_id,
      mii.inventory_id,
      mii.variant_id,
      mii.quantity,
      mii.created_at,

      i.name AS inventory_name,
      i.unit,
      i.package_size,
      i.package_unit,
      i.stock_quantity,
      i.purchase_price,

      miv.label AS variant_label

    FROM menu_item_ingredients mii

    INNER JOIN inventory_items i
      ON i.id = mii.inventory_id

    INNER JOIN menu_items m
      ON m.id = mii.menu_item_id

    LEFT JOIN menu_item_variants miv
      ON miv.id = mii.variant_id

    WHERE mii.menu_item_id = $1
      AND m.restaurant_id = $2
  `;
  
  const params = [menuItemId, restaurantId];

  
  if (variantId !== null) {
    query += ` AND mii.variant_id = $3`;
    params.push(variantId);
  } else {
    
    query += ` AND mii.variant_id IS NULL`;
  }

  query += ` ORDER BY i.name ASC`;

  const result = await pool.query(query, params);
  return result.rows;
}

// ======================================================
// ADD RECIPE INGREDIENT
// ======================================================

async function addRecipeIngredient({
  menu_item_id,
  inventory_id,
  variant_id = null,
  quantity,
  restaurant_id
}) {
  // Check inventory item
  const inventoryItem =
    await getItemById(
      inventory_id,
      restaurant_id
    );

  if (!inventoryItem) {
    throw new Error(
      "Inventory item not found"
    );
  }

  // Check menu item
  const menuCheck =
    await pool.query(
      `
        SELECT id
        FROM menu_items
        WHERE id = $1
          AND restaurant_id = $2
      `,
      [
        menu_item_id,
        restaurant_id
      ]
    );

  if (menuCheck.rows.length === 0) {
    throw new Error(
      "Menu item not found"
    );
  }

  // Normalize + validate variant_id: must belong to this
  // menu item if provided, otherwise it applies to every
  // variant (or to the item itself if it has none).
  let normalizedVariantId = null;

  if (
    variant_id !== null &&
    variant_id !== undefined &&
    String(variant_id).trim() !== ""
  ) {
    const variantCheck =
      await pool.query(
        `
          SELECT id
          FROM menu_item_variants
          WHERE id = $1
            AND menu_item_id = $2
        `,
        [
          variant_id,
          menu_item_id
        ]
      );

    if (variantCheck.rows.length === 0) {
      throw new Error(
        "Variant not found for this menu item"
      );
    }

    normalizedVariantId = Number(variant_id);
  }

  // Validate quantity
  if (
    !Number.isFinite(Number(quantity)) ||
    Number(quantity) <= 0
  ) {
    throw new Error(
      "Quantity must be greater than 0"
    );
  }

  // Add ingredient
  const query = `
    INSERT INTO menu_item_ingredients (
      menu_item_id,
      inventory_id,
      variant_id,
      quantity
    )
    VALUES ($1,$2,$3,$4)
    RETURNING *
  `;

  const result =
    await pool.query(
      query,
      [
        menu_item_id,
        inventory_id,
        normalizedVariantId,
        quantity
      ]
    );

  return result.rows[0];
}


// ======================================================
// UPDATE RECIPE INGREDIENT
// ======================================================

async function updateRecipeIngredient(
  id,
  quantity,
  restaurantId
) {
  const query = `
    UPDATE menu_item_ingredients mii

    SET quantity = $1

    FROM inventory_items i

    WHERE mii.id = $2
      AND i.id = mii.inventory_id
      AND i.restaurant_id = $3

    RETURNING mii.*
  `;

  const result =
    await pool.query(
      query,
      [
        quantity,
        id,
        restaurantId
      ]
    );

  return result.rows[0] || null;
}

// ======================================================
// DELETE RECIPE INGREDIENT
// ======================================================

async function deleteRecipeIngredient(
  id,
  restaurantId
) {
  const query = `
    DELETE FROM menu_item_ingredients mii

    USING inventory_items i

    WHERE mii.id = $1
      AND i.id = mii.inventory_id
      AND i.restaurant_id = $2

    RETURNING mii.*
  `;

  const result =
    await pool.query(
      query,
      [
        id,
        restaurantId
      ]
    );

  return result.rows[0] || null;
}

// ======================================================
// INVENTORY DASHBOARD
// ======================================================

async function getDashboard(restaurantId) {
  const summaryQuery = `
    SELECT
      COUNT(*)::int AS total_items,

      COUNT(*)
        FILTER (WHERE is_active = TRUE)::int
        AS active_items,

      COUNT(*)
        FILTER (
          WHERE is_active = TRUE
          AND stock_quantity <= minimum_stock
        )::int
        AS low_stock_items,

      -- ✅ FIX 1: Healthy items
      COUNT(*)
        FILTER (
          WHERE is_active = TRUE
          AND stock_quantity > minimum_stock
        )::int
        AS healthy_items,

      -- ✅ FIX 2: Rename to match frontend expectation
      COALESCE(
        SUM(
          stock_quantity * purchase_price
        )
        FILTER (WHERE is_active = TRUE),
        0
      ) AS total_stock_value

    FROM inventory_items
    WHERE restaurant_id = $1
  `;

  const lowStockQuery = `
    SELECT
      id,
      name,
      category,
      unit,
      stock_quantity,
      minimum_stock,
      purchase_price,
      supplier
    FROM inventory_items
    WHERE restaurant_id = $1
      AND is_active = TRUE
      AND stock_quantity <= minimum_stock
    ORDER BY stock_quantity ASC, name ASC
  `;

  const todayTransactionsQuery = `
    SELECT
      COALESCE(
        SUM(CASE WHEN type = 'IN' THEN quantity ELSE 0 END),
        0
      ) AS today_stock_in,

      COALESCE(
        SUM(CASE WHEN type = 'OUT' THEN quantity ELSE 0 END),
        0
      ) AS today_stock_out

    FROM inventory_transactions t
    INNER JOIN inventory_items i ON i.id = t.inventory_id
    WHERE i.restaurant_id = $1
      AND t.created_at >= CURRENT_DATE
      AND t.created_at < CURRENT_DATE + INTERVAL '1 day'
  `;

  const recentTransactionsQuery = `
    SELECT
      t.id,
      t.inventory_id,
      t.type,
      t.quantity,
      t.note,
      t.created_at,
      i.name,
      i.unit
    FROM inventory_transactions t
    INNER JOIN inventory_items i ON i.id = t.inventory_id
    WHERE i.restaurant_id = $1
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT 10
  `;

  const [
    summaryResult,
    lowStockResult,
    todayResult,
    recentResult
  ] = await Promise.all([
    pool.query(summaryQuery, [restaurantId]),
    pool.query(lowStockQuery, [restaurantId]),
    pool.query(todayTransactionsQuery, [restaurantId]),
    pool.query(recentTransactionsQuery, [restaurantId])
  ]);

  // Flatten summary so frontend can use data.dashboard directly
  const summary = summaryResult.rows[0] || {};

  return {
    dashboard: {
      total_items: Number(summary.total_items || 0),
      active_items: Number(summary.active_items || 0),
      low_stock_items: Number(summary.low_stock_items || 0),
      healthy_items: Number(summary.healthy_items || 0),
      total_stock_value: Number(summary.total_stock_value || 0)
    },
    today: {
      today_stock_in: Number(todayResult.rows[0]?.today_stock_in || 0),
      today_stock_out: Number(todayResult.rows[0]?.today_stock_out || 0)
    },
    lowStock: lowStockResult.rows,
    recentTransactions: recentResult.rows
  };
}

// ======================================================
// EXPORT
// ======================================================

module.exports = {
  getAllItems,
  getItemById,
  createItem,
  updateItem,
  setItemActive,
  addTransaction,
  getTransactions,
  getRecipe,
  addRecipeIngredient,
  updateRecipeIngredient,
  deleteRecipeIngredient,
  getDashboard
};