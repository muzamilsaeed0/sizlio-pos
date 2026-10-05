const pool = require('../config/db');
const crypto = require('crypto');

const { getAllMenuItems } = require('../models/menuModel');
const { getAllDeals } = require('../models/dealModel');

const {
  createOrder,
  getActiveOrderForTable,
  addItemsToOrder,
  getAllOrders
} = require('../models/orderModel');



exports.serverInfo = (req, res) => {

  return res.json({
    success: true,
    baseUrl: req.app.get("PUBLIC_URL")
  });

};





const QR_TABLE_SECRET = process.env.QR_TABLE_SECRET || process.env.JWT_SECRET;

if (!QR_TABLE_SECRET) throw new Error('QR_TABLE_SECRET or JWT_SECRET must be configured');

const createTableQrToken = (restaurantId, tableNo) => crypto.createHmac('sha256', QR_TABLE_SECRET).update(`sizlio-table-qr:v1:${restaurantId}:${tableNo}`).digest('hex');

const isValidTableQrToken = (restaurantId, tableNo, suppliedToken) => {
  if (!suppliedToken || typeof suppliedToken !== 'string') return false;
  const expected = createTableQrToken(restaurantId, tableNo);
  const supplied = suppliedToken.trim().toLowerCase();
  if (supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied, 'utf8'), Buffer.from(expected, 'utf8'));
};

const validateRestaurant = async (restaurantId) => {

  const result = await pool.query(
    `
    SELECT
      id,
      status,
      expiry_date
    FROM restaurants
    WHERE id = $1
    `,
    [restaurantId]
  );

  if (!result.rowCount) {
    return {
      success: false,
      status: 404,
      message: 'Restaurant not found'
    };
  }

  const restaurant = result.rows[0];

  if (restaurant.status !== 'Active') {
    return {
      success: false,
      status: 403,
      message: 'Restaurant unavailable'
    };
  }

  if (
    restaurant.expiry_date &&
    new Date(restaurant.expiry_date) < new Date()
  ) {
    return {
      success: false,
      status: 403,
      message: 'Restaurant subscription expired'
    };
  }

  return {
    success: true
  };

};



exports.getPublicMenu = async (req, res) => {

  try {

    const restaurantId = Number(req.params.restaurantId);

    const validation =
      await validateRestaurant(restaurantId);

    if (!validation.success) {
      return res.status(validation.status).json({
        success: false,
        message: validation.message
      });
    }

    const items =
      await getAllMenuItems(restaurantId);

    return res.json({
      success: true,
      data: items
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });

  }

};

exports.getPublicDeals = async (req, res) => {

  try {

    const restaurantId = Number(req.params.restaurantId);

    const validation =
      await validateRestaurant(restaurantId);

    if (!validation.success) {
      return res.status(validation.status).json({
        success: false,
        message: validation.message
      });
    }

    const deals =
      await getAllDeals(restaurantId);

    return res.json({
      success: true,
      data: deals
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });

  }

};


exports.callWaiter = async (req, res) => {

  try {

    const restaurantId = Number(req.params.restaurantId);

    const validation =
      await validateRestaurant(restaurantId);

    if (!validation.success) {
      return res.status(validation.status).json({
        success: false,
        message: validation.message
      });
    }

    const { table_no, table_token } = req.body;
    const tableNo = Number(table_no);
    if (!Number.isInteger(tableNo) || tableNo < 1 || tableNo > 100) return res.status(400).json({ success: false, message: 'Valid table_no is required' });
    if (!isValidTableQrToken(restaurantId, tableNo, table_token)) return res.status(403).json({ success: false, message: 'Invalid or expired table QR code' });

    req.app
      .get('io')
      .to(`restaurant_${restaurantId}`)
      .emit('waiter_call', {
        table_no: tableNo,
        time: new Date().toISOString()
      });

    return res.json({
      success: true,
      message: 'Waiter has been called'
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });

  }

};



exports.placePublicOrder = async (req, res) => {

  try {

    const restaurantId = Number(req.params.restaurantId);

    const validation =
      await validateRestaurant(restaurantId);

    if (!validation.success) {
      return res.status(validation.status).json({
        success: false,
        message: validation.message
      });
    }

    const {
      table_no,
      table_token,
      items = [],
      customer_name,
      deals = []
    } = req.body;

    const tableNo = Number(table_no);
    if (!Number.isInteger(tableNo) || tableNo < 1 || tableNo > 100) return res.status(400).json({ success: false, message: 'Valid table_no is required' });
    if (!isValidTableQrToken(restaurantId, tableNo, table_token)) return res.status(403).json({ success: false, message: 'Invalid or expired table QR code' });

    if (
      (!items || !items.length) &&
      (!deals || !deals.length)
    ) {
      return res.status(400).json({
        success: false,
        message: 'table_no, and at least one item or deal, are required'
      });
    }

    const existingOrder =
      await getActiveOrderForTable(
        tableNo,
        restaurantId
      );

    if (existingOrder) {

      await addItemsToOrder(
        existingOrder.id,
        items,
        restaurantId,
        'waiter',
        deals
      );

      const orders =
        await getAllOrders(restaurantId);

      const order =
        orders.find(
          o => o.id === existingOrder.id
        );

      req.app
        .get('io')
        .to(`restaurant_${restaurantId}`)
        .emit(
          'customer_order_created',
          order
        );

      return res.json({
        success: true,
        data: order
      });

    }

    const order =
      await createOrder(
        tableNo,
        items,
        restaurantId,
        customer_name,
        'pending',
        {},
        'dine_in',
        null,
        null,
        'MENU',
        'PAY_LATER',
        0,
        deals
      );

    req.app
      .get('io')
      .to(`restaurant_${restaurantId}`)
      .emit(
        'customer_order_created',
        order
      );

    return res.status(201).json({
      success: true,
      data: order
    });

    } catch (err) {
    console.error('placePublicOrder:', err);

    
    if (err.error === 'INSUFFICIENT_KITCHEN_STOCK' || err.error === 'KITCHEN_STOCK_NOT_FOUND') {
      return res.status(409).json({
        success: false,
        error: err.error,
        ingredient: err.ingredient,
        available: err.available,
        required: err.required,
        unit: err.unit,
        message: `Sorry, ${err.ingredient} is out of stock!`
      });
    }

    // Baaki errors
    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }

};

exports.getTableTokens = async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId);
    if (req.user.role !== 'super_admin' && Number(req.user.restaurant_id) !== restaurantId) return res.status(403).json({ success: false, message: 'Access denied' });
    const validation = await validateRestaurant(restaurantId);
    if (!validation.success) return res.status(validation.status).json({ success: false, message: validation.message });
    const rawTables = String(req.query.tables || '1');
    const tables = [...new Set(rawTables.split(',').map(v => Number(v.trim())).filter(v => Number.isInteger(v) && v >= 1 && v <= 100))];
    if (!tables.length || tables.length > 100) return res.status(400).json({ success: false, message: 'tables must contain 1 to 100 valid table numbers' });
    const tokens = {};
    for (const tableNo of tables) tokens[tableNo] = createTableQrToken(restaurantId, tableNo);
    return res.json({ success: true, data: { restaurant_id: restaurantId, tokens } });
  } catch (err) {
    console.error('getTableTokens:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};


exports.getRestaurantInfo = async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId);
    const check = await validateRestaurant(restaurantId);
    if (!check.success) {
      return res.status(check.status).json({ success: false, message: check.message });
    }

    const result = await pool.query(
      `SELECT name, logo_url FROM restaurants WHERE id = $1`,
      [restaurantId]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};