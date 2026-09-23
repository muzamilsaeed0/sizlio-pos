const pool = require('../config/db');

/* =====================================================
   SUPPLIERS — CRUD
===================================================== */

async function listSuppliers(restaurantId, filters = {}) {
  const params = [restaurantId];
  let where = 'WHERE s.restaurant_id = $1';

  if (filters.search) {
    params.push(`%${filters.search}%`);
    where += ` AND (s.name ILIKE $${params.length} OR s.phone ILIKE $${params.length})`;
  }

  if (filters.active === 'true') {
    where += ' AND s.is_active = true';
  }

  const result = await pool.query(`
    SELECT
      s.*,
      COALESCE(p.total_purchases, 0) AS total_purchases,
      COALESCE(p.total_purchase_amount, 0) AS total_purchase_amount,
      COALESCE(pay.total_payments, 0) AS total_payments,
      COALESCE(pay.total_payment_amount, 0) AS total_payment_amount,
COALESCE(p.total_paid_amount, 0) + COALESCE(pay.total_payment_amount, 0) AS total_paid_combined,
      COALESCE(s.opening_balance, 0)
        + COALESCE(p.total_purchase_amount, 0)
        - COALESCE(p.total_paid_amount, 0)
        - COALESCE(pay.total_payment_amount, 0) AS balance
    FROM suppliers s
    LEFT JOIN (
      SELECT
        supplier_id,
        COUNT(*)::int AS total_purchases,
        SUM(total_amount) AS total_purchase_amount,
        SUM(paid_amount) AS total_paid_amount
      FROM supplier_purchases
      WHERE restaurant_id = $1
      GROUP BY supplier_id
    ) p ON p.supplier_id = s.id
    LEFT JOIN (
      SELECT
        supplier_id,
        COUNT(*)::int AS total_payments,
        SUM(amount) AS total_payment_amount
      FROM supplier_payments
      WHERE restaurant_id = $1
      GROUP BY supplier_id
    ) pay ON pay.supplier_id = s.id
    ${where}
    ORDER BY s.name ASC
  `, params);

  return result.rows;
}

async function getSupplierById(id, restaurantId) {
  const result = await pool.query(
    `SELECT * FROM suppliers WHERE id = $1 AND restaurant_id = $2`,
    [id, restaurantId]
  );
  return result.rows[0] || null;
}

