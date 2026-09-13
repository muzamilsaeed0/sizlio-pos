// server/routes/kitchenInventoryRoutes.js

const express = require('express');
const router = express.Router();
const pool = require('../config/db');  // ✅ YAHAN ADD KARO
const { authMiddleware, authorize } = require('../middleware/authMiddleware');

// ======================================================
// GET KITCHEN STOCK
// ======================================================
router.get('/', authMiddleware, async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  try {
    const result = await pool.query(
      `SELECT 
         ki.*,
         ii.name,
         ii.category,
         ii.unit,
         ii.minimum_stock
       FROM kitchen_inventory ki
       JOIN inventory_items ii ON ii.id = ki.inventory_id
       WHERE ki.restaurant_id = $1`,
      [restaurantId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ======================================================
// GET KITCHEN STOCK HISTORY (for a specific item)
// ======================================================
router.get('/:inventoryId/transactions', authMiddleware, async (req, res) => {
  const { inventoryId } = req.params;
  const restaurantId = req.user.restaurant_id;

  try {
    // Get kitchen_inventory id for this inventory item
    const kitchenItem = await pool.query(
      `SELECT id FROM kitchen_inventory 
       WHERE restaurant_id = $1 AND inventory_id = $2`,
      [restaurantId, inventoryId]
    );
    if (kitchenItem.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Item not found in kitchen' });
    }

    const kitchenInventoryId = kitchenItem.rows[0].id;

    const result = await pool.query(
      `SELECT 
         kit.*,
         ki.unit
       FROM kitchen_inventory_transactions kit
       JOIN kitchen_inventory ki ON ki.id = kit.kitchen_inventory_id
       WHERE kit.kitchen_inventory_id = $1
       ORDER BY kit.created_at DESC`,
      [kitchenInventoryId]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ======================================================
// CREATE REQUEST (kitchen asks for stock)
// ======================================================
router.post('/requests', authMiddleware, authorize('kitchen', 'manager'), async (req, res) => {
  const { inventory_id, requested_quantity, note } = req.body;
  const restaurantId = req.user.restaurant_id;
  const requestedBy = req.user.id;

  if (!inventory_id || !requested_quantity || requested_quantity <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid input' });
  }

  try {
    // Check if item exists in warehouse
    const itemCheck = await pool.query(
      `SELECT id FROM inventory_items WHERE id = $1 AND restaurant_id = $2`,
      [inventory_id, restaurantId]
    );
    if (itemCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Item not found in warehouse' });
    }

    const result = await pool.query(
      `INSERT INTO kitchen_inventory_requests 
       (restaurant_id, inventory_id, requested_quantity, note, requested_by, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [restaurantId, inventory_id, requested_quantity, note, requestedBy]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ======================================================
// GET REQUESTS
// ======================================================
router.get('/requests', authMiddleware, authorize('kitchen', 'manager'), async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const status = req.query.status || 'all';

  try {
    let query = `
      SELECT 
        r.*,
        i.name AS inventory_name,
        i.unit,
        i.stock_quantity AS warehouse_stock,
        u.full_name AS requested_by_name,
        au.full_name AS approved_by_name
      FROM kitchen_inventory_requests r
      JOIN inventory_items i ON i.id = r.inventory_id
      LEFT JOIN users u ON u.id = r.requested_by
      LEFT JOIN users au ON au.id = r.approved_by
      WHERE r.restaurant_id = $1
      AND i.restaurant_id = $1
    `;
    const values = [restaurantId];

    if (status !== 'all') {
      query += ` AND r.status = $2`;
      values.push(status);
    }
    query += ` ORDER BY r.created_at DESC`;

    const result = await pool.query(query, values);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ======================================================
// APPROVE KITCHEN REQUEST
// ======================================================
router.put('/requests/:requestId/approve', authMiddleware, authorize('manager'), async (req, res) => {
  const { requestId } = req.params;
  const restaurantId = req.user.restaurant_id;
  const approvedBy = req.user.id;

  try {
    const client = await pool.connect();
    let result;

    try {
      await client.query('BEGIN');

      // 1. Get request
      const requestResult = await client.query(
        `SELECT * FROM kitchen_inventory_requests 
         WHERE id = $1 AND restaurant_id = $2 AND status = 'pending'
         FOR UPDATE`,
        [requestId, restaurantId]
      );

      if (requestResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Request not found or already processed' });
      }

      const request = requestResult.rows[0];
      const qty = Number(request.requested_quantity);

      // 2. Check warehouse stock
      const warehouseResult = await client.query(
        `SELECT stock_quantity FROM inventory_items 
         WHERE id = $1 AND restaurant_id = $2
         FOR UPDATE`,
        [request.inventory_id, restaurantId]
      );

      if (warehouseResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Item not found in warehouse' });
      }

      const currentStock = Number(warehouseResult.rows[0].stock_quantity);
      if (currentStock < qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          success: false, 
          message: `Insufficient stock (available: ${currentStock})` 
        });
      }

      // 3. Deduct warehouse stock
      await client.query(
        `UPDATE inventory_items SET stock_quantity = stock_quantity - $1 
         WHERE id = $2 AND restaurant_id = $3`,
        [qty, request.inventory_id, restaurantId]
      );

      // 3.5 Log this deduction in the WAREHOUSE-SIDE transaction table
      //     (inventory_transactions) so it appears in the Manager's
      //     Inventory Management "History" modal and "Recent Transactions".
      //     Without this insert, the stock number changes but no visible
      //     record is ever created for it.
      await client.query(
        `INSERT INTO inventory_transactions 
         (inventory_id, type, quantity, note)
         VALUES ($1, 'OUT', $2, $3)`,
        [request.inventory_id, qty, `Transferred to kitchen (request #${requestId})`]
      );

      // 4. Add to kitchen inventory
      await client.query(
        `INSERT INTO kitchen_inventory (restaurant_id, inventory_id, quantity, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (restaurant_id, inventory_id)
         DO UPDATE SET quantity = kitchen_inventory.quantity + EXCLUDED.quantity,
                        updated_at = NOW()`,
        [restaurantId, request.inventory_id, qty]
      );

      // 5. Get kitchen_inventory_id for transaction
      const kitchenItemResult = await client.query(
        `SELECT id FROM kitchen_inventory 
         WHERE restaurant_id = $1 AND inventory_id = $2`,
        [restaurantId, request.inventory_id]
      );

      if (kitchenItemResult.rows.length > 0) {
        const kitchenInventoryId = kitchenItemResult.rows[0].id;
        // Log kitchen IN transaction (kitchen-side history — separate table)
        await client.query(
          `INSERT INTO kitchen_inventory_transactions 
           (kitchen_inventory_id, type, quantity, note)
           VALUES ($1, 'IN', $2, $3)`,
          [kitchenInventoryId, qty, `Request #${requestId} approved`]
        );
      }

      // 6. Update request status
      result = await client.query(
        `UPDATE kitchen_inventory_requests 
         SET status = 'approved', approved_by = $1, updated_at = NOW()
         WHERE id = $2 AND restaurant_id = $3
         RETURNING *`,
        [approvedBy, requestId, restaurantId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true, message: 'Request approved', data: result.rows[0] });

  } catch (err) {
    console.error('Approve request error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ======================================================
// REJECT KITCHEN REQUEST
// ======================================================
router.put('/requests/:requestId/reject', authMiddleware, authorize('manager'), async (req, res) => {
  const { requestId } = req.params;
  const { reason } = req.body;
  const restaurantId = req.user.restaurant_id;
  const approvedBy = req.user.id;

  try {
    const result = await pool.query(
      `UPDATE kitchen_inventory_requests 
       SET status = 'rejected', 
           rejection_reason = $1,
           approved_by = $2, 
           updated_at = NOW()
       WHERE id = $3 AND restaurant_id = $4 AND status = 'pending'
       RETURNING *`,
      [reason || 'No reason provided', approvedBy, requestId, restaurantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found or already processed' });
    }

    res.json({ success: true, message: 'Request rejected', data: result.rows[0] });
  } catch (err) {
    console.error('Reject request error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;