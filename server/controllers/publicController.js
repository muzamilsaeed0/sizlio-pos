const pool = require('../config/db');

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

    const { table_no } = req.body;

    if (!table_no) {
      return res.status(400).json({
        success: false,
        message: 'table_no is required'
      });
    }

    req.app
      .get('io')
      .to(`restaurant_${restaurantId}`)
      .emit('waiter_call', {
        table_no,
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
      items = [],
      customer_name,
      deals = []
    } = req.body;

    if (
      (!items || !items.length) &&
      (!deals || !deals.length)
    ) {
      return res.status(400).json({
        success: false,
        message: 'table_no, and at least one item or deal, are required'
      });
    }

    if (!table_no) {
      return res.status(400).json({
        success: false,
        message: 'table_no is required'
      });
    }

    const existingOrder =
      await getActiveOrderForTable(
        table_no,
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
        table_no,
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