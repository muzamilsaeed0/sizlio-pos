const model = require('../models/wholesaleModel');

function rid(req) {
  return Number(req.user?.restaurant_id);
}

function safeWholesaleValidationMessage(error) {
  const message = String(error?.message || '');
  const allowed = [
    /^Product name is required$/,
    /^Price and stock values must be valid numbers$/,
    /^Price and stock values cannot be negative$/,
    /^(purchase_price|sale_price|stock|min_stock) must be a valid non-negative number$/,
    /^Add at least one product$/,
    /^Invalid item$/,
    /^Product \d+ not found$/,
    /^Insufficient stock for .{1,100}$/,
    /^Invalid sale price for .{1,100}$/,
    /^Invalid line total$/,
    /^Discount must be between 0 and subtotal$/,
    /^Tax must be a valid non-negative amount$/,
    /^Invalid sale total$/
  ];
  return allowed.some(pattern => pattern.test(message)) ? message : null;
}

exports.getProducts = async (req, res) => {
  try {
    const data = await model.listProducts(rid(req));
    res.json({ success: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.addProduct = async (req, res) => {
  try {
    if (!req.body?.name || !(Number(req.body.sale_price) >= 0)) {
      return res.status(400).json({ success: false, message: 'Name and sale_price required' });
    }
    const data = await model.createProduct(rid(req), req.body);
    res.status(201).json({ success: true, data });
  } catch (e) {
    console.error(e);
    const safeMessage = safeWholesaleValidationMessage(e);
    res.status(safeMessage ? 400 : 500).json({
      success: false,
      message: safeMessage || 'Server error'
    });
  }
};

exports.editProduct = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = await model.updateProduct(rid(req), id, req.body);
    if (!data) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data });
  } catch (e) {
    console.error(e);
    const safeMessage = safeWholesaleValidationMessage(e);
    res.status(safeMessage ? 400 : 500).json({
      success: false,
      message: safeMessage || 'Server error'
    });
  }
};

exports.removeProduct = async (req, res) => {
  try {
    const ok = await model.deactivateProduct(rid(req), Number(req.params.id));
    if (!ok) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.createSale = async (req, res) => {
  try {
    const result = await model.createCashSale(rid(req), req.user?.id, req.body || {});
    res.status(201).json({ success: true, ...result });
  } catch (e) {
    console.error(e);
    const safeMessage = safeWholesaleValidationMessage(e);
    res.status(safeMessage ? 400 : 500).json({
      success: false,
      message: safeMessage || 'Sale failed'
    });
  }
};

exports.getInvoices = async (req, res) => {
  try {
    const data = await model.listInvoices(rid(req));
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};