// ADJUST THIS IMPORT to match however your project connects to Postgres
// (e.g. '../config/db', '../db/pool', '../database'). Looking at your
// existing models (orderModel.js etc.) — copy the exact same require line
// they use for the pg pool/client.
const pool = require('../config/db');

/** Fetch a restaurant's FBR settings (credentials, seller info, environment). */
async function getFbrConfig(restaurantId) {
  const { rows } = await pool.query(
    `SELECT fbr_enabled, fbr_pos_registration_no, fbr_api_token,
            fbr_seller_ntn_cnic, fbr_seller_business_name,
            fbr_seller_province, fbr_seller_address, fbr_environment
     FROM restaurants WHERE id = $1`,
    [restaurantId]
  );
  return rows[0] || null;
}

/** Save/update a restaurant's FBR credentials (called once during setup). */
async function saveFbrConfig(restaurantId, cfg) {
  cfg = cfg || {}; // ✅ SAFETY

  const { rows } = await pool.query(
    `UPDATE restaurants SET
       fbr_enabled = $2,
       fbr_pos_registration_no = $3,
       fbr_api_token = $4,
       fbr_seller_ntn_cnic = $5,
       fbr_seller_business_name = $6,
       fbr_seller_province = $7,
       fbr_seller_address = $8,
       fbr_environment = $9
     WHERE id = $1
     RETURNING id`,
    [
      restaurantId,
      cfg.fbr_enabled || false,
      cfg.fbr_pos_registration_no || null,
      cfg.fbr_api_token || null,
      cfg.fbr_seller_ntn_cnic || null,
      cfg.fbr_seller_business_name || null,
      cfg.fbr_seller_province || null,
      cfg.fbr_seller_address || null,
      cfg.fbr_environment || 'sandbox',
    ]
  );
  return rows[0];
}

/** Create a pending invoice log row before calling the FBR API. */
async function createInvoiceLog(orderId, restaurantId, requestPayload) {
  const { rows } = await pool.query(
    `INSERT INTO fbr_invoices (order_id, restaurant_id, status, request_payload)
     VALUES ($1, $2, 'pending', $3)
     RETURNING id`,
    [orderId, restaurantId, requestPayload]
  );
  return rows[0].id;
}

/** Mark an invoice log row as submitted (success) with FBR's response. */
async function markInvoiceSubmitted(invoiceLogId, fbrInvoiceNumber, fbrQrCode, responsePayload) {
  await pool.query(
    `UPDATE fbr_invoices SET
       status = 'submitted',
       fbr_invoice_number = $2,
       fbr_qr_code = $3,
       response_payload = $4,
       submitted_at = NOW()
     WHERE id = $1`,
    [invoiceLogId, fbrInvoiceNumber, fbrQrCode, responsePayload]
  );
}

/** Mark an invoice log row as failed, bump retry_count, store the error. */
async function markInvoiceFailed(invoiceLogId, errorMessage) {
  await pool.query(
    `UPDATE fbr_invoices SET
       status = 'failed',
       retry_count = retry_count + 1,
       last_error = $2
     WHERE id = $1`,
    [invoiceLogId, errorMessage]
  );
}

/** Invoices still needing submission (failed or stuck pending) — used by the retry worker. */
async function getPendingInvoices(maxRetries = 5) {
  const { rows } = await pool.query(
    `SELECT * FROM fbr_invoices
     WHERE status IN ('pending', 'failed') AND retry_count < $1
     ORDER BY created_at ASC
     LIMIT 50`,
    [maxRetries]
  );
  return rows;
}

/** Look up the FBR invoice status for a given order (for receipt printing / status checks). */
async function getInvoiceByOrder(orderId) {
  const { rows } = await pool.query(
    `SELECT * FROM fbr_invoices WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

/** Restaurant-wise pending/failed invoices with order info (for manager dashboard). */
async function getPendingInvoicesForRestaurant(restaurantId) {
  const { rows } = await pool.query(
    `SELECT 
       fi.id,
       fi.order_id,
       fi.status,
       fi.retry_count,
       fi.last_error,
       fi.created_at,
       fi.submitted_at,
       o.customer_name,
       o.total_amount,
       o.order_type,
       o.table_no
     FROM fbr_invoices fi
     INNER JOIN orders o ON o.id = fi.order_id
     WHERE fi.restaurant_id = $1
       AND fi.status IN ('pending', 'failed')
       AND fi.retry_count < 5
     ORDER BY fi.created_at DESC
     LIMIT 100`,
    [restaurantId]
  );
  return rows;
}

module.exports = {
  getFbrConfig,
  saveFbrConfig,
  createInvoiceLog,
  markInvoiceSubmitted,
  markInvoiceFailed,
  getPendingInvoices,
  getInvoiceByOrder,
  getPendingInvoicesForRestaurant,
};