async function createSupplier(restaurantId, data) {
  const result = await pool.query(`
    INSERT INTO suppliers
      (restaurant_id, name, phone, email, address, opening_balance)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [
    restaurantId,
    data.name,
    data.phone || null,
    data.email || null,
    data.address || null,
    Number(data.opening_balance || 0)
  ]);
  return result.rows[0];
}

async function updateSupplier(id, restaurantId, data) {
  const result = await pool.query(`
    UPDATE suppliers SET
      name = $3,
      phone = $4,
      email = $5,
      address = $6,
      opening_balance = $7,
      is_active = COALESCE($8, is_active),
      updated_at = NOW()
    WHERE id = $1 AND restaurant_id = $2
    RETURNING *
  `, [
    id,
    restaurantId,
    data.name,
    data.phone || null,
    data.email || null,
    data.address || null,
    Number(data.opening_balance || 0),
    data.is_active
  ]);
  return result.rows[0] || null;
}

async function deleteSupplier(id, restaurantId) {
  const result = await pool.query(
    `DELETE FROM suppliers WHERE id = $1 AND restaurant_id = $2 RETURNING id`,
    [id, restaurantId]
  );
  return result.rows[0] || null;
}

/* =====================================================
   PURCHASES
===================================================== */

async function listPurchases(supplierId, restaurantId, filters = {}) {
  const params = [supplierId, restaurantId];
  let where = 'WHERE supplier_id = $1 AND restaurant_id = $2';

  if (filters.from) {
    params.push(filters.from);
    where += ` AND purchase_date >= $${params.length}`;
  }
  if (filters.to) {
    params.push(filters.to);
    where += ` AND purchase_date <= $${params.length}`;
  }

  const result = await pool.query(`
    SELECT * FROM supplier_purchases
    ${where}
    ORDER BY purchase_date DESC, id DESC
  `, params);

  return result.rows;
}

async function createPurchase(supplierId, restaurantId, data, userId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const items = Array.isArray(data.items) ? data.items : [];

    // 1. Insert purchase
    const purchaseResult = await client.query(`
      INSERT INTO supplier_purchases
        (restaurant_id, supplier_id, purchase_date, invoice_no,
         total_amount, paid_amount, note, created_by_user_id, items)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      restaurantId,
      supplierId,
      data.purchase_date || new Date().toISOString().slice(0, 10),
      data.invoice_no || null,
      Number(data.total_amount),
      Number(data.paid_amount || 0),
      data.note || null,
      userId || null,
      JSON.stringify(items)
    ]);

    const purchase = purchaseResult.rows[0];

    // 2. Auto-increment inventory with Weighted Average Cost
    if (items.length) {
      for (const item of items) {
        const inventoryId = Number(item.inventory_id);
        const qty = Number(item.quantity);
        const newPrice = Number(item.unit_price || 0);

        if (!inventoryId || !qty || qty <= 0) continue;

        // Get current stock + price
        const currentRes = await client.query(`
          SELECT stock_quantity, purchase_price, name, unit
          FROM inventory_items
          WHERE id = $1 AND restaurant_id = $2
          FOR UPDATE
        `, [inventoryId, restaurantId]);

        if (!currentRes.rows.length) continue;

        const current = currentRes.rows[0];
        const currentQty = Number(current.stock_quantity || 0);
        const currentPrice = Number(current.purchase_price || 0);

        // ✅ Weighted Average Cost calculation
        let newWac = currentPrice;
        const totalQty = currentQty + qty;

        if (totalQty > 0 && newPrice > 0) {
          newWac = ((currentQty * currentPrice) + (qty * newPrice)) / totalQty;
        } else if (currentQty === 0 && newPrice > 0) {
          // No existing stock → just use new price
          newWac = newPrice;
        }

        // Update stock + weighted price
        await client.query(`
          UPDATE inventory_items
          SET stock_quantity = $1,
              purchase_price = $2,
              updated_at = NOW()
          WHERE id = $3 AND restaurant_id = $4
        `, [
          totalQty,
          newWac.toFixed(2),
          inventoryId,
          restaurantId
        ]);

        // Log transaction with price info
        const note = `Purchase ${data.invoice_no || ''} @ Rs ${newPrice.toFixed(2)}/unit from supplier (WAC: Rs ${newWac.toFixed(2)})`.trim();

        await client.query(`
          INSERT INTO inventory_transactions
            (inventory_id, type, quantity, note)
          VALUES ($1, 'IN', $2, $3)
        `, [
          inventoryId,
          qty,
          note
        ]);
      }
    }

    await client.query('COMMIT');
    return purchase;

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deletePurchase(id, restaurantId) {
  const result = await pool.query(
    `DELETE FROM supplier_purchases WHERE id = $1 AND restaurant_id = $2 RETURNING id`,
    [id, restaurantId]
  );
  return result.rows[0] || null;
}

/* =====================================================
   PAYMENTS
===================================================== */

async function listPayments(supplierId, restaurantId, filters = {}) {
  const params = [supplierId, restaurantId];
  let where = 'WHERE supplier_id = $1 AND restaurant_id = $2';

  if (filters.from) {
    params.push(filters.from);
    where += ` AND payment_date >= $${params.length}`;
  }
  if (filters.to) {
    params.push(filters.to);
    where += ` AND payment_date <= $${params.length}`;
  }

  const result = await pool.query(`
    SELECT * FROM supplier_payments
    ${where}
    ORDER BY payment_date DESC, id DESC
  `, params);

  return result.rows;
}

async function createPayment(supplierId, restaurantId, data, userId) {
  const result = await pool.query(`
    INSERT INTO supplier_payments
      (restaurant_id, supplier_id, payment_date, amount,
       payment_method, reference_no, note, created_by_user_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [
    restaurantId,
    supplierId,
    data.payment_date || new Date().toISOString().slice(0, 10),
    Number(data.amount),
    data.payment_method || 'Cash',
    data.reference_no || null,
    data.note || null,
    userId || null
  ]);
  return result.rows[0];
}

async function deletePayment(id, restaurantId) {
  const result = await pool.query(
    `DELETE FROM supplier_payments WHERE id = $1 AND restaurant_id = $2 RETURNING id`,
    [id, restaurantId]
  );
  return result.rows[0] || null;
}

/* =====================================================
   LEDGER (running balance)
===================================================== */

async function getLedger(supplierId, restaurantId, filters = {}) {
  const supplier = await getSupplierById(supplierId, restaurantId);
  if (!supplier) return null;

  const params = [supplierId, restaurantId];
  let dateWhere = '';

  if (filters.from) {
    params.push(filters.from);
    dateWhere += ` AND txn_date >= $${params.length}`;
  }
  if (filters.to) {
    params.push(filters.to);
    dateWhere += ` AND txn_date <= $${params.length}`;
  }

  const result = await pool.query(`
    SELECT * FROM (
      SELECT
        id,
        purchase_date AS txn_date,
        'purchase' AS type,
        COALESCE(invoice_no, 'Purchase') AS description,
        total_amount AS debit,
        paid_amount AS credit,
        note,
        created_at
      FROM supplier_purchases
      WHERE supplier_id = $1 AND restaurant_id = $2

      UNION ALL

      SELECT
        id,
        payment_date AS txn_date,
        'payment' AS type,
        COALESCE('Payment: ' || payment_method,
                 'Payment') AS description,
        0 AS debit,
        amount AS credit,
        COALESCE(note, reference_no) AS note,
        created_at
      FROM supplier_payments
      WHERE supplier_id = $1 AND restaurant_id = $2
    ) t
    WHERE 1=1 ${dateWhere}
    ORDER BY txn_date ASC, created_at ASC
  `, params);

  // Calculate running balance
  const openingBalance = Number(supplier.opening_balance || 0);
  let runningBalance = openingBalance;

  const entries = result.rows.map(row => {
    const debit = Number(row.debit || 0);
    const credit = Number(row.credit || 0);
    runningBalance = runningBalance + debit - credit;

    return {
      ...row,
      debit,
      credit,
      balance: runningBalance
    };
  });

  return {
    supplier,
    opening_balance: openingBalance,
    entries,
    total_debit: entries.reduce((s, e) => s + e.debit, 0),
    total_credit: entries.reduce((s, e) => s + e.credit, 0),
    closing_balance: runningBalance
  };
}

/* =====================================================
   AGING REPORT
===================================================== */

async function getAgingReport(restaurantId) {
  const result = await pool.query(`
    SELECT
      s.id,
      s.name,
      s.phone,
      s.email,
      COALESCE(s.opening_balance, 0)
        + COALESCE(p.total_purchase, 0)
        - COALESCE(p.total_paid, 0)
        - COALESCE(pay.total_payment, 0) AS balance,
      COALESCE(p.oldest_unpaid_date, NULL) AS oldest_unpaid_date
    FROM suppliers s
    LEFT JOIN (
      SELECT
        supplier_id,
        SUM(total_amount) AS total_purchase,
        SUM(paid_amount) AS total_paid,
        MIN(purchase_date) FILTER (
          WHERE total_amount > paid_amount
        ) AS oldest_unpaid_date
      FROM supplier_purchases
      WHERE restaurant_id = $1
      GROUP BY supplier_id
    ) p ON p.supplier_id = s.id
    LEFT JOIN (
      SELECT supplier_id, SUM(amount) AS total_payment
      FROM supplier_payments
      WHERE restaurant_id = $1
      GROUP BY supplier_id
    ) pay ON pay.supplier_id = s.id
    WHERE s.restaurant_id = $1 AND s.is_active = true
    ORDER BY balance DESC
  `, [restaurantId]);

  return result.rows.map(row => {
    const balance = Number(row.balance || 0);
    const oldestDate = row.oldest_unpaid_date;
    let daysOld = 0;

    if (oldestDate && balance > 0) {
      daysOld = Math.floor(
        (new Date() - new Date(oldestDate)) / 86400000
      );
    }

    let bucket = 'Current';
    if (balance <= 0) bucket = 'Settled';
    else if (daysOld > 90) bucket = '90+ days';
    else if (daysOld > 60) bucket = '61-90 days';
    else if (daysOld > 30) bucket = '31-60 days';
    else if (daysOld > 0) bucket = '1-30 days';

    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      balance,
      days_old: daysOld,
      bucket
    };
  });
}

module.exports = {
  listSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  listPurchases,
  createPurchase,
  deletePurchase,
  listPayments,
  createPayment,
  deletePayment,
  getLedger,
  getAgingReport
};