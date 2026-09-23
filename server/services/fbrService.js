const axios = require('axios');
const fbrModel = require('../models/fbrModel');

// ── Endpoints ────────────────────────────────────────────────────────────
const FBR_SANDBOX_URL = process.env.FBR_SANDBOX_URL || 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb';
const FBR_PRODUCTION_URL = process.env.FBR_PRODUCTION_URL || 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata';

function endpointFor(environment) {
  return environment === 'production' ? FBR_PRODUCTION_URL : FBR_SANDBOX_URL;
}

// ── Payload builder ──────────────────────────────────────────────────────
function buildInvoicePayload(order, orderItems, restaurant) {
  return {
    invoiceType: 'Sale Invoice',
    invoiceDate: new Date(order.created_at || order.order_date).toISOString().slice(0, 10),
    sellerNTNCNIC: restaurant.fbr_seller_ntn_cnic,
    sellerBusinessName: restaurant.fbr_seller_business_name,
    sellerProvince: restaurant.fbr_seller_province,
    sellerAddress: restaurant.fbr_seller_address,
    buyerRegistrationType: 'Unregistered',
    buyerNTNCNIC: '',
    buyerBusinessName: order.customer_name || 'Walk-in Customer',
    buyerProvince: restaurant.fbr_seller_province,
    buyerAddress: '',
    invoiceRefNo: '',
    scenarioId: restaurant.fbr_environment === 'sandbox' ? 'SN001' : undefined,
    items: orderItems.map((item) => {
      const excludingST = Number(item.price) * Number(item.quantity);
      const taxRate = Number(order.gst_percent || 0);
      const salesTax = Math.round((excludingST * taxRate) / 100 * 100) / 100;

      return {
        hsCode: item.hs_code || '9963.0000',
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
  return response.data;
}

/**
 * Main entry point — call this once an order is completed/paid.
 * Flexible: accepts either a full order object OR an orderId (number).
 */
async function submitInvoiceForOrder(orderOrId, orderItems) {
  let order;
  let items;

  // ✅ Flexible: agar orderId (number) diya gaya hai to khud fetch karo
  if (typeof orderOrId === 'number' || typeof orderOrId === 'string') {
    const { getOrderById, getOrderItemsByOrderId } = require('../models/orderModel');
    order = await getOrderById(Number(orderOrId));
    items = await getOrderItemsByOrderId(Number(orderOrId));
  } else {
    order = orderOrId;
    items = orderItems;
  }

  if (!order) {
    throw new Error('Order not found for FBR submission');
  }

  const restaurant = await fbrModel.getFbrConfig(order.restaurant_id);

  if (!restaurant || !restaurant.fbr_enabled) {
    return { skipped: true, reason: 'FBR integration not enabled for this restaurant' };
  }

  const payload = buildInvoicePayload(order, items, restaurant);
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
 * to resubmit invoices that failed or got stuck.
 *
 * @param {number|null} restaurantId
 *   - null → ALL pending invoices (super_admin/global retry)
 *   - number → sirf us restaurant ki pending invoices (manager-scoped retry)
 */
async function retryPendingInvoices(restaurantId = null) {
  // ✅ Restaurant-scoped retry
  const pending = restaurantId
    ? await fbrModel.getPendingInvoicesForRestaurant(restaurantId)
    : await fbrModel.getPendingInvoices();

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