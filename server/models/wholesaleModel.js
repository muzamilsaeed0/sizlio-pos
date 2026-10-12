const pool = require('../config/db');

async function listProducts(restaurantId) {
  const r = await pool.query(
    `SELECT * FROM wholesale_products
     WHERE restaurant_id = $1 AND active = TRUE
     ORDER BY name`,
    [restaurantId]
  );
  return r.rows;
}

async function createProduct(restaurantId, data) {
  const {
    name, sku, unit = 'pcs',
    purchase_price = 0, sale_price = 0,
    stock = 0, min_stock = 0, category = null
  } = data;
  const normalizedName = String(name || '').trim();
  const purchasePrice = Number(purchase_price);
  const salePrice = Number(sale_price);
  const initialStock = Number(stock);
  const minimumStock = Number(min_stock);
  if (!normalizedName) throw new Error('Product name is required');
  if (![purchasePrice, salePrice, initialStock, minimumStock].every(Number.isFinite)) {
    throw new Error('Price and stock values must be valid numbers');
  }
  if (purchasePrice < 0 || salePrice < 0 || initialStock < 0 || minimumStock < 0) {
    throw new Error('Price and stock values cannot be negative');
  }
  const r = await pool.query(
    `INSERT INTO wholesale_products
      (restaurant_id, name, sku, unit, purchase_price, sale_price, stock, min_stock, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      restaurantId,
      normalizedName,
      sku || null,
      unit || 'pcs',
      purchasePrice,
      salePrice,
      initialStock,
      minimumStock,
      category || null
    ]
  );
  return r.rows[0];
}

async function updateProduct(restaurantId, id, data) {
  for (const field of ['purchase_price', 'sale_price', 'stock', 'min_stock']) {
    if (data[field] != null) {
      const value = Number(data[field]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${field} must be a valid non-negative number`);
      }
      data[field] = value;
    }
  }
  if (data.name != null && !String(data.name).trim()) {
    throw new Error('Product name is required');
  }
  const r = await pool.query(
    `UPDATE wholesale_products SET
       name = COALESCE($3, name),
       sku = COALESCE($4, sku),
       unit = COALESCE($5, unit),
       purchase_price = COALESCE($6, purchase_price),
       sale_price = COALESCE($7, sale_price),
       stock = COALESCE($8, stock),
       min_stock = COALESCE($9, min_stock),
       category = COALESCE($10, category),
       updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 AND active = TRUE
     RETURNING *`,
    [
      id, restaurantId,
      data.name != null ? String(data.name).trim() : null,
      data.sku !== undefined ? (data.sku || null) : null,
      data.unit || null,
      data.purchase_price != null ? Number(data.purchase_price) : null,
      data.sale_price != null ? Number(data.sale_price) : null,
      data.stock != null ? Number(data.stock) : null,
      data.min_stock != null ? Number(data.min_stock) : null,
      data.category !== undefined ? data.category : null
    ]
  );
  return r.rows[0] || null;
}

async function deactivateProduct(restaurantId, id) {
  const r = await pool.query(
    `UPDATE wholesale_products SET active = FALSE, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING id`,
    [id, restaurantId]
  );
  return r.rowCount > 0;
}

async function createCashSale(restaurantId, userId, payload) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) throw new Error('Add at least one product');

    let subtotal = 0;
    const lines = [];

    for (const it of items) {
      const productId = Number(it.product_id);
      const qty = Number(it.qty);
      if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isFinite(qty) || qty <= 0) throw new Error('Invalid item');

      const pr = await client.query(
        `SELECT id, name, sale_price, stock FROM wholesale_products
         WHERE id = $1 AND restaurant_id = $2 AND active = TRUE FOR UPDATE`,
        [productId, restaurantId]
      );
      if (!pr.rowCount) throw new Error(`Product ${productId} not found`);
      const p = pr.rows[0];
      if (Number(p.stock) < qty) {
        throw new Error(`Insufficient stock for ${p.name}`);
      }

      // Never trust client-supplied prices; the database product price is authoritative.
      const unitPrice = Number(p.sale_price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error(`Invalid sale price for ${p.name}`);
      const lineTotal = unitPrice * qty;
      if (!Number.isFinite(lineTotal)) throw new Error('Invalid line total');
      subtotal += lineTotal;
      lines.push({ productId, name: p.name, qty, unitPrice, lineTotal });

      await client.query(
        `UPDATE wholesale_products SET stock = stock - $1, updated_at = NOW()
         WHERE id = $2 AND restaurant_id = $3`,
        [qty, productId, restaurantId]
      );
    }

    const discount = Number(payload.discount ?? 0);
    const tax = Number(payload.tax ?? 0);
    if (!Number.isFinite(discount) || discount < 0 || discount > subtotal) {
      throw new Error('Discount must be between 0 and subtotal');
    }
    if (!Number.isFinite(tax) || tax < 0) {
      throw new Error('Tax must be a valid non-negative amount');
    }
    const total = subtotal - discount + tax;
    if (!Number.isFinite(total) || total < 0) throw new Error('Invalid sale total');
    const paymentType = String(payload.payment_type || 'cash').toLowerCase();
    if (!['cash', 'credit', 'partial'].includes(paymentType)) {
      throw new Error('payment_type must be cash, credit, or partial');
    }

    let paid = Number(payload.paid_amount);
    if (paymentType === 'cash') {
      paid = total;
    } else if (paymentType === 'credit') {
      if (!Number.isFinite(paid) || paid < 0) paid = 0;
      if (paid > total) paid = total;
    } else {
      if (!Number.isFinite(paid) || paid < 0) throw new Error('paid_amount required for partial');
      if (paid > total) paid = total;
    }

    const due = Number((total - paid).toFixed(2));
    const status = due > 0.001 ? 'open' : 'completed';

    let customerId = payload.customer_id ? Number(payload.customer_id) : null;
    let customerName = String(payload.customer_name || 'Walk-in').trim() || 'Walk-in';

    if (due > 0.001) {
      if (!customerId || !Number.isSafeInteger(customerId)) {
        throw new Error('Select a customer for credit / partial payment');
      }
      const cu = await client.query(
        `SELECT id, name FROM wholesale_customers
         WHERE id = $1 AND restaurant_id = $2 AND active = TRUE`,
        [customerId, restaurantId]
      );
      if (!cu.rowCount) throw new Error('Customer not found');
      customerName = cu.rows[0].name;
    }

    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [Number(restaurantId)]);
    const ln = await client.query(
      `SELECT COALESCE(MAX(local_number), 0) + 1 AS n
       FROM wholesale_invoices WHERE restaurant_id = $1`,
      [restaurantId]
    );
    const localNumber = ln.rows[0].n;

    const inv = await client.query(
      `INSERT INTO wholesale_invoices
        (restaurant_id, local_number, customer_name, customer_id,
         subtotal, discount, tax, total, paid, payment_type, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        restaurantId, localNumber, customerName, customerId,
        subtotal.toFixed(2), discount.toFixed(2), tax.toFixed(2),
        total.toFixed(2), Number(paid).toFixed(2),
        paymentType, status, userId || null
      ]
    );
    const invoice = inv.rows[0];

    for (const L of lines) {
      await client.query(
        `INSERT INTO wholesale_invoice_items
          (invoice_id, product_id, name, qty, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [invoice.id, L.productId, L.name, L.qty, L.unitPrice, L.lineTotal]
      );
    }

    await client.query('COMMIT');
    return { invoice, items: lines };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listInvoices(restaurantId, limit = 50) {
  const r = await pool.query(
    `SELECT * FROM wholesale_invoices
     WHERE restaurant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [restaurantId, limit]
  );
  return r.rows;
}

async function adjustStock(restaurantId, productId, { delta, reason }) {
  const qty = Number(delta);
  if (!Number.isFinite(qty) || qty === 0) {
    throw new Error('Stock change must be a non-zero number');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pr = await client.query(
      `SELECT id, name, stock FROM wholesale_products
       WHERE id = $1 AND restaurant_id = $2 AND active = TRUE FOR UPDATE`,
      [productId, restaurantId]
    );
    if (!pr.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    const current = Number(pr.rows[0].stock);
    const next = current + qty;
    if (next < 0) {
      await client.query('ROLLBACK');
      throw new Error('Stock cannot go below zero');
    }
    const r = await client.query(
      `UPDATE wholesale_products
       SET stock = $1, updated_at = NOW()
       WHERE id = $2 AND restaurant_id = $3
       RETURNING *`,
      [next, productId, restaurantId]
    );
    // optional log table skip for Phase B — stock field is source of truth
    await client.query('COMMIT');
    return {
      product: r.rows[0],
      previous_stock: current,
      delta: qty,
      reason: reason || null
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function getInvoiceById(restaurantId, invoiceId) {
  const inv = await pool.query(
    `SELECT * FROM wholesale_invoices
     WHERE id = $1 AND restaurant_id = $2`,
    [invoiceId, restaurantId]
  );
  if (!inv.rowCount) return null;
  const items = await pool.query(
    `SELECT * FROM wholesale_invoice_items WHERE invoice_id = $1 ORDER BY id`,
    [invoiceId]
  );
  return { invoice: inv.rows[0], items: items.rows };
}

async function getTodaySummary(restaurantId) {
  const r = await pool.query(
    `SELECT
       COUNT(*)::int AS invoice_count,
       COALESCE(SUM(total), 0)::numeric AS total_sales,
       COALESCE(SUM(paid), 0)::numeric AS total_paid,
       COALESCE(SUM(discount), 0)::numeric AS total_discount
     FROM wholesale_invoices
     WHERE restaurant_id = $1
       AND created_at::date = (NOW() AT TIME ZONE 'Asia/Karachi')::date
       AND status = 'completed'`,
    [restaurantId]
  );
  const low = await pool.query(
    `SELECT id, name, stock, min_stock, unit
     FROM wholesale_products
     WHERE restaurant_id = $1 AND active = TRUE
       AND min_stock > 0 AND stock <= min_stock
     ORDER BY stock ASC
     LIMIT 20`,
    [restaurantId]
  );
  return { ...(r.rows[0] || {}), low_stock: low.rows };
}

async function listCustomers(restaurantId) {
  const r = await pool.query(
    `SELECT c.*,
       COALESCE((
         SELECT SUM(i.total - i.paid)
         FROM wholesale_invoices i
         WHERE i.customer_id = c.id AND i.restaurant_id = c.restaurant_id
           AND i.status = 'open'
       ), 0)::numeric AS balance
     FROM wholesale_customers c
     WHERE c.restaurant_id = $1 AND c.active = TRUE
     ORDER BY c.name`,
    [restaurantId]
  );
  return r.rows;
}

async function createCustomer(restaurantId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Customer name is required');
  const r = await pool.query(
    `INSERT INTO wholesale_customers (restaurant_id, name, phone, address, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [restaurantId, name, data.phone || null, data.address || null, data.notes || null]
  );
  return r.rows[0];
}

async function getCustomerLedger(restaurantId, customerId) {
  const c = await pool.query(
    `SELECT * FROM wholesale_customers WHERE id = $1 AND restaurant_id = $2`,
    [customerId, restaurantId]
  );
  if (!c.rowCount) return null;

  const invoices = await pool.query(
    `SELECT id, local_number, total, paid, (total - paid) AS due,
            payment_type, status, created_at, customer_name
     FROM wholesale_invoices
     WHERE restaurant_id = $1 AND customer_id = $2
     ORDER BY created_at DESC LIMIT 100`,
    [restaurantId, customerId]
  );

  const payments = await pool.query(
    `SELECT * FROM wholesale_customer_payments
     WHERE restaurant_id = $1 AND customer_id = $2
     ORDER BY created_at DESC LIMIT 100`,
    [restaurantId, customerId]
  );

  const bal = await pool.query(
    `SELECT COALESCE(SUM(total - paid), 0)::numeric AS balance
     FROM wholesale_invoices
     WHERE restaurant_id = $1 AND customer_id = $2 AND status = 'open'`,
    [restaurantId, customerId]
  );

  return {
    customer: c.rows[0],
    balance: bal.rows[0].balance,
    invoices: invoices.rows,
    payments: payments.rows
  };
}

async function receiveCustomerPayment(restaurantId, userId, { customer_id, amount, note }) {
  const pay = Number(amount);
  const customerId = Number(customer_id);
  if (!Number.isSafeInteger(customerId) || customerId <= 0) throw new Error('customer_id required');
  if (!Number.isFinite(pay) || pay <= 0) throw new Error('amount must be > 0');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cu = await client.query(
      `SELECT id, name FROM wholesale_customers
       WHERE id = $1 AND restaurant_id = $2 AND active = TRUE FOR UPDATE`,
      [customerId, restaurantId]
    );
    if (!cu.rowCount) { await client.query('ROLLBACK'); return null; }

    let remaining = pay;
    const open = await client.query(
      `SELECT id, total, paid FROM wholesale_invoices
       WHERE restaurant_id = $1 AND customer_id = $2 AND status = 'open'
       ORDER BY created_at ASC FOR UPDATE`,
      [restaurantId, customerId]
    );

    for (const inv of open.rows) {
      if (remaining <= 0) break;
      const due = Number(inv.total) - Number(inv.paid);
      if (due <= 0) continue;
      const apply = Math.min(due, remaining);
      const newPaid = Number(inv.paid) + apply;
      const newStatus = newPaid + 0.001 >= Number(inv.total) ? 'completed' : 'open';
      await client.query(
        `UPDATE wholesale_invoices SET paid = $1, status = $2 WHERE id = $3`,
        [newPaid.toFixed(2), newStatus, inv.id]
      );
      remaining -= apply;
    }

    const payment = await client.query(
      `INSERT INTO wholesale_customer_payments
        (restaurant_id, customer_id, amount, note, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [restaurantId, customerId, pay.toFixed(2), note || null, userId || null]
    );

    await client.query('COMMIT');
    return { payment: payment.rows[0], unallocated: Number(remaining.toFixed(2)), customer: cu.rows[0] };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  listProducts,
  createProduct,
  updateProduct,
  deactivateProduct,
  createCashSale,
  listInvoices,
  adjustStock,
  getInvoiceById,
  getTodaySummary,
  listCustomers,
  createCustomer,
  getCustomerLedger,
  receiveCustomerPayment
};