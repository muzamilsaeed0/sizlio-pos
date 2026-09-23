const supplierModel = require('../models/supplierModel');

function getRestaurantId(req) {
  const id = Number(req.user?.restaurant_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/* =====================================================
   SUPPLIER CRUD
===================================================== */

exports.list = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });

    const suppliers = await supplierModel.listSuppliers(restaurantId, req.query);
    res.json({ success: true, data: suppliers });
  } catch (err) {
    console.error('supplier.list:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getOne = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const id = Number(req.params.id);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });
    if (!id) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const supplier = await supplierModel.getSupplierById(id, restaurantId);
    if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found' });

    res.json({ success: true, data: supplier });
  } catch (err) {
    console.error('supplier.getOne:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.create = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });

    const { name } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Supplier name is required' });
    }

    const supplier = await supplierModel.createSupplier(restaurantId, req.body);
    res.status(201).json({ success: true, data: supplier });
  } catch (err) {
    console.error('supplier.create:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.update = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const id = Number(req.params.id);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });
    if (!id) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const { name } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Supplier name is required' });
    }

    const supplier = await supplierModel.updateSupplier(id, restaurantId, req.body);
    if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found' });

    res.json({ success: true, data: supplier });
  } catch (err) {
    console.error('supplier.update:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.remove = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const id = Number(req.params.id);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });
    if (!id) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const deleted = await supplierModel.deleteSupplier(id, restaurantId);
    if (!deleted) return res.status(404).json({ success: false, message: 'Supplier not found' });

    res.json({ success: true, message: 'Supplier deleted' });
  } catch (err) {
    console.error('supplier.remove:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/* =====================================================
   PURCHASES
===================================================== */

exports.listPurchases = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const supplierId = Number(req.params.id);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });
    if (!supplierId) return res.status(400).json({ success: false, message: 'Invalid supplier ID' });

    const rows = await supplierModel.listPurchases(supplierId, restaurantId, req.query);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('supplier.listPurchases:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.createPurchase = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const supplierId = Number(req.params.id);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });
    if (!supplierId) return res.status(400).json({ success: false, message: 'Invalid supplier ID' });

    const total = Number(req.body.total_amount);
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ success: false, message: 'Total amount must be > 0' });
    }

    const row = await supplierModel.createPurchase(supplierId, restaurantId, req.body, req.user.id);
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    console.error('supplier.createPurchase:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.deletePurchase = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const id = Number(req.params.purchaseId);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });
    if (!id) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const deleted = await supplierModel.deletePurchase(id, restaurantId);
    if (!deleted) return res.status(404).json({ success: false, message: 'Purchase not found' });

    res.json({ success: true, message: 'Purchase deleted' });
  } catch (err) {
    console.error('supplier.deletePurchase:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/* =====================================================
   PAYMENTS
===================================================== */

exports.listPayments = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const supplierId = Number(req.params.id);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });
    if (!supplierId) return res.status(400).json({ success: false, message: 'Invalid supplier ID' });

    const rows = await supplierModel.listPayments(supplierId, restaurantId, req.query);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('supplier.listPayments:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.createPayment = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const supplierId = Number(req.params.id);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });
    if (!supplierId) return res.status(400).json({ success: false, message: 'Invalid supplier ID' });

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be > 0' });
    }

    const row = await supplierModel.createPayment(supplierId, restaurantId, req.body, req.user.id);
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    console.error('supplier.createPayment:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.deletePayment = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const id = Number(req.params.paymentId);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });
    if (!id) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const deleted = await supplierModel.deletePayment(id, restaurantId);
    if (!deleted) return res.status(404).json({ success: false, message: 'Payment not found' });

    res.json({ success: true, message: 'Payment deleted' });
  } catch (err) {
    console.error('supplier.deletePayment:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/* =====================================================
   LEDGER + AGING
===================================================== */

exports.getLedger = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const supplierId = Number(req.params.id);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });
    if (!supplierId) return res.status(400).json({ success: false, message: 'Invalid supplier ID' });

    const ledger = await supplierModel.getLedger(supplierId, restaurantId, req.query);
    if (!ledger) return res.status(404).json({ success: false, message: 'Supplier not found' });

    res.json({ success: true, data: ledger });
  } catch (err) {
    console.error('supplier.getLedger:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getAging = async (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    if (!restaurantId) return res.status(401).json({ success: false, message: 'Restaurant missing' });

    const rows = await supplierModel.getAgingReport(restaurantId);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('supplier.getAging:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};