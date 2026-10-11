const pool = require("../config/db");

// ======================================================
// GET KITCHEN STOCK
// (what's currently held in the kitchen, separate from
//  warehouse inventory_items.stock_quantity)
// ======================================================

async function getKitchenStock(restaurantId) {
  const query = `
    SELECT
      k.id,
      k.inventory_id,
      k.quantity,
      k.updated_at,

      i.name,
      i.category,
      i.unit,
      i.minimum_stock

    FROM kitchen_inventory k

    INNER JOIN inventory_items i
      ON i.id = k.inventory_id

    WHERE k.restaurant_id = $1
      AND i.restaurant_id = $1

    ORDER BY i.name ASC
  `;

  const result = await pool.query(query, [restaurantId]);

  return result.rows;
}

// ======================================================
// CREATE DEMAND REQUEST (kitchen asks for stock)
// ======================================================

async function createRequest({
  restaurant_id,
  inventory_id,
  requested_quantity,
  note = null,
  requested_by
}) {
  const inventoryId = Number(inventory_id);
  const qty = Number(requested_quantity);

  if (!Number.isInteger(inventoryId) || inventoryId <= 0) {
    throw new Error("A valid inventory item is required");
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error("Requested quantity must be greater than 0");
  }

  // Keep model-level validation aligned with the HTTP route so direct callers
  // cannot create replenishment requests for inactive or cross-tenant items.
  const itemCheck = await pool.query(
    `SELECT id, is_active FROM inventory_items
     WHERE id = $1 AND restaurant_id = $2`,
    [inventoryId, restaurant_id]
  );

  if (itemCheck.rows.length === 0) {
    throw new Error("Inventory item not found");
  }
  if (itemCheck.rows[0].is_active === false) {
    throw new Error("Inventory item is inactive");
  }

  const query = `
    INSERT INTO kitchen_inventory_requests (
      restaurant_id,
      inventory_id,
      requested_quantity,
      note,
      requested_by,
      status
    )
    VALUES ($1,$2,$3,$4,$5,'pending')
    RETURNING *
  `;

  const result = await pool.query(query, [
    restaurant_id,
    inventory_id,
    qty,
    note,
    requested_by
  ]);

  return result.rows[0];
}

// ======================================================
// GET REQUESTS
// status = all | pending | approved | rejected
// ======================================================

async function getRequests(restaurantId, status = "all") {
  let query = `
    SELECT
      r.id,
      r.inventory_id,
      r.requested_quantity,
      r.status,
      r.note,
      r.rejection_reason,
      r.requested_by,
      r.approved_by,
      r.created_at,
      r.updated_at,

      i.name AS inventory_name,
      i.unit,
      i.stock_quantity AS warehouse_stock,

      ru.full_name AS requested_by_name,
      au.full_name AS approved_by_name

    FROM kitchen_inventory_requests r

    INNER JOIN inventory_items i
      ON i.id = r.inventory_id

    LEFT JOIN users ru
      ON ru.id = r.requested_by

    LEFT JOIN users au
      ON au.id = r.approved_by

    WHERE r.restaurant_id = $1
      AND i.restaurant_id = $1
  `;

  const values = [restaurantId];

  if (status !== "all") {
    query += ` AND r.status = $2`;
    values.push(status);
  }

  query += ` ORDER BY r.created_at DESC`;

  const result = await pool.query(query, values);

  return result.rows;
}

// ======================================================
// APPROVE REQUEST
// Deducts from warehouse inventory_items, logs an OUT
// transaction, and credits kitchen_inventory.
// ======================================================

async function approveRequest(requestId, restaurantId, approvedBy) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const reqResult = await client.query(
      `SELECT * FROM kitchen_inventory_requests
       WHERE id = $1 AND restaurant_id = $2
       FOR UPDATE`,
      [requestId, restaurantId]
    );

    if (reqResult.rows.length === 0) {
      throw new Error("Request not found");
    }

    const request = reqResult.rows[0];

    if (request.status !== "pending") {
      throw new Error("Only pending requests can be approved");
    }

    // Lock the warehouse item row
    const itemResult = await client.query(
      `SELECT id, stock_quantity, is_active FROM inventory_items
       WHERE id = $1 AND restaurant_id = $2
       FOR UPDATE`,
      [request.inventory_id, restaurantId]
    );

    if (itemResult.rows.length === 0) {
      throw new Error("Inventory item not found");
    }

    const item = itemResult.rows[0];

    if (!item.is_active) {
      throw new Error("Inventory item is inactive");
    }

    const currentStock = Number(item.stock_quantity);
    const qty = Number(request.requested_quantity);

    if (!Number.isFinite(currentStock) || !Number.isFinite(qty) || qty <= 0) {
      throw new Error("Invalid warehouse stock or requested quantity");
    }
    if (currentStock < qty) {
      throw new Error(
        `Insufficient warehouse stock (available: ${currentStock})`
      );
    }

    // Guard the deduction in SQL as well as holding the row lock.
    const warehouseUpdate = await client.query(
      `UPDATE inventory_items
       SET stock_quantity = stock_quantity - $1
       WHERE id = $2 AND restaurant_id = $3 AND stock_quantity >= $1
       RETURNING id`,
      [qty, request.inventory_id, restaurantId]
    );
    if (!warehouseUpdate.rowCount) {
      throw new Error("Warehouse stock changed during transfer; retry approval");
    }

    // Log warehouse OUT transaction
    await client.query(
      `INSERT INTO inventory_transactions (inventory_id, type, quantity, note)
       VALUES ($1,'OUT',$2,$3)`,
      [
        request.inventory_id,
        qty,
        `Transferred to kitchen (request #${requestId})`
      ]
    );

    // Credit kitchen_inventory (upsert)
    await client.query(
      `INSERT INTO kitchen_inventory (restaurant_id, inventory_id, quantity, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (restaurant_id, inventory_id)
       DO UPDATE SET
         quantity = kitchen_inventory.quantity + EXCLUDED.quantity,
         updated_at = NOW()`,
      [restaurantId, request.inventory_id, qty]
    );

    // Log the corresponding kitchen-side IN movement as well.
    const kitchenItemResult = await client.query(
      `SELECT id FROM kitchen_inventory
       WHERE restaurant_id = $1 AND inventory_id = $2`,
      [restaurantId, request.inventory_id]
    );
    if (kitchenItemResult.rows.length !== 1) {
      throw new Error("Kitchen inventory row missing after transfer");
    }
    await client.query(
      `INSERT INTO kitchen_inventory_transactions
       (kitchen_inventory_id, type, quantity, note)
       VALUES ($1, 'IN', $2, $3)`,
      [kitchenItemResult.rows[0].id, qty, `Request #${requestId} approved`]
    );

    // Mark request approved
    const updated = await client.query(
      `UPDATE kitchen_inventory_requests
       SET status = 'approved',
           approved_by = $1,
           updated_at = NOW()
       WHERE id = $2 AND restaurant_id = $3
       RETURNING *`,
      [approvedBy, requestId, restaurantId]
    );

    await client.query("COMMIT");

    return updated.rows[0];

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ======================================================
// REJECT REQUEST
// ======================================================

async function rejectRequest(requestId, restaurantId, approvedBy, reason = null) {
  const query = `
    UPDATE kitchen_inventory_requests
    SET status = 'rejected',
        approved_by = $1,
        rejection_reason = $2,
        updated_at = NOW()
    WHERE id = $3
      AND restaurant_id = $4
      AND status = 'pending'
    RETURNING *
  `;

  const result = await pool.query(query, [
    approvedBy,
    reason,
    requestId,
    restaurantId
  ]);

  if (result.rows.length === 0) {
    throw new Error("Request not found or already processed");
  }

  return result.rows[0];
}

module.exports = {
  getKitchenStock,
  createRequest,
  getRequests,
  approveRequest,
  rejectRequest
};