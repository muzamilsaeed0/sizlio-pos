const express = require('express');
const router = express.Router();

const {
  serverInfo,
  getPublicMenu,
  getPublicDeals,
  callWaiter,
  placePublicOrder,
  getRestaurantInfo
} = require('../controllers/publicController');

// ======================================================
// EXISTING ROUTES (same rakhें)
// ======================================================

router.get('/server-info', serverInfo);
router.get('/:restaurantId/menu', getPublicMenu);
router.get('/:restaurantId/deals', getPublicDeals);
router.get('/:restaurantId/info', getRestaurantInfo);
router.post('/:restaurantId/order', placePublicOrder);
router.post('/:restaurantId/call-waiter', callWaiter);


// ======================================================
// NEW: VERIFY CUSTOMER LOCATION (GPS)
// ======================================================

router.post('/:restaurantId/verify-location', async (req, res) => {
  const { latitude, longitude } = req.body;
  const restaurantId = Number(req.params.restaurantId);
  
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
    return res.status(400).json({
      success: false,
      message: 'Location required'
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
    
    // Agar restaurant ne location set nahi ki toh allow karo
    if (!restaurant.latitude || !restaurant.longitude) {
      return res.json({
        success: true,
        allowed: true,
        distance: null,
        message: 'Location not enforced'
      });
    }
    
    // Distance calculate karo (Haversine formula)
    const distance = calculateDistance(
      Number(latitude),
      Number(longitude),
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