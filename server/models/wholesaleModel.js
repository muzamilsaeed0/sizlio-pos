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
  const r = await pool.query(
    `INSERT INTO wholesale_products
      (restaurant_id, name, sku, unit, purchase_price, sale_price, stock, min_stock, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      restaurantId,
      String(name).trim(),
      sku || null,
      unit || 'pcs',
      Number(purchase_price) || 0,
      Number(sale_price) || 0,
      Number(stock) || 0,
      Number(min_stock) || 0,
      category || null
    ]
  );
  return r.rows[0];
}

async function updateProduct(restaurantId, id, data) {
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
    const paid = total; // Phase A: cash only

    // Serialize invoice-number allocation per restaurant to prevent duplicate numbers.
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [Number(restaurantId)]);
    const ln = await client.query(
      `SELECT COALESCE(MAX(local_number), 0) + 1 AS n
       FROM wholesale_invoices WHERE restaurant_id = $1`,
      [restaurantId]
    );
    const localNumber = ln.rows[0].n;

    const inv = await client.query(
      `INSERT INTO wholesale_invoices
        (restaurant_id, local_number, customer_name, subtotal, discount, tax, total, paid,
         payment_type, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'cash','completed',$9)
       RETURNING *`,
      [
        restaurantId, localNumber,
        payload.customer_name || 'Walk-in',
        subtotal.toFixed(2), discount.toFixed(2), tax.toFixed(2),
        total.toFixed(2), paid.toFixed(2), userId || null
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

module.exports = {
  listProducts,
  createProduct,
  updateProduct,
  deactivateProduct,
  createCashSale,
  listInvoices
};