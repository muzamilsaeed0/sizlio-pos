const axios = require('axios');
const fbrModel = require('../models/fbrModel');

// ── Endpoints ────────────────────────────────────────────────────────────
const FBR_SANDBOX_URL =
  process.env.FBR_SANDBOX_URL ||
  'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb';
const FBR_PRODUCTION_URL =
  process.env.FBR_PRODUCTION_URL ||
  'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata';

/** Set FBR_MOCK=true on Railway to skip real FBR and return dummy success */
function isMockMode() {
  const v = String(process.env.FBR_MOCK || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function endpointFor(environment) {
  return environment === 'production' ? FBR_PRODUCTION_URL : FBR_SANDBOX_URL;
}

/**
 * Normalize tax rate string for FBR (e.g. "18%", "0%").
 * Prefer order GST; fall back to item / default 0.
 */
function taxRatePercent(order, item) {
  const fromOrder = Number(order.gst_percent);
  if (Number.isFinite(fromOrder) && fromOrder >= 0) return fromOrder;
  const fromItem = Number(item.gst_percent ?? item.tax_percent);
  if (Number.isFinite(fromItem) && fromItem >= 0) return fromItem;
  return 0;
}

function hsCodeFor(item) {
  const raw = String(item.hs_code || item.hsCode || '').trim();
  // FBR restaurant/services common default; override per menu item when you have real codes
  if (raw) return raw;
  return '9963.0000';
}

// ── Payload builder ──────────────────────────────────────────────────────
function buildInvoicePayload(order, orderItems, restaurant) {
  const isSandbox =
    String(restaurant.fbr_environment || 'sandbox').toLowerCase() !== 'production';

  return {
    invoiceType: 'Sale Invoice',
    invoiceDate: new Date(order.created_at || order.order_date || Date.now())
      .toISOString()
      .slice(0, 10),
    sellerNTNCNIC: restaurant.fbr_seller_ntn_cnic,
    sellerBusinessName: restaurant.fbr_seller_business_name,
    sellerProvince: restaurant.fbr_seller_province,
    sellerAddress: restaurant.fbr_seller_address,
    buyerRegistrationType: 'Unregistered',
    buyerNTNCNIC: '',
    buyerBusinessName: order.customer_name || 'Walk-in Customer',
    buyerProvince: restaurant.fbr_seller_province,
    buyerAddress: '',
    invoiceRefNo: String(order.local_number || order.id || ''),
    // Sandbox scenario — required by FBR DI sandbox in many flows
    scenarioId: isSandbox ? restaurant.fbr_scenario_id || 'SN001' : undefined,
    items: (orderItems || []).map((item) => {
      const qty = Number(item.quantity ?? item.qty) || 0;
      const unit = Number(item.price ?? item.unit_price) || 0;
      const excludingST = Math.round(unit * qty * 100) / 100;
      const taxRate = taxRatePercent(order, item);
      const salesTax = Math.round(((excludingST * taxRate) / 100) * 100) / 100;

      return {
        hsCode: hsCodeFor(item),
        productDescription: item.name || item.productDescription || 'Item',
        rate: `${taxRate}%`,
        uoM: item.uoM || item.unit || 'Numbers, PCS',
        quantity: qty,
        totalValues: excludingST + salesTax,
        valueSalesExcludingST: excludingST,
        fixedNotifiedValueOrRetailPrice: 0,
        salesTaxApplicable: salesTax,
        salesTaxWithheldAtSource: 0,
        extraTax: '',
        furtherTax: 0,
        sroScheduleNo: '',
        fedPayable: 0,
        discount: Number(item.discount) || 0,
        saleType: 'Goods at standard rate (default)',
        sroItemSerialNo: '',
      };
    }),
  };
}

// ── Submission ───────────────────────────────────────────────────────────
async function submitToFbr(payload, restaurant) {
  if (isMockMode()) {
    const inv = `MOCK-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const qrPayload = encodeURIComponent(inv);
    return {
      invoiceNumber: inv,
      InvoiceNumber: inv,
      qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${qrPayload}`,
      QRCode: `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${qrPayload}`,
      mock: true,
      message: 'FBR_MOCK success — not sent to FBR gateway',
    };
  }

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
async function submitInvoiceForOrder(orderOrId, orderItems, restaurantId = null) {
  let order;
  let items;

  if (typeof orderOrId === 'number' || typeof orderOrId === 'string') {
    const { getOrderById, getOrderItemsByOrderId } = require('../models/orderModel');
    if (!Number.isInteger(Number(restaurantId)) || Number(restaurantId) <= 0) {
      throw new Error('Restaurant scope is required for FBR order submission');
    }

    order = await getOrderById(Number(orderOrId), Number(restaurantId));
    if (!order) {
      throw new Error('Order not found for this restaurant');
    }

    items = await getOrderItemsByOrderId(Number(orderOrId), Number(restaurantId));
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
      order.restaurant_id,
      result.invoiceNumber || result.InvoiceNumber || null,
      result.qrCode || result.QRCode || null,
      result
    );
    return { success: true, invoiceLogId, result, mock: !!result.mock };
  } catch (err) {
    const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    await fbrModel.markInvoiceFailed(invoiceLogId, order.restaurant_id, message);
    return { success: false, invoiceLogId, error: message };
  }
}

/**
 * Retry worker — resubmit failed / stuck invoices.
 */
async function retryPendingInvoices(restaurantId = null) {
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
        invoice.restaurant_id,
        result.invoiceNumber || result.InvoiceNumber || null,
        result.qrCode || result.QRCode || null,
        result
      );
      results.push({ id: invoice.id, success: true, mock: !!result.mock });
    } catch (err) {
      const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      await fbrModel.markInvoiceFailed(invoice.id, invoice.restaurant_id, message);
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
  isMockMode,
};