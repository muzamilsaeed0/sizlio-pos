const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

/*
 * Public endpoints are intentionally unauthenticated, so protect the
 * expensive/action endpoints separately from the global API limiter.
 *
 * Limits are per client IP. They are high enough for normal restaurant
 * usage while stopping simple order/call-waiter spam.
 */
const publicOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many public orders. Please try again later.'
  }
});

const callWaiterLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many waiter calls. Please wait before trying again.'
  }
});
const { authMiddleware, authorize } = require('../middleware/authMiddleware');

const {
  serverInfo,
  getPublicMenu,
  getPublicDeals,
  callWaiter,
  placePublicOrder,
  getRestaurantInfo,
  getTableTokens
} = require('../controllers/publicController');

// ======================================================
// EXISTING ROUTES (same rakhें)
// ======================================================

router.get('/server-info', serverInfo);
router.get('/:restaurantId/menu', getPublicMenu);
router.get('/:restaurantId/deals', getPublicDeals);
router.get('/:restaurantId/info', getRestaurantInfo);
router.post('/:restaurantId/order', publicOrderLimiter, placePublicOrder);
router.post('/:restaurantId/call-waiter', callWaiterLimiter, callWaiter);

// Authenticated QR generation for restaurant managers/super admins.
router.get('/:restaurantId/table-tokens', authMiddleware, authorize('manager', 'super_admin'), getTableTokens);


// ======================================================
// NEW: VERIFY CUSTOMER LOCATION (GPS)
// ======================================================

router.post('/:restaurantId/verify-location', async (req, res) => {
  const { latitude, longitude } = req.body;
  const restaurantId = Number(req.params.restaurantId);
  
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (
    !Number.isInteger(restaurantId) || restaurantId <= 0 ||
    !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    !Number.isFinite(lng) || lng < -180 || lng > 180
  ) {
    return res.status(400).json({
      success: false,
      message: 'Valid restaurant and location coordinates are required'
    });
  }
  
  try {
    const pool = require('../config/db');
    
    const result = await pool.query(
      `SELECT latitude, longitude, gps_radius_meters, name 
       FROM restaurants WHERE id = $1`,
      [restaurantId]
    );
    
    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Restaurant not found'
      });
    }
    
    const restaurant = result.rows[0];
    
    // Fail closed: the order endpoint also requires configured coordinates.
    if (
      restaurant.latitude === null || restaurant.latitude === undefined ||
      restaurant.longitude === null || restaurant.longitude === undefined ||
      !Number.isFinite(Number(restaurant.latitude)) ||
      !Number.isFinite(Number(restaurant.longitude)) ||
      Number(restaurant.latitude) < -90 || Number(restaurant.latitude) > 90 ||
      Number(restaurant.longitude) < -180 || Number(restaurant.longitude) > 180
    ) {
      return res.status(403).json({
        success: false,
        allowed: false,
        error: 'RESTAURANT_LOCATION_NOT_CONFIGURED',
        message: 'This restaurant has not configured its location for QR ordering.'
      });
    }
    
    // Distance calculate karo (Haversine formula)
    const distance = calculateDistance(
      lat,
      lng,
      Number(restaurant.latitude),
      Number(restaurant.longitude)
    );
    
    const radius = Number(restaurant.gps_radius_meters) || 100;
    const allowed = distance <= radius;
    
    res.json({
      success: true,
      allowed,
      distance: Math.round(distance),
      radius,
      restaurant_name: restaurant.name,
      message: allowed 
        ? `Location verified (${Math.round(distance)}m from restaurant)`
        : `You are ${Math.round(distance)}m away. Please come to the restaurant.`
    });
    
  } catch (err) {
    console.error('Location verify error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});


// ======================================================
// HELPER: HAVERSINE DISTANCE (meters)
// ======================================================

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}


module.exports = router;