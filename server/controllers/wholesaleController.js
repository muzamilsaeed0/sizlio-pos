const model = require('../models/wholesaleModel');

function rid(req) {
  return Number(req.user?.restaurant_id);
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
    res.status(500).json({ success: false, message: e.message || 'Server error' });
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
    res.status(500).json({ success: false, message: 'Server error' });
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
    res.status(400).json({ success: false, message: e.message || 'Sale failed' });
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