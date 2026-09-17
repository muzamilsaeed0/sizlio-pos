
const express = require('express');

const router = express.Router();


const {
  authMiddleware,
  authorize
} = require('../middleware/authMiddleware');


const {
  placeOrder,
  getOrders,
  accept,
  confirm,
  ready,
  outForDelivery,
  delivered,
  completed,
  serve,
  handoverWalkIn, 
  cancel,
  addItems,
  updatePricing,
  pay,
  updateItemQty,
  removeItem,
  lookupCustomer,
  getMyDeliveryOrders,
  getDeliveryRiders,
  getRiderSummary,
  getMyRiderSummary,    
  assignDeliveryRider,
  unassignDeliveryRider,
  autoAssignDeliveryRider,
  updateDealQuantity

} = require('../controllers/orderController');


router.get(
  '/customer-lookup',
  authMiddleware,
  authorize(
    'waiter',
    'manager',
    'counter'
  ),
  lookupCustomer
);

// ======================================================
// MY DELIVERY ORDERS
//
// Logged-in delivery rider ke assigned orders.
// ======================================================

router.get(
  '/my-deliveries',
  authMiddleware,
  authorize(
    'delivery'
  ),
  getMyDeliveryOrders
);

// ======================================================
// DELIVERY RIDERS
// ======================================================

router.get(
  '/delivery-riders',
  authMiddleware,
  authorize(
    'manager',
    'counter'
  ),
  getDeliveryRiders
);

// ======================================================
// DELIVERY RIDER SUMMARY
//
// Allowed:
// manager
// counter
// ======================================================

router.get(
  '/rider-summary',
  authMiddleware,
  authorize(
    'manager',
    'counter'
  ),
  getRiderSummary
);

// ======================================================
// MY RIDER SUMMARY (for rider app)
//
// Logged-in rider ki apni summary (date/month/custom)
// ======================================================

router.get(
  '/rider/my-summary',
  authMiddleware,
  authorize('delivery'),
  getMyRiderSummary
);

// ======================================================
// ASSIGN DELIVERY RIDER
// ======================================================

router.put(
  '/:id/assign-rider',
  authMiddleware,
  authorize(
    'manager',
    'counter'
  ),
  assignDeliveryRider
);

// ======================================================
// AUTO ASSIGN DELIVERY RIDER
//
// ready_to_deliver → least-loaded active rider
//
// Allowed:
// manager
// counter
// ======================================================

router.put(
  '/:id/auto-assign-rider',
  authMiddleware,
  authorize(
    'manager',
    'counter'
  ),
  autoAssignDeliveryRider
);


// ======================================================
// UNASSIGN DELIVERY RIDER
// ======================================================

router.put(
  '/:id/unassign-rider',
  authMiddleware,
  authorize(
    'manager',
    'counter'
  ),
  unassignDeliveryRider
);

// ======================================================
// CREATE ORDER
//
// Allowed:
// waiter
// manager
// counter
//
// Flow:
// New order → pending
// ======================================================

router.post(
  '/',
  authMiddleware,
  authorize(
    'waiter',
    'manager',
    'counter'
  ),
  placeOrder
);


// ======================================================
// GET ALL ORDERS
//
// Allowed:
// manager
// waiter
// kitchen
// counter
//
// Counter POS needs this to display current status.
// ======================================================

router.get(
  '/',
  authMiddleware,
  authorize(
    'manager',
    'waiter',
    'kitchen',
    'counter',
    'delivery',
    'display'
  ),
  getOrders
);


// ======================================================
// ACCEPT ORDER
//
// pending → accepted
//
// Allowed:
// waiter
// manager
// ======================================================

router.put(
  '/:id/accept',
  authMiddleware,
  authorize(
    'waiter',
    'manager'
  ),
  accept
);


// ======================================================
// CONFIRM ORDER
//
// accepted → confirmed
//
// Allowed:
// kitchen
// manager
// ======================================================

router.put(
  '/:id/confirm',
  authMiddleware,
  authorize(
    'kitchen',
    'manager'
  ),
  confirm
);


// ======================================================
// MARK READY
//
// confirmed → ready
//
// Allowed:
// kitchen
// manager
// ======================================================

router.put(
  '/:id/ready',
  authMiddleware,
  authorize(
    'kitchen',
    'manager'
  ),
  ready
);


// ======================================================
// OUT FOR DELIVERY
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

router.put(
  '/:id/out-for-delivery',
  authMiddleware,
  authorize(
    'delivery',
    'manager',
    'counter'
  ),
  outForDelivery
);


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

router.put(
  '/:id/delivered',
  authMiddleware,
  authorize(
    'delivery',
    'manager',
    'counter'
  ),
  delivered
);


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

router.put(
  '/:id/completed',
  authMiddleware,
  authorize(
    'delivery',
    'manager',
    'counter'
  ),
  completed
);

// ======================================================
// CANCEL ORDER
//
// Active order → cancelled
// Active reservation → released
//
// Allowed:
// waiter
// manager
// counter
// ======================================================

router.put(
  '/:id/cancel',
  authMiddleware,
  authorize(
    'waiter',
    'manager',
    'counter'
  ),
  cancel
);

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
// ======================================================

router.put(
  '/:id/serve',
  authMiddleware,
  authorize(
    'waiter',
    'manager'
  ),
  serve
);


router.put(
  '/:id/handover',
  authMiddleware,
  authorize('counter', 'manager'),
  handoverWalkIn
);

// ======================================================
// ADD ITEMS TO SERVED + UNPAID BILL
//
// Allowed:
// manager
// counter
//
// IMPORTANT:
// Must match orderController.js
// ======================================================

router.post(
  '/:id/items',
  authMiddleware,
  authorize(
    'manager',
    'counter'
  ),
  addItems
);



router.put(
  '/deals/:dealId',
  authMiddleware,
  authorize('waiter', 'manager', 'counter'),
  updateDealQuantity
);


// ======================================================
// UPDATE BILL PRICING
//
// Served + unpaid only.
//
// Allowed:
// manager
// counter
//
// Discount / GST / Tax
// ======================================================

router.put(
  '/:id/pricing',
  authMiddleware,
  authorize(
    'manager',
    'counter'
  ),
  updatePricing
);


// ======================================================
// PAYMENT
//
// ready + unpaid → ready + paid
//
// Payment does NOT:
// - serve order
// - deduct inventory
//
// Allowed:
// manager
// counter
// ======================================================

router.put(
  '/:id/pay',
  authMiddleware,
  authorize(
    'manager',
    'counter'
  ),
  pay
);


// ======================================================
// UPDATE ORDER ITEM QUANTITY
//
// Allowed:
// waiter
// manager
// counter
//
// Manager / Counter:
// served + unpaid only.
//
// Waiter:
// active order editing.
// ======================================================

router.put(
  '/items/:orderItemId',
  authMiddleware,
  authorize(
    'waiter',
    'manager',
    'counter'
  ),
  updateItemQty
);


// ======================================================
// REMOVE ORDER ITEM
//
// Allowed:
// waiter
// manager
// counter
// ======================================================

router.delete(
  '/items/:orderItemId',
  authMiddleware,
  authorize(
    'waiter',
    'manager',
    'counter'
  ),
  removeItem
);


// ======================================================
// EXPORT
// ======================================================

module.exports = router;
