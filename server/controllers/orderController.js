const { submitInvoiceForOrder } = require('../services/fbrService');
const pool = require('../config/db');

const {
  createOrder,
  getAllOrders,
  confirmOrder,
  acceptOrder,
  markReady,
  markOutForDelivery,
  markDelivered,
  markCompleted,
  markServed,
  markPaid,
  getActiveOrderForTable,
  addItemsToOrder,
  updateOrderItemQuantity,
  removeOrderItem,
  updateOrderPricing,
  releaseOrderInventory,
  cancelOrder,
  findCustomerByPhone,
  getMyDeliveryOrders,
  getDeliveryRiders,
  getRiderSummary,
  assignDeliveryRider,
  unassignDeliveryRider,
  autoAssignDeliveryRider,
  updateDealQuantity,
  getOrderById,              
  getOrderItemsByOrderId 
} = require('../models/orderModel');


// ======================================================
// HELPERS
// ======================================================

const getRestaurantId = (req) => {
  return Number(req.user?.restaurant_id);
};


const isValidRestaurantId = (restaurantId) => {
  return (
    Number.isInteger(restaurantId) &&
    restaurantId > 0
  );
};


const getIO = (req) => {
  return req.app.get('io');
};


const getRoom = (restaurantId) => {
  return `restaurant_${restaurantId}`;
};


const emitOrderUpdated = (
  req,
  order
) => {

  const restaurantId =
    getRestaurantId(req);

  const io =
    getIO(req);

  if (
    !io ||
    !isValidRestaurantId(restaurantId) ||
    !order
  ) {
    return;
  }


  const room =
    getRoom(restaurantId);


  io.to(room).emit(
    'order_updated',
    order
  );


  io.to(room).emit(
    'orders_refresh'
  );

};


const emitOrderCreated = (
  req,
  order
) => {

  const restaurantId =
    getRestaurantId(req);

  const io =
    getIO(req);

  if (
    !io ||
    !isValidRestaurantId(restaurantId) ||
    !order
  ) {
    return;
  }


  const room =
    getRoom(restaurantId);


  io.to(room).emit(
    'order_created',
    order
  );

  if (
  String(order.order_source || '').toUpperCase() === 'WAITER'
) {
  io.to(room).emit(
    'waiter_order_created',
    order
  );
}


  io.to(room).emit(
    'order_updated',
    order
  );


  io.to(room).emit(
    'orders_refresh'
  );

};


// ======================================================
// PLACE ORDER
// ======================================================

exports.placeOrder = async (
  req,
  res
) => {

  const {
    table_no,
    items,
    customer_name,
    pricing = {},
    order_type = 'dine_in',
    delivery_phone,
    delivery_address,
    order_source = 'MENU',
    payment_timing = 'PAY_LATER',
    paid_amount = 0,
    deals = [],
    delivery_charge = 0,
    dine_charge = 0,
    card_charge = 0,        // ✅ NEW
    bank_charge = 0         // ✅ NEW
  } = req.body;


  // ----------------------------------------------------
  // RESTAURANT
  // ----------------------------------------------------

  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  // ----------------------------------------------------
  // ORDER SOURCE
  // ----------------------------------------------------

  const orderSource =
    String(order_source).toUpperCase();


  const allowedSources = [
    'MENU',
    'WAITER',
    'COUNTER',
    'PHONE'
  ];


  if (
    !allowedSources.includes(orderSource)
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order source'

    });

  }


  // ----------------------------------------------------
  // PAYMENT TIMING
  // ----------------------------------------------------

  const paymentTiming =
    String(payment_timing).toUpperCase();


  const allowedPaymentTiming = [
    'PAY_LATER',
    'PAID_AT_ORDER',
    'COD'
  ];


  if (
    !allowedPaymentTiming.includes(
      paymentTiming
    )
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid payment timing'

    });

  }


  // ----------------------------------------------------
  // ORDER TYPE
  // ----------------------------------------------------

  if (
    !['dine_in', 'delivery','walk_in']
      .includes(order_type)
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Order type must be dine_in, delivery or walk_in'

    });

  }


  // ----------------------------------------------------
  // TABLE NUMBER
  // ----------------------------------------------------

  let tableNo =
    Number(table_no);


  if (order_type === 'delivery' || order_type === 'walk_in') {
    tableNo = 0;
} else {
    if (!Number.isInteger(tableNo) || tableNo <= 0) {

      return res.status(400).json({

        success: false,

        message:
          'Valid table number is required for dine-in order'

      });

    }

  }


  // ----------------------------------------------------
  // DELIVERY VALIDATION
  // ----------------------------------------------------

  if (
    order_type === 'delivery'
  ) {

    if (
      !delivery_phone ||
      !String(delivery_phone).trim()
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Delivery phone is required'

      });

    }


    if (
      !delivery_address ||
      !String(delivery_address).trim()
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Delivery address is required'

      });

    }

  }


  // ----------------------------------------------------
  // COD VALIDATION
  // ----------------------------------------------------

  if (
    paymentTiming === 'COD' &&
    order_type !== 'delivery'
  ) {

    return res.status(400).json({

      success: false,

      message:
        'COD is only allowed for delivery orders'

    });

  }


  // ----------------------------------------------------
  // ITEMS
  // ----------------------------------------------------

    if (
    (!Array.isArray(items) || items.length === 0) &&
    (!Array.isArray(deals) || deals.length === 0)
  ) {
    return res.status(400).json({
      success: false,
      message:
        'At least one item or deal is required'
    });
  }


    // ----------------------------------------------------
  // NORMALIZE ITEMS
  // ----------------------------------------------------
  const normalizedItems = [];
  for (
    const item
    of items
  ) {
    const menuItemId =
      Number(item.menu_item_id);
    const quantity =
      Number(item.quantity);
    const variantId =
      item.variant_id === undefined ||
      item.variant_id === null ||
      item.variant_id === ''
        ? null
        : Number(item.variant_id);
    if (
      !Number.isInteger(menuItemId) ||
      menuItemId <= 0 ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      (
        variantId !== null &&
        (!Number.isInteger(variantId) || variantId <= 0)
      )
    ) {
      return res.status(400).json({

        success: false,

        message:
          'Invalid menu item or quantity'

      });

    }


    normalizedItems.push({

      menu_item_id:
        menuItemId,

      variant_id:
        variantId,

      quantity:
        quantity

    });

  }


  // ----------------------------------------------------
  // NORMALIZE DEALS
  // ----------------------------------------------------

  const normalizedDeals = [];

  if (Array.isArray(deals)) {

    for (const deal of deals) {

      const dealId =
        Number(deal.deal_id);

      const dealQuantity =
        Number(deal.quantity);

      if (
        !Number.isInteger(dealId) ||
        dealId <= 0 ||
        !Number.isInteger(dealQuantity) ||
        dealQuantity <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            'Invalid deal or quantity'

        });

      }


      normalizedDeals.push({

        deal_id:
          dealId,

        quantity:
          dealQuantity

      });

    }

  }


  // ----------------------------------------------------
  // INITIAL STATUS
  //
  // MENU:
  // pending → accepted → preparing
  //
  // WAITER / COUNTER / PHONE:
  // placed → preparing
  // ----------------------------------------------------

  const initialStatus =
    orderSource === 'MENU'
      ? 'pending'
      : 'placed';


  // ----------------------------------------------------
  // PAID AMOUNT
  // ----------------------------------------------------

  let initialPaidAmount =
    Number(paid_amount || 0);


  if (
    !Number.isFinite(initialPaidAmount) ||
    initialPaidAmount < 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid paid amount'

    });

  }


  // ----------------------------------------------------
  // ONLY PAID_AT_ORDER CAN HAVE PAID AMOUNT
  // ----------------------------------------------------

  if (
    paymentTiming !== 'PAID_AT_ORDER'
  ) {

    initialPaidAmount = 0;

  }


  // ----------------------------------------------------
  // PAID AT ORDER
  // ----------------------------------------------------

  if (
    paymentTiming === 'PAID_AT_ORDER' &&
    initialPaidAmount <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Paid amount is required for already paid order'

    });

  }


  try {

    // --------------------------------------------------
    // ACTIVE DINE-IN ORDER
    // --------------------------------------------------




   let existingOrder = null;

// ✅ Dine-in aur Walk-in dono ke liye existing order check karo
if ((order_type === 'dine_in' || order_type === 'walk_in') && tableNo > 0) {
  existingOrder = await getActiveOrderForTable(tableNo, restaurantId);
}


    // --------------------------------------------------
    // ADD TO EXISTING ORDER
    // --------------------------------------------------

    if (existingOrder) {

      await addItemsToOrder(
        existingOrder.id,
        normalizedItems,
        restaurantId,
        
        req.user?.role || 'waiter',
        normalizedDeals
      );


      const updatedOrders =
        await getAllOrders(
          restaurantId
        );


      const updatedOrder =
        updatedOrders.find(
          order =>
            Number(order.id) ===
            Number(existingOrder.id)
        );


      if (!updatedOrder) {

        return res.status(404).json({

          success: false,

          message:
            'Updated order not found'

        });

      }


      emitOrderUpdated(
        req,
        updatedOrder
      );


      // Existing order received NEW ITEMS.
      // This is separate from order_created so the kitchen
      // can play the addition beep without treating it as
      // a brand-new order.
      const io = getIO(req);

      if (io) {

        const room = getRoom(restaurantId);

        io.to(room).emit(
          'order_items_added',
          updatedOrder
        );

      }


      return res.status(200).json({

        success: true,

        message:
          'Items added to existing order',

        order:
          updatedOrder

      });

    }


    // --------------------------------------------------
    // CREATE NEW ORDER
    // --------------------------------------------------

       const newOrder =
      await createOrder(
        tableNo,
        normalizedItems,
        restaurantId,
        customer_name ? String(customer_name).trim() : null,
        initialStatus,
        pricing,
        order_type,
        order_type === 'delivery' ? String(delivery_phone).trim() : null,
        order_type === 'delivery' ? String(delivery_address).trim() : null,
        orderSource,
        paymentTiming,
        initialPaidAmount,
        normalizedDeals,
        req.user?.id || null,             
        Number(delivery_charge || 0),    
        Number(dine_charge || 0),
        Number(card_charge || 0),        // ✅ NEW
        Number(bank_charge || 0)         // ✅ NEW
      );


    // --------------------------------------------------
    // LOG
    // --------------------------------------------------

    console.log(
      'ORDER CREATED:',
      {
        restaurantId,
        orderId: newOrder.id,
        orderType: order_type,
        orderSource,
        paymentTiming,
        status: newOrder.status
      }
    );


    // --------------------------------------------------
    // SOCKET
    // --------------------------------------------------

    emitOrderCreated(
      req,
      newOrder
    );


    return res.status(201).json({

      success: true,

      message:
        orderSource === 'MENU'
          ? 'Order sent to waiter'
          : 'Order sent to kitchen',

      order:
        newOrder

    });

  }
    catch (err) {
    console.error('placeOrder:', err);

    
    if (err.error === 'INSUFFICIENT_KITCHEN_STOCK' || err.error === 'KITCHEN_STOCK_NOT_FOUND') {
      return res.status(409).json({
        success: false,
        error: err.error,
        ingredient: err.ingredient,
        available: err.available,
        required: err.required,
        unit: err.unit,
        message: err.message
      });
    }

    
    return res.status(500).json({
      success: false,
      message: err.message || 'Internal Server Error'
    });
  }

};


// ======================================================
// GET ALL ORDERS
// ======================================================

exports.getOrders = async (
  req,
  res
) => {

  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const orders =
      await getAllOrders(
        restaurantId
      );


    return res.status(200).json({

      success: true,

      count:
        orders.length,

      orders

    });

  }
  catch (err) {

    console.error(
      'getOrders:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// ACCEPT ORDER
//
// MENU:
// pending → accepted
//
// Only MENU orders need waiter acceptance.
// ======================================================

exports.accept = async (
  req,
  res
) => {

  if (
    !['waiter', 'manager']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only waiter or manager can accept menu orders'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const order =
      await acceptOrder(
        orderId,
        restaurantId
      );


    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only pending MENU orders can be accepted'

      });

    }


    const io =
      getIO(req);


    if (io) {

      const room =
        getRoom(restaurantId);


      io.to(room).emit(
        'order_updated',
        order
      );


      io.to(room).emit(
        'order_accepted',
        order
      );


      io.to(room).emit(
        'orders_refresh'
      );

    }


    return res.status(200).json({

      success: true,

      message:
        'Menu order accepted and sent to kitchen',

      order

    });

  }
  catch (err) {

    console.error(
      'accept:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// CONFIRM ORDER
//
// accepted / placed
//       ↓
// preparing
//
// Allowed:
// kitchen
// manager
// ======================================================

exports.confirm = async (
  req,
  res
) => {

  if (
    !['kitchen', 'manager']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only kitchen or manager can confirm orders'

    });

  }


  const prepMinutes =
    Number(
      req.body.prep_minutes
    );


  if (
    !Number.isInteger(prepMinutes) ||
    prepMinutes <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Valid preparation time is required'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const order =
      await confirmOrder(
        orderId,
        prepMinutes,
        restaurantId
      );


    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only accepted, placed or confirmed orders can start preparation'

      });

    }


    emitOrderUpdated(
      req,
      order
    );


    const io =
      getIO(req);


    if (io) {

      io.to(
        getRoom(restaurantId)
      ).emit(
        'order_confirmed',
        order
      );

    }


    return res.status(200).json({

      success: true,

      message:
        'Order confirmed and preparation started',

      order

    });

  }
  catch (err) {

    console.error(
      'confirm:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// MARK READY
//
// DINE-IN:
// preparing → ready
//
// DELIVERY:
// preparing → ready_to_deliver
//
// Allowed:
// kitchen
// manager
// ======================================================

exports.ready = async (
  req,
  res
) => {

  if (
    !['kitchen', 'manager']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only kitchen or manager can mark orders ready'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const order =
      await markReady(
        orderId,
        restaurantId
      );


    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only preparing orders can be marked ready'

      });

    }


    // ==================================================
    // AUTO ASSIGN DELIVERY RIDER
    //
    // Delivery order ready hote hi:
    // ready_to_deliver → least-loaded active rider
    //
    // Dine-in orders par rider assignment nahi hoti.
    // Agar koi active rider available na ho to order
    // ready_to_deliver rahega.
    // ==================================================

    let assignedRider = null;

    if (
      order.order_type === 'delivery' &&
      order.status === 'ready_to_deliver'
    ) {

      try {

        assignedRider =
          await autoAssignDeliveryRider(
            order.id,
            restaurantId
          );

        if (assignedRider?.order) {

          // Keep response/order object updated with
          // the newly assigned rider.
          Object.assign(
            order,
            assignedRider.order
          );

        }

      }
      catch (riderErr) {

        // Rider assignment failure must NOT prevent
        // the order from becoming ready.
        console.error(
          'Automatic rider assignment failed:',
          riderErr
        );

      }

    }


    emitOrderUpdated(
      req,
      order
    );


    const io =
      getIO(req);


    if (io) {

      io.to(
        getRoom(restaurantId)
      ).emit(
        'order_ready',
        order
      );


      if (assignedRider?.order) {

        io.to(
          getRoom(restaurantId)
        ).emit(
          'delivery_rider_assigned',
          order
        );

      }

    }


    return res.status(200).json({

      success: true,

      message:
        order.order_type === 'delivery'
          ? 'Delivery order is ready for dispatch'
          : 'Order is ready',

      order

    });

  }
  catch (err) {

    console.error(
      'ready:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// MARK OUT FOR DELIVERY
//
// ready_to_deliver → out_for_delivery
//
// Delivery orders only.
//
// Allowed:
// delivery
// manager
// counter
// ======================================================

exports.outForDelivery = async (
  req,
  res
) => {

  if (
    !['delivery', 'manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only delivery, manager or counter can dispatch delivery orders'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {


    if (req.user?.role === 'delivery') {

  const allOrders =
    await getAllOrders(
      restaurantId
    );

  const targetOrder =
    allOrders.find(
      o => Number(o.id) === orderId
    );

  if (!targetOrder) {

    return res.status(404).json({

      success: false,

      message:
        'Order not found'

    });

  }

  if (
    targetOrder.order_type !== 'delivery'
  ) {

    return res.status(403).json({

      success: false,

      message:
        'This is not a delivery order'

    });

  }

  if (
    Number(targetOrder.delivery_rider_id) !==
    Number(req.user.id)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'This delivery order is not assigned to you'

    });

  }

}
    const order =
      await markOutForDelivery(
        orderId,
        restaurantId
      );


    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only ready delivery orders can be dispatched'

      });

    }


    emitOrderUpdated(
      req,
      order
    );


    const io =
      getIO(req);


    if (io) {

      io.to(
        getRoom(restaurantId)
      ).emit(
        'order_out_for_delivery',
        order
      );

    }


    return res.status(200).json({

      success: true,

      message:
        'Delivery order dispatched successfully',

      order

    });

  }
  catch (err) {

    console.error(
      'outForDelivery:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// MARK DELIVERED
//
// out_for_delivery → delivered
//
// Delivery orders only.
//
// Allowed:
// delivery
// manager
// counter
// ======================================================

exports.delivered = async (
  req,
  res
) => {

  if (
    !['delivery', 'manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only delivery, manager or counter can mark delivery orders delivered'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    if (req.user?.role === 'delivery') {

  const allOrders =
    await getAllOrders(
      restaurantId
    );

  const targetOrder =
    allOrders.find(
      o => Number(o.id) === orderId
    );

  if (!targetOrder) {

    return res.status(404).json({

      success: false,

      message:
        'Order not found'

    });

  }

  if (
    Number(targetOrder.delivery_rider_id) !==
    Number(req.user.id)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'This delivery order is not assigned to you'

    });

  }

}

    const order =
      await markDelivered(
        orderId,
        restaurantId
      );


    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only out-for-delivery orders can be marked delivered'

      });

    }


    emitOrderUpdated(
      req,
      order
    );


    const io =
      getIO(req);


    if (io) {

      io.to(
        getRoom(restaurantId)
      ).emit(
        'order_delivered',
        order
      );

    }


    return res.status(200).json({

      success: true,

      message:
        'Delivery order marked delivered successfully',

      order

    });

  }
  catch (err) {

    console.error(
      'delivered:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// MARK COMPLETED
//
// delivered → completed
//
// Delivery orders only.
//
// Allowed:
// delivery
// manager
// counter
// ======================================================

exports.completed = async (
  req,
  res
) => {

  if (
    !['delivery', 'manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only delivery, manager or counter can complete delivery orders'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {


    if (req.user?.role === 'delivery') {

  const allOrders =
    await getAllOrders(
      restaurantId
    );

  const targetOrder =
    allOrders.find(
      o => Number(o.id) === orderId
    );

  if (!targetOrder) {

    return res.status(404).json({

      success: false,

      message:
        'Order not found'

    });

  }

  if (
    Number(targetOrder.delivery_rider_id) !==
    Number(req.user.id)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'This delivery order is not assigned to you'

    });

  }

}
    const order =
      await markCompleted(
        orderId,
        restaurantId
      );


    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only delivered orders can be completed'

      });

    }


    emitOrderUpdated(
      req,
      order
    );


    const io =
      getIO(req);


    if (io) {

      io.to(
        getRoom(restaurantId)
      ).emit(
        'order_completed',
        order
      );

    }


    return res.status(200).json({

      success: true,

      message:
        'Delivery order completed successfully',

      order

    });

  }
  catch (err) {

    console.error(
      'completed:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// SERVE ORDER
//
// ready → served
//
// Inventory is deducted here.
//
// Allowed:
// waiter
// manager
//
// IMPORTANT:
// Delivery orders are NOT served here.
// They use:
// ready_to_deliver → out_for_delivery
// in later delivery flow.
// ======================================================

exports.serve = async (
  req,
  res
) => {

  if (
    !['waiter', 'manager']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only waiter or manager can serve orders'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const order =
      await markServed(
        orderId,
        restaurantId
      );


    // --------------------------------------------------
    // INVENTORY NOT FOUND
    // --------------------------------------------------

        if (order && order.error === 'KITCHEN_STOCK_NOT_FOUND') {
      return res.status(409).json({ success: false, message: `Kitchen inventory not found for ${order.ingredient}` });
    }

    if (order && order.error === 'INSUFFICIENT_KITCHEN_STOCK') {
      return res.status(409).json({ success: false, message: `Insufficient kitchen stock for ${order.ingredient}. Available: ${order.available} ${order.unit}, Required: ${order.required} ${order.unit}` });
    }


    // --------------------------------------------------
    // INVALID STATUS
    // --------------------------------------------------

    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only ready dine-in orders can be served'

      });

    }


    emitOrderUpdated(
      req,
      order
    );


    const io =
      getIO(req);


    if (io) {

      io.to(
        getRoom(restaurantId)
      ).emit(
        'order_served',
        order
      );

    }


    return res.status(200).json({

      success: true,

      message:
        'Order served successfully',

      order

    });

  }
  catch (err) {

    console.error(
      'serve:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};

// ======================================================
// CANCEL ORDER
//
// Active order:
// reservation → released
// order → cancelled
//
// Allowed:
// waiter
// manager
// counter
// ======================================================

exports.cancel = async (
  req,
  res
) => {

  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const order =
      await cancelOrder(
        orderId,
        restaurantId
      );


    if (!order) {

      return res.status(404).json({

        success: false,

        message:
          'Order not found'

      });

    }


    emitOrderUpdated(
      req,
      order
    );


    return res.status(200).json({

      success: true,

      message:
        'Order cancelled and inventory reservation released',

      order

    });

  }

  catch (err) {

    console.error(
      'cancel:',
      err
    );


    return res.status(409).json({

      success: false,

      message:
        err.message ||
        'Unable to cancel order'

    });

  }

};


// ======================================================
// ADD ITEMS TO SERVED UNPAID BILL
//
// Allowed:
// manager
// counter
//
// Model:
// served + unpaid
// ======================================================

exports.addItems = async (
  req,
  res
) => {

  if (
    !['manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only manager and counter can add items to a bill'

    });

  }


  const orderId =
    Number(req.params.id);


  const {
    items
  } = req.body;


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'At least one item is required'

    });

  }


    const normalizedItems = [];


  for (
    const item
    of items
  ) {

    const menuItemId =
      Number(item.menu_item_id);

    const quantity =
      Number(item.quantity);

    const variantId =
      item.variant_id === undefined ||
      item.variant_id === null ||
      item.variant_id === ''
        ? null
        : Number(item.variant_id);


    if (
      !Number.isInteger(menuItemId) ||
      menuItemId <= 0 ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      (
        variantId !== null &&
        (!Number.isInteger(variantId) || variantId <= 0)
      )
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Invalid item or quantity'

      });

    }


    normalizedItems.push({

      menu_item_id:
        menuItemId,

      variant_id:
        variantId,

      quantity:
        quantity

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    await addItemsToOrder(
      orderId,
      normalizedItems,
      restaurantId,
      req.user.role
    );


    const orders =
      await getAllOrders(
        restaurantId
      );


    const order =
      orders.find(
        item =>
          Number(item.id) ===
          orderId
      );


    if (!order) {

      return res.status(404).json({

        success: false,

        message:
          'Order not found'

      });

    }


    emitOrderUpdated(
      req,
      order
    );


    return res.status(200).json({

      success: true,

      message:
        'Item added to bill successfully',

      order

    });

  }
    catch (err) {
    if (err.error === 'INSUFFICIENT_KITCHEN_STOCK' || err.error === 'KITCHEN_STOCK_NOT_FOUND') {
      return res.status(409).json({
        success: false,
        error: err.error,
        ingredient: err.ingredient,
        available: err.available,
        required: err.required,
        unit: err.unit,
        message: err.message
      });
    }
    
  

    console.error(
      'addItems:',
      err
    );


    if (
      err.message &&
      err.message.includes(
        'Only served unpaid'
      )
    ) {

      return res.status(409).json({

        success: false,

        message:
          err.message

      });

    }


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// UPDATE PRICING
//
// Allowed:
// manager
// counter
//
// Model:
// served + unpaid
// ======================================================

exports.updatePricing = async (
  req,
  res
) => {

  if (
    !['manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only manager and counter can update bill pricing'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const {
    discount_type = 'none',
    discount_value = 0,
    gst_percent = 0,
    tax_percent = 0,
    delivery_charge = 0,
    dine_charge = 0
  } = req.body;


  if (
    !['none', 'percent', 'fixed']
      .includes(discount_type)
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Discount type must be none, percent or fixed'

    });

  }


  const discountValue =
    Number(discount_value);

  const gstPercent =
    Number(gst_percent);

  const taxPercent =
    Number(tax_percent);


  if (
    !Number.isFinite(discountValue) ||
    !Number.isFinite(gstPercent) ||
    !Number.isFinite(taxPercent)
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Discount, GST and tax must be valid numbers'

    });

  }


  if (
    discountValue < 0 ||
    gstPercent < 0 ||
    taxPercent < 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Discount, GST and tax cannot be negative'

    });

  }


  if (
    discount_type === 'percent' &&
    discountValue > 100
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Percentage discount cannot exceed 100%'

    });

  }


  if (
    gstPercent > 100
  ) {

    return res.status(400).json({

      success: false,

      message:
        'GST percentage cannot exceed 100%'

    });

  }


  if (
    taxPercent > 100
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Tax percentage cannot exceed 100%'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const order =
      await updateOrderPricing(

        orderId,

        restaurantId,

        {
          discount_type,
          discount_value:
            discountValue,
          gst_percent:
            gstPercent,
          tax_percent:
            taxPercent,
          delivery_charge:
            Number(delivery_charge),
          dine_charge:
            Number(dine_charge)
        }

      );


    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only served unpaid orders can have pricing updated'

      });

    }


    emitOrderUpdated(
      req,
      order
    );


    return res.status(200).json({

      success: true,

      message:
        'Bill pricing updated successfully',

      order

    });

  }
  catch (err) {

    console.error(
      'updatePricing:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// PAYMENT
//
// served + unpaid
//       ↓
// paid
//
// Payment does NOT:
// - serve order
// - deduct inventory
//
// Inventory was already deducted at SERVED.
//
// Allowed:
// manager
// counter
// ======================================================

exports.pay = async (
  req,
  res
) => {

  if (
    !['manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only manager and counter can receive payment'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const paymentMethod =
    req.body.payment_method ||
    'Cash';


  const allowedPaymentMethods = [
    'Cash',
    'Card',
    'Bank',
    'Other'
  ];


  if (
    !allowedPaymentMethods.includes(
      paymentMethod
    )
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid payment method'

    });

  }


  let paidAmount = null;


  if (
    req.body.paid_amount !== undefined &&
    req.body.paid_amount !== null &&
    req.body.paid_amount !== ''
  ) {

    paidAmount =
      Number(
        req.body.paid_amount
      );


    if (
      !Number.isFinite(paidAmount) ||
      paidAmount < 0
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Paid amount must be a valid number'

      });

    }

  }


  

  


  // ✅ NEW: Card / Bank surcharge amounts
  const cardCharge = Number(req.body.card_charge || 0);
  const bankCharge = Number(req.body.bank_charge || 0);

  if (!Number.isFinite(cardCharge) || cardCharge < 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid card charge'
    });
  }

  if (!Number.isFinite(bankCharge) || bankCharge < 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid bank charge'
    });
  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const order =
      await markPaid(

        orderId,

        restaurantId,

        paymentMethod,

        paidAmount,

        req.user?.id || null,

        cardCharge,          // ✅ NEW
        bankCharge           // ✅ NEW

      );


    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only served unpaid orders can be paid'

      });

    }


    emitOrderUpdated(
      req,
      order
    );
    

   
      


    const io =
      getIO(req);


    if (io) {

      io.to(
        getRoom(restaurantId)
      ).emit(
        'order_paid',
        order
      );

    }
   // Order items bhi fetch karne padenge

(async () => {
  try {
    const orderForFbr = await getOrderById(order.id);
    const itemsForFbr = await getOrderItemsByOrderId(order.id);
    
    if (orderForFbr) {
      await submitInvoiceForOrder(orderForFbr, itemsForFbr);
    }
  } catch (fbrErr) {
    console.error('FBR submission error:', fbrErr);
    // Payment flow pe koi asar nahi
  }
})();




    return res.status(200).json({

      success: true,

      message:
        'Payment received successfully',

      order

    });

  }
  catch (err) {

    console.error(
      'pay:',
      err
    );


    if (
      err.message ===
      'Paid amount cannot be less than total amount.'
    ) {

      return res.status(400).json({

        success: false,

        message:
          err.message

      });

    }


    if (
      err.message ===
      'Invalid paid amount.'
    ) {

      return res.status(400).json({

        success: false,

        message:
          err.message

      });

    }


    if (
      err.message ===
      'Invalid payment method.'
    ) {

      return res.status(400).json({

        success: false,

        message:
          err.message

      });

    }


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// UPDATE ITEM QUANTITY
//
// Allowed:
// waiter
// manager
// counter
//
// Manager / counter:
// served + unpaid only
//
// Waiter:
// active order editing
// ======================================================

exports.updateItemQty = async (
  req,
  res
) => {

  if (
    !['waiter', 'manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Access denied'

    });

  }


  const quantity =
    Number(
      req.body.quantity
    );


  if (
    !Number.isInteger(quantity) ||
    quantity < 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid quantity'

    });

  }


  const orderItemId =
    Number(
      req.params.orderItemId
    );


  if (
    !Number.isInteger(orderItemId) ||
    orderItemId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order item ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const item =
      await updateOrderItemQuantity(

        orderItemId,

        quantity,

        restaurantId,

        req.user.role

      );


    if (!item) {

      return res.status(404).json({

        success: false,

        message:
          'Order item not found'

      });

    }


    const orders =
      await getAllOrders(
        restaurantId
      );


    const order =
      orders.find(
        order =>
          Number(order.id) ===
          Number(item.order_id)
      );


    if (order) {

      emitOrderUpdated(
        req,
        order
      );

    }

    else {

      const io =
        getIO(req);


      if (io) {

        io.to(
          getRoom(restaurantId)
        ).emit(
          'orders_refresh'
        );

      }

    }


    return res.status(200).json({

      success: true,

      message:
        'Quantity updated successfully',

      item,

      order:
        order || null

    });

  }
  catch (err) {

    console.error(
      'updateItemQty:',
      err
    );

    if (err.error === 'INSUFFICIENT_KITCHEN_STOCK' || err.error === 'KITCHEN_STOCK_NOT_FOUND') {
      return res.status(409).json({
        success: false,
        error: err.error,
        ingredient: err.ingredient,
        available: err.available,
        required: err.required,
        unit: err.unit,
        message: err.message
      });
    }



    if (
      err.message &&
      err.message.includes(
        'Only served unpaid'
      )
    ) {

      return res.status(409).json({

        success: false,

        message:
          err.message

      });

    }


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// REMOVE ITEM
//
// Allowed:
// waiter
// manager
// counter
// ======================================================

exports.removeItem = async (
  req,
  res
) => {

  if (
    !['waiter', 'manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Access denied'

    });

  }


  const orderItemId =
    Number(
      req.params.orderItemId
    );


  if (
    !Number.isInteger(orderItemId) ||
    orderItemId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order item ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const removed =
      await removeOrderItem(

        orderItemId,

        restaurantId,

        req.user.role

      );


    if (!removed) {

      return res.status(404).json({

        success: false,

        message:
          'Order item not found'

      });

    }


    const io =
      getIO(req);


    if (io) {

      io.to(
        getRoom(restaurantId)
      ).emit(
        'orders_refresh'
      );

    }


    return res.status(200).json({

      success: true,

      message:
        'Item removed successfully'

    });

  }
  catch (err) {

    console.error(
      'removeItem:',
      err
    );


    if (
      err.message &&
      err.message.includes(
        'Only served unpaid'
      )
    ) {

      return res.status(409).json({

        success: false,

        message:
          err.message

      });

    }


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


exports.lookupCustomer = async (req, res) => {

  const restaurantId = getRestaurantId(req);

  if (!isValidRestaurantId(restaurantId)) {
    return res.status(401).json({
      success: false,
      message: 'Restaurant information is missing'
    });
  }

  const phone = String(req.query.phone || '').trim();

  if (!phone) {
    return res.status(400).json({
      success: false,
      message: 'phone is required'
    });
  }

  try {

    const customer = await findCustomerByPhone(
      phone,
      restaurantId
    );

    return res.json({
      success: true,
      data: customer
    });

  } catch (err) {

    console.error('lookupCustomer:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });

  }

};

// ======================================================
// GET MY DELIVERY ORDERS
//
// Returns delivery orders assigned to logged-in rider.
//
// Allowed:
// delivery
// ======================================================

exports.getMyDeliveryOrders = async (
  req,
  res
) => {

  if (
    req.user?.role !== 'delivery'
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only delivery riders can view their delivery orders'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  const riderId =
    Number(req.user?.id);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  if (
    !Number.isInteger(riderId) ||
    riderId <= 0
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Rider information is missing'

    });

  }


  try {

    const orders =
      await getMyDeliveryOrders(
        restaurantId,
        riderId
      );


    return res.status(200).json({

      success: true,

      count:
        orders.length,

      orders

    });

  }
  catch (err) {

    console.error(
      'getMyDeliveryOrders:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};

// ======================================================
// GET DELIVERY RIDERS
//
// Returns active delivery staff for current restaurant.
//
// Allowed:
// manager
// counter
// ======================================================

exports.getDeliveryRiders = async (
  req,
  res
) => {

  if (
    !['manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only manager or counter can view delivery riders'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const riders =
      await getDeliveryRiders(
        restaurantId
      );


    return res.status(200).json({

      success: true,

      riders

    });

  }
  catch (err) {

    console.error(
      'getDeliveryRiders:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// ASSIGN DELIVERY RIDER
//
// ready_to_deliver delivery order
//        ↓
// assigned rider
//
// Allowed:
// manager
// counter
// ======================================================

exports.assignDeliveryRider = async (
  req,
  res
) => {

  if (
    !['manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only manager or counter can assign delivery riders'

    });

  }


  const orderId =
    Number(req.params.id);


  const riderId =
    Number(req.body?.rider_id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  if (
    !Number.isInteger(riderId) ||
    riderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid rider ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const order =
      await assignDeliveryRider(
        orderId,
        restaurantId,
        riderId
      );


    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only ready delivery orders can be assigned to an active delivery rider'

      });

    }


    emitOrderUpdated(
      req,
      order
    );


    const io =
      getIO(req);


    if (io) {

      io.to(
        getRoom(restaurantId)
      ).emit(
        'delivery_rider_assigned',
        order
      );

    }


    return res.status(200).json({

      success: true,

      message:
        'Delivery rider assigned successfully',

      order

    });

  }
  catch (err) {

    console.error(
      'assignDeliveryRider:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};


// ======================================================
// UNASSIGN DELIVERY RIDER
//
// Allowed:
// manager
// counter
// ======================================================

exports.unassignDeliveryRider = async (
  req,
  res
) => {

  if (
    !['manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only manager or counter can unassign delivery riders'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const order =
      await unassignDeliveryRider(
        orderId,
        restaurantId
      );


    if (!order) {

      return res.status(409).json({

        success: false,

        message:
          'Only ready delivery orders can be unassigned'

      });

    }


    emitOrderUpdated(
      req,
      order
    );


    return res.status(200).json({

      success: true,

      message:
        'Delivery rider unassigned successfully',

      order

    });

  }
  catch (err) {

    console.error(
      'unassignDeliveryRider:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};

// ======================================================
// AUTO ASSIGN DELIVERY RIDER
//
// ready_to_deliver delivery order
//        ↓
// least-loaded active rider
//
// Allowed:
// manager
// counter
// ======================================================

exports.autoAssignDeliveryRider = async (
  req,
  res
) => {

  if (
    !['manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only manager or counter can auto-assign delivery riders'

    });

  }


  const orderId =
    Number(req.params.id);


  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'Invalid order ID'

    });

  }


  const restaurantId =
    getRestaurantId(req);


  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }


  try {

    const result =
      await autoAssignDeliveryRider(
        orderId,
        restaurantId
      );


    if (!result) {

      return res.status(409).json({

        success: false,

        message:
          'No active delivery rider available, or order is not ready for delivery'

      });

    }


    const order =
      result.order;


    emitOrderUpdated(
      req,
      order
    );


    const io =
      getIO(req);


    if (io) {

      io.to(
        getRoom(restaurantId)
      ).emit(
        'delivery_rider_assigned',
        order
      );

    }


    return res.status(200).json({

      success: true,

      message:
        'Delivery rider automatically assigned successfully',

      order,

      rider_id:
        result.rider_id,

      active_order_count:
        result.active_order_count

    });

  }
  catch (err) {

    console.error(
      'autoAssignDeliveryRider:',
      err
    );


    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};

// ======================================================
// DELIVERY RIDER SUMMARY
//
// Allowed:
// manager
// counter
//
// Query:
// ?date=2026-08-26
// ?from=2026-08-01&to=2026-08-26
// ======================================================

exports.getRiderSummary = async (
  req,
  res
) => {

  if (
    !['manager', 'counter']
      .includes(req.user?.role)
  ) {

    return res.status(403).json({

      success: false,

      message:
        'Only manager or counter can view rider summary'

    });

  }

  const restaurantId =
    getRestaurantId(req);

  if (
    !isValidRestaurantId(restaurantId)
  ) {

    return res.status(401).json({

      success: false,

      message:
        'Restaurant information is missing'

    });

  }

  try {

    const {
      date,
      from,
      to
    } = req.query;

    const summary =
      await getRiderSummary(
        restaurantId,
        {
          date,
          from,
          to
        }
      );

    return res.status(200).json({

      success: true,

      ...summary

    });

  }
  catch (err) {

    console.error(
      'getRiderSummary:',
      err
    );

    return res.status(500).json({

      success: false,

      message:
        err.message ||
        'Internal Server Error'

    });

  }

};

// ======================================================
// UPDATE DEAL QUANTITY
//
// Allowed:
// waiter
// manager
// counter
//
// Manager / counter:
// served + unpaid only
//
// Waiter:
// active order editing
// ======================================================

exports.updateDealQuantity = async (req, res) => {
  const { dealId } = req.params;
  const { quantity } = req.body;
  const userRole = req.user?.role;

  // ✅ Role check
  if (!['waiter', 'manager', 'counter'].includes(userRole)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied'
    });
  }

  // ✅ Validate quantity
  const newQuantity = Number(quantity);
  if (!Number.isInteger(newQuantity) || newQuantity < 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid quantity'
    });
  }

  const restaurantId = getRestaurantId(req);
  if (!isValidRestaurantId(restaurantId)) {
    return res.status(401).json({
      success: false,
      message: 'Restaurant information is missing'
    });
  }

  try {
    // 1. Get deal + order info
    const dealResult = await pool.query(
      `SELECT 
         od.*, 
         o.id as order_id, 
         o.status, 
         o.payment_status,
         o.restaurant_id
       FROM order_deals od
       JOIN orders o ON o.id = od.order_id
       WHERE od.id = $1`,
      [dealId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Deal not found'
      });
    }

    const deal = dealResult.rows[0];
    const orderId = deal.order_id;

    // 2. Authorization: only served+unpaid (counter/manager) or active (waiter)
    if (['counter', 'manager'].includes(userRole)) {
      if (deal.status !== 'served' || deal.payment_status !== 'unpaid') {
        return res.status(403).json({
          success: false,
          message: 'Only served unpaid bills can be edited'
        });
      }
    } else if (userRole === 'waiter') {
      if (['served', 'completed', 'cancelled'].includes(deal.status)) {
        return res.status(403).json({
          success: false,
          message: 'Cannot edit completed or served orders'
        });
      }
    }

    // 3. Update or delete deal
    if (newQuantity <= 0) {
      // Delete deal and its items
      await pool.query('DELETE FROM order_items WHERE order_deal_id = $1', [dealId]);
      await pool.query('DELETE FROM order_deals WHERE id = $1', [dealId]);
    } else {
      // Update deal quantity
      await pool.query(
        'UPDATE order_deals SET quantity = $1 WHERE id = $2',
        [newQuantity, dealId]
      );

      // Refresh deal items (delete old, reinsert with new quantity)
      await refreshDealItems(dealId, newQuantity, orderId);
    }

    // 4. Recalculate order pricing
    await recalculateOrderPricing(orderId, restaurantId);

    // 5. Return updated order
    const updatedOrderResult = await pool.query(
      `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2`,
      [orderId, restaurantId]
    );

    const io = getIO(req);
    if (io) {
      io.to(getRoom(restaurantId)).emit('orders_refresh');
    }

    return res.status(200).json({
      success: true,
      message: 'Deal quantity updated successfully',
      order: updatedOrderResult.rows[0] || null
    });

  } catch (err) {
    console.error('updateDealQuantity:', err);

    if (err.error === 'INSUFFICIENT_KITCHEN_STOCK' || err.error === 'KITCHEN_STOCK_NOT_FOUND') {
      return res.status(409).json({
        success: false,
        error: err.error,
        ingredient: err.ingredient,
        available: err.available,
        required: err.required,
        unit: err.unit,
        message: err.message
      });
    }

    return res.status(500).json({
      success: false,
      message: err.message || 'Internal Server Error'
    });
  }
};

// ======================================================
// HELPER: REFRESH DEAL ITEMS
// ======================================================

async function refreshDealItems(orderDealId, newDealQuantity, orderId) {
  // 1. Get deal_items from deal definition
  const dealItemsResult = await pool.query(
    `SELECT di.menu_item_id, di.variant_id, di.quantity
     FROM order_deals od
     JOIN deals d ON d.id = od.deal_id
     JOIN deal_items di ON di.deal_id = d.id
     WHERE od.id = $1`,
    [orderDealId]
  );

  if (dealItemsResult.rows.length === 0) return;

  // 2. Delete existing order_items for this deal
  await pool.query('DELETE FROM order_items WHERE order_deal_id = $1', [orderDealId]);

  // 3. Re-insert with new quantity
  for (const item of dealItemsResult.rows) {
    const newQty = Number(item.quantity) * newDealQuantity;
    await pool.query(
      `INSERT INTO order_items
       (order_id, menu_item_id, variant_id, quantity, order_deal_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, item.menu_item_id, item.variant_id, newQty, orderDealId]
    );
  }
}

// ======================================================
// HELPER: RECALCULATE ORDER PRICING
// ======================================================

async function recalculateOrderPricing(orderId, restaurantId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get all items (including deals)
    const itemsResult = await client.query(
      `SELECT 
         oi.quantity, 
         COALESCE(miv.price, m.price) as price
       FROM order_items oi
       JOIN menu_items m ON m.id = oi.menu_item_id
       LEFT JOIN menu_item_variants miv ON miv.id = oi.variant_id
       WHERE oi.order_id = $1`,
      [orderId]
    );

    let subtotal = 0;
    itemsResult.rows.forEach(row => {
      subtotal += Number(row.quantity) * Number(row.price);
    });

    // ✅ Card/bank bhi fetch karo
    const orderResult = await client.query(
      `SELECT discount_type, discount_value, gst_percent, tax_percent,
              delivery_charge, dine_charge, card_charge, bank_charge
       FROM orders WHERE id = $1 AND restaurant_id = $2`,
      [orderId, restaurantId]
    );
    const order = orderResult.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return;
    }

    let discountAmount = 0;
    if (order.discount_type === 'percent') {
      discountAmount = subtotal * (order.discount_value / 100);
    } else if (order.discount_type === 'fixed') {
      discountAmount = order.discount_value;
    }
    discountAmount = Math.min(discountAmount, subtotal);

    const afterDiscount = subtotal - discountAmount;
    const gstAmount = afterDiscount * (order.gst_percent / 100);
    const taxAmount = afterDiscount * (order.tax_percent / 100);

    // ✅ Sab charges add karo
    const deliveryCharge = Number(order.delivery_charge || 0);
    const dineCharge = Number(order.dine_charge || 0);
    const cardCharge = Number(order.card_charge || 0);
    const bankCharge = Number(order.bank_charge || 0);
    const total = afterDiscount + gstAmount + taxAmount + deliveryCharge + dineCharge + cardCharge + bankCharge;

    await client.query(
      `UPDATE orders SET
        subtotal = $1,
        discount_amount = $2,
        gst_amount = $3,
        tax_amount = $4,
        total_amount = $5
       WHERE id = $6 AND restaurant_id = $7`,
      [subtotal, discountAmount, gstAmount, taxAmount, total, orderId, restaurantId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const { markWalkInHandedOver } = require('../models/orderModel');

exports.handoverWalkIn = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantId = req.user.restaurant_id;

    const result = await markWalkInHandedOver(id, restaurantId);

    // Order nahi mila ya galat status mein hai
    if (!result) {
      return res.status(409).json({
        success: false,
        message: 'Only ready walk-in orders can be handed over to the customer.'
      });
    }

    // Stock error
    if (result.error) {
      return res.status(409).json({
        success: false,
        error: result.error,
        ingredient: result.ingredient,
        available: result.available,
        required: result.required,
        unit: result.unit,
        message: `Sorry, ${result.ingredient || 'item'} has low stock.`
      });
    }

    // Socket event emit karein taake dusre screens refresh ho jayein
    req.app.get('io')
      .to(`restaurant_${restaurantId}`)
      .emit('order_updated', result);

    return res.json({
      success: true,
      order: result
    });

  } catch (err) {
    console.error('handoverWalkIn:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ======================================================
// RIDER'S OWN SUMMARY (for rider app)
// ======================================================

exports.getMyRiderSummary = async (req, res) => {
  if (req.user?.role !== 'delivery') {
    return res.status(403).json({
      success: false,
      message: 'Only delivery riders can view their summary'
    });
  }

  const restaurantId = getRestaurantId(req);
  const riderId = Number(req.user.id);

  if (!isValidRestaurantId(restaurantId)) {
    return res.status(401).json({
      success: false,
      message: 'Restaurant information is missing'
    });
  }

  try {
    const { date, from, to } = req.query;
    const params = [restaurantId, riderId];
    let dateCondition = '';

    if (date) {
      params.push(date);
      dateCondition = `AND o.created_at::date = $${params.length}::date`;
    } else if (from && to) {
      params.push(from);
      params.push(to);
      dateCondition = `AND o.created_at >= $${params.length - 1}::date 
                       AND o.created_at < ($${params.length}::date + INTERVAL '1 day')`;
    }

    const result = await pool.query(`
      SELECT 
        o.id, o.status, o.order_type, o.customer_name,
        o.delivery_phone, o.delivery_address, o.total_amount,
        o.created_at, o.delivered_at, o.completed_at,
        o.payment_status, o.payment_method
      FROM orders o
      WHERE o.restaurant_id = $1
        AND o.delivery_rider_id = $2
        AND o.order_type = 'delivery'
        ${dateCondition}
      ORDER BY o.created_at DESC
    `, params);

    const orders = result.rows;

    const deliveredOrders = orders.filter(o => 
      o.status === 'delivered' || o.status === 'completed'
    );
    const activeOrders = orders.filter(o => 
      ['ready_to_deliver', 'out_for_delivery'].includes(o.status)
    );
    const cancelledOrders = orders.filter(o => o.status === 'cancelled');

    const totalSales = deliveredOrders.reduce(
      (sum, o) => sum + Number(o.total_amount || 0), 0
    );

    const dailyMap = {};
    orders.forEach(o => {
      const day = new Date(o.created_at).toISOString().slice(0, 10);
      if (!dailyMap[day]) {
        dailyMap[day] = { date: day, count: 0, delivered: 0, sales: 0 };
      }
      dailyMap[day].count++;
      if (o.status === 'delivered' || o.status === 'completed') {
        dailyMap[day].delivered++;
        dailyMap[day].sales += Number(o.total_amount || 0);
      }
    });

    const daily = Object.values(dailyMap).sort((a, b) => 
      b.date.localeCompare(a.date)
    );

    return res.json({
      success: true,
      data: {
        orders,
        stats: {
          total_orders: orders.length,
          delivered_count: deliveredOrders.length,
          active_count: activeOrders.length,
          cancelled_count: cancelledOrders.length,
          total_sales: totalSales,
          daily
        }
      }
    });

  } catch (err) {
    console.error('getMyRiderSummary:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Internal Server Error'
    });
  }
};
