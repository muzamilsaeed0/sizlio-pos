const axios = require('axios'); // npm install axios (if not already in package.json)
const fbrModel = require('../models/fbrModel');

// ── Endpoints ────────────────────────────────────────────────────────────
// PRAL provides separate sandbox and production base URLs when you register.
// Put the real values in your .env once IRIS gives them to you — these are
// placeholders based on PRAL's published pattern; confirm exact paths
// against the Technical Specification PDF / your PRAL onboarding email.
const FBR_SANDBOX_URL = process.env.FBR_SANDBOX_URL || 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb';
const FBR_PRODUCTION_URL = process.env.FBR_PRODUCTION_URL || 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata';

function endpointFor(environment) {
  return environment === 'production' ? FBR_PRODUCTION_URL : FBR_SANDBOX_URL;
}

// ── Payload builder ──────────────────────────────────────────────────────
/**
 * Maps one of your orders into FBR's Digital Invoicing JSON schema.
 *
 * `order`      — your order record (needs: id, order_date/created_at, total, discount, etc.)
 * `orderItems` — array of line items: { name, quantity, unit_price, hs_code?, tax_rate? }
 *                 (Adjust the field names below to match whatever your
 *                 orderModel actually returns — I don't have that exact
 *                 shape from your codebase.)
 * `restaurant` — the row returned by fbrModel.getFbrConfig()
 *
 * NOTE: field names here follow FBR's publicly documented Digital
 * Invoicing schema (sellerNTNCNIC, hsCode, uoM, saleType, etc). Cross-check
 * every field against the PRAL Technical Specification PDF for your
 * account before going live — schema versions do get revised.
 */
function buildInvoicePayload(order, orderItems, restaurant) {
  return {
    invoiceType: 'Sale Invoice',
    invoiceDate: new Date(order.created_at || order.order_date).toISOString().slice(0, 10),
    sellerNTNCNIC: restaurant.fbr_seller_ntn_cnic,
    sellerBusinessName: restaurant.fbr_seller_business_name,
    sellerProvince: restaurant.fbr_seller_province,
    sellerAddress: restaurant.fbr_seller_address,
    buyerRegistrationType: 'Unregistered', // most walk-in/dine-in customers won't have an NTN
    buyerNTNCNIC: '',
    buyerBusinessName: order.customer_name || 'Walk-in Customer',
    buyerProvince: restaurant.fbr_seller_province,
    buyerAddress: '',
    invoiceRefNo: '',
    scenarioId: restaurant.fbr_environment === 'sandbox' ? 'SN001' : undefined, // sandbox test-scenario id; omit in production
    items: orderItems.map((item) => {
      const excludingST = Number(item.price) * Number(item.quantity);
      const taxRate = Number(order.gst_percent || 0); // e.g. 18 for 18%
      const salesTax = Math.round((excludingST * taxRate) / 100 * 100) / 100;

      return {
        hsCode: item.hs_code || '9963.0000', // generic "food/restaurant services" HS code — confirm the correct one with FBR/your tax advisor
        productDescription: item.name,
        rate: `${taxRate}%`,
        uoM: 'Numbers, PCS',
        quantity: item.quantity,
        totalValues: excludingST + salesTax,
        valueSalesExcludingST: excludingST,
        fixedNotifiedValueOrRetailPrice: 0,
        salesTaxApplicable: salesTax,
        salesTaxWithheldAtSource: 0,
        extraTax: '',
        furtherTax: 0,
        sroScheduleNo: '',
        fedPayable: 0,
        discount: item.discount || 0,
        saleType: 'Goods at standard rate (default)',
        sroItemSerialNo: '',
      };
    }),
  };
}

// ── Submission ───────────────────────────────────────────────────────────
async function submitToFbr(payload, restaurant) {
  const url = endpointFor(restaurant.fbr_environment);
  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${restaurant.fbr_api_token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
  });
  return response.data; // expected to contain invoiceNumber / QR code per PRAL spec
}

/**
 * Main entry point — call this once an order is completed/paid.
 * Wire it into your existing order-completion flow, e.g. in
 * orderController.js right after an order's status becomes 'completed'/'paid'.
 */
async function submitInvoiceForOrder(order, orderItems) {
  const restaurant = await fbrModel.getFbrConfig(order.restaurant_id);

  if (!restaurant || !restaurant.fbr_enabled) {
    return { skipped: true, reason: 'FBR integration not enabled for this restaurant' };
  }

  const payload = buildInvoicePayload(order, orderItems, restaurant);
  const invoiceLogId = await fbrModel.createInvoiceLog(order.id, order.restaurant_id, payload);

  try {
    const result = await submitToFbr(payload, restaurant);
    await fbrModel.markInvoiceSubmitted(
      invoiceLogId,
      result.invoiceNumber || result.InvoiceNumber || null,
      result.qrCode || result.QRCode || null,
      result
    );
    return { success: true, invoiceLogId, result };
  } catch (err) {
    const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    await fbrModel.markInvoiceFailed(invoiceLogId, message);
    return { success: false, invoiceLogId, error: message };
  }
}

/**
 * Retry worker — call this on a schedule (see server/services/fbrRetryWorker.js)
 * to resubmit invoices that failed or got stuck (e.g. FBR was down, internet dropped).
 */
async function retryPendingInvoices() {
  const pending = await fbrModel.getPendingInvoices();
  const results = [];

  for (const invoice of pending) {
    const restaurant = await fbrModel.getFbrConfig(invoice.restaurant_id);
    if (!restaurant || !restaurant.fbr_enabled) continue;

    try {
      const result = await submitToFbr(invoice.request_payload, restaurant);
      await fbrModel.markInvoiceSubmitted(
        invoice.id,
        result.invoiceNumber || result.InvoiceNumber || null,
        result.qrCode || result.QRCode || null,
        result
      );
      results.push({ id: invoice.id, success: true });
    } catch (err) {
      const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      await fbrModel.markInvoiceFailed(invoice.id, message);
      results.push({ id: invoice.id, success: false, error: message });
    }
  }

  return results;
}

module.exports = {
  buildInvoicePayload,
  submitToFbr,
  submitInvoiceForOrder,
  retryPendingInvoices,
};
