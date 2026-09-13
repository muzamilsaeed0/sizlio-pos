const express = require('express');
const router = express.Router();

const {
  authMiddleware,
  authorize
} = require('../middleware/authMiddleware');

const restaurantController =
  require('../controllers/restaurantController');

const upload =
  require('../middleware/upload');


// ======================================================
// RESTAURANTS
// ======================================================

router.get(
  '/',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.listRestaurants
);


// ======================================================
// CREATE RESTAURANT
// ======================================================

router.post(
  '/',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.addRestaurant
);


// ======================================================
// MY RESTAURANT
// ======================================================

router.get(
  '/me',
  authMiddleware,
  restaurantController.getMyRestaurant
);


// ======================================================
// RESTAURANT STATUS
// ======================================================

router.patch(
  '/:id/status',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.setStatus
);


// ======================================================
// SUBSCRIPTION
// ======================================================

router.patch(
  '/:id/subscription',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.editSubscription
);


// ======================================================
// FOOD TYPE
// SUPER ADMIN ONLY
// ======================================================

router.patch(
  '/:id/food-type',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.editFoodType
);


// ======================================================
// RESET MANAGER PASSWORD
// ======================================================

router.patch(
  '/:id/reset-password',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.resetPassword
);


// ======================================================
// RESTAURANT DETAIL
// ======================================================

router.get(
  '/:id',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.getDetail
);


// ======================================================
// DELETE RESTAURANT
// ======================================================

router.delete(
  '/:id',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.removeRestaurant
);

// ======================================================
// UPDATE RESTAURANT DETAILS
// SUPER ADMIN ONLY
// ======================================================

router.put(
  '/:id',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.editRestaurant
);


// ======================================================
// UPLOAD LOGO
// ======================================================

router.post(
  '/:id/logo',
  authMiddleware,
  authorize('super_admin'),
  upload.single('logo'),
  restaurantController.uploadLogo
);



// ======================================================
// STAFF
// ======================================================

router.get(
  '/:id/staff',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.getStaffList
);

// ======================================================
// ADD STAFF MEMBER
// SUPER ADMIN ONLY
// Super Admin can add unlimited staff regardless of plan
// ======================================================

router.post(
  '/:id/staff',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.addStaffMember
);


// ======================================================
// RESET STAFF PASSWORD
// ======================================================

router.patch(
  '/:id/staff/:userId/reset-password',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.resetStaffPass
);

router.delete(
  '/:id/staff/:userId',
  authMiddleware,
  authorize('super_admin'),
  restaurantController.removeStaffMember
);

// ======================================================
// SAVE RESTAURANT LOCATION (GPS LOCK)
// ======================================================

router.put(
  '/:id/location',
  authMiddleware,
  authorize('manager', 'super_admin'),
  async (req, res) => {
    const { latitude, longitude, gps_radius_meters } = req.body;
    
    if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
      return res.status(400).json({
        success: false,
        message: 'Valid latitude and longitude required'
      });
    }
    
    try {
      const pool = require('../config/db');
      
      await pool.query(
        `UPDATE restaurants 
         SET latitude = $1, longitude = $2, gps_radius_meters = $3 
         WHERE id = $4`,
        [
          Number(latitude), 
          Number(longitude), 
          Number(gps_radius_meters) || 100, 
          Number(req.params.id)
        ]
      );
      
      res.json({ 
        success: true, 
        message: 'Location saved successfully' 
      });
      
    } catch (err) {
      console.error('Location save error:', err);
      res.status(500).json({ 
        success: false, 
        message: 'Server error' 
      });
    }
  }
);


module.exports = router;