const {
  getAllRestaurants,
  createRestaurant,
  updateRestaurantStatus,
  updateSubscription,
  updateFoodType,
  resetManagerPassword,
  getRestaurantDetail,
  deleteRestaurant,
  getRestaurantStaff,
  addStaffMember,
  resetStaffPassword,
  deleteStaffMember,
  updateRestaurantDetails,
  ALLOWED_FOOD_TYPES
} = require('../models/restaurantModel');

const {
  sendRestaurantCredentials
} = require('../services/emailService');

// ======================================================
// LIST RESTAURANTS
// ======================================================

exports.listRestaurants = async (req, res) => {

  try {

    const restaurants =
      await getAllRestaurants();

    res.json({
      success: true,
      data: restaurants
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Server error'
    });

  }

};


// ======================================================
// ADD RESTAURANT
// ======================================================

exports.addRestaurant = async (req, res) => {

  try {

    const {
      name,
      owner_name,
      phone,
      email,
      city,
      address,
      plan,
      expiry_date,
      manager_username,
      manager_password,
      manager_fullname,
      food_type
    } = req.body;


    // --------------------------------------------------
    // REQUIRED FIELDS
    // --------------------------------------------------

   const isCafeLite = (plan === 'Cafe Lite');

// Name always required
if (!name) {
  return res.status(400).json({ 
    success: false, 
    message: 'Restaurant name is required' 
  });
}

// Manager required for non-Cafe-Lite plans
if (!isCafeLite) {
  if (!manager_username || !manager_password) {
    return res.status(400).json({ 
      success: false, 
      message: 'Manager username & password required for this plan' 
    });
  }
} else {
  // Cafe Lite: if one provided, both required
  const hasUser = !!manager_username;
  const hasPass = !!manager_password;
  if (hasUser !== hasPass) {
    return res.status(400).json({ 
      success: false, 
      message: 'Enter both manager username and password, or leave both blank' 
    });
  }
}


    // --------------------------------------------------
    // FOOD TYPE
    // --------------------------------------------------

    const selectedFoodType = food_type || 'Fast Food';

    if (!ALLOWED_FOOD_TYPES.includes(selectedFoodType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid restaurant food type',
        allowed_food_types: ALLOWED_FOOD_TYPES
      });
    }


    // --------------------------------------------------
    // CREATE (DB ONLY — NO EMAIL YET)
    // --------------------------------------------------

    const result = await createRestaurant({
      name,
      owner_name,
      phone,
      email,
      city,
      address,
      plan,
      expiry_date,
      manager_username,
      manager_password,
      manager_fullname,
      food_type: selectedFoodType
    });


    // --------------------------------------------------
    // ✅ INSTANT RESPONSE — Button will unlock immediately
    // --------------------------------------------------

    res.status(201).json({
      success: true,
      message: 'Restaurant created',
      data: result
    });


    // --------------------------------------------------
    // ✅ EMAIL IN BACKGROUND (Non-blocking)
    // --------------------------------------------------

setImmediate(async () => {
  try {

    const hasManager = !!(manager_username && manager_password);
    const staff = result.staff || {};
    const hasStaff = Object.values(staff)
      .some(arr => Array.isArray(arr) && arr.length > 0);

    // Skip ONLY if literally nothing to email
    if (!hasManager && !hasStaff) {
      console.log(`ℹ️ No credentials to email for restaurant #${result.restaurant.id}`);
      return;
    }

    await sendRestaurantCredentials({
      restaurant: result.restaurant,

      // ✅ Manager may be null for Cafe Lite
      manager: hasManager
        ? { username: manager_username, password: manager_password }
        : null,

      staff: staff
    });

    console.log(`✅ Credential email sent to ${result.restaurant.email}`);

  } catch (emailErr) {
    console.error('⚠️ Background email failed:', emailErr.message);
  }
});


  } catch (err) {

    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Manager username already taken'
      });
    }

    console.error('addRestaurant:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });

  }

};


// ======================================================
// UPDATE RESTAURANT STATUS
// ======================================================

exports.setStatus = async (req, res) => {

  try {

    const { id } =
      req.params;

    const { status } =
      req.body;


    if (
      !['Active', 'Suspended']
        .includes(status)
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Status must be Active or Suspended'

      });

    }


    const restaurant =
      await updateRestaurantStatus(
        id,
        status
      );


    if (!restaurant) {

      return res.status(404).json({

        success: false,

        message:
          'Restaurant not found'

      });

    }


    res.json({

      success: true,

      message:
        `Restaurant ${status}`,

      data: restaurant

    });


  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: 'Server error'

    });

  }

};


// ======================================================
// UPDATE SUBSCRIPTION
// ======================================================

exports.editSubscription =
async (req, res) => {

  try {

    const { id } =
      req.params;

    const {
      plan,
      expiry_date
    } = req.body;


    const restaurant =
      await updateSubscription(
        id,
        plan,
        expiry_date
      );


    if (!restaurant) {

      return res.status(404).json({

        success: false,

        message:
          'Restaurant not found'

      });

    }


    res.json({

      success: true,

      message:
        'Subscription updated',

      data: restaurant

    });


  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: 'Server error'

    });

  }

};


// ======================================================
// UPDATE RESTAURANT DETAILS
// SUPER ADMIN ONLY
// ======================================================

exports.editRestaurant = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, owner_name, phone, email, city, address } = req.body;

    // Validate required
    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Restaurant name is required'
      });
    }

    const restaurant = await updateRestaurantDetails(id, {
      name: String(name).trim(),
      owner_name: owner_name ? String(owner_name).trim() : null,
      phone: phone ? String(phone).trim() : null,
      email: email ? String(email).trim() : null,
      city: city ? String(city).trim() : null,
      address: address ? String(address).trim() : null
    });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: 'Restaurant not found'
      });
    }

    res.json({
      success: true,
      message: 'Restaurant details updated successfully',
      data: restaurant
    });

  } catch (err) {
    console.error('editRestaurant:', err);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};


// ======================================================
// UPDATE FOOD TYPE
// SUPER ADMIN ONLY
// ======================================================

exports.editFoodType =
async (req, res) => {

  try {

    const { id } =
      req.params;

    const { food_type } =
      req.body;


    if (!food_type) {

      return res.status(400).json({

        success: false,

        message:
          'Food type is required'

      });

    }


    if (
      !ALLOWED_FOOD_TYPES
        .includes(food_type)
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Invalid restaurant food type',

        allowed_food_types:
          ALLOWED_FOOD_TYPES

      });

    }


    const restaurant =
      await updateFoodType(
        id,
        food_type
      );


    if (!restaurant) {

      return res.status(404).json({

        success: false,

        message:
          'Restaurant not found'

      });

    }


    res.json({

      success: true,

      message:
        'Restaurant food type updated',

      data: restaurant

    });


  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: 'Server error'

    });

  }

};


// ======================================================
// RESET MANAGER PASSWORD
// ======================================================

exports.resetPassword =
async (req, res) => {

  try {

    const { id } =
      req.params;

    const {
      new_password
    } = req.body;


    if (
      !new_password ||
      new_password.length < 4
    ) {

      return res.status(400).json({

        success: false,

        message:
          'New password must be at least 4 characters'

      });

    }


    const manager =
      await resetManagerPassword(
        id,
        new_password
      );


    if (!manager) {

      return res.status(404).json({

        success: false,

        message:
          'Manager for this restaurant not found'

      });

    }


    res.json({

      success: true,

      message:
        `Password updated for ${manager.username}`

    });


  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: 'Server error'

    });

  }

};


// ======================================================
// GET RESTAURANT DETAIL
// ======================================================

exports.getDetail =
async (req, res) => {

  try {

    const { id } =
      req.params;


    const restaurant =
      await getRestaurantDetail(id);


    if (!restaurant) {

      return res.status(404).json({

        success: false,

        message:
          'Restaurant not found'

      });

    }


    res.json({

      success: true,

      data: restaurant

    });


  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: 'Server error'

    });

  }

};


// ======================================================
// DELETE RESTAURANT
// ======================================================

exports.removeRestaurant =
async (req, res) => {

  try {

    const { id } =
      req.params;


    await deleteRestaurant(id);


    res.json({

      success: true,

      message:
        'Restaurant deleted'

    });


  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: 'Server error'

    });

  }

};


// ======================================================
// UPLOAD LOGO
// ======================================================

exports.uploadLogo =
async (req, res) => {

  try {

    const { id } =
      req.params;


    if (!req.file) {

      return res.status(400).json({

        success: false,

        message:
          'No file uploaded'

      });

    }


    /*
      IMPORTANT:

      upload middleware agar Cloudinary
      use kar raha hai to req.file.path
      Cloudinary URL hoga.

      Agar local disk storage hai to
      upload middleware ke hisaab se
      URL handle karna hoga.
    */

    const logoUrl =
      req.file.path;


    const pool =
      require('../config/db');


    await pool.query(
      `
      UPDATE restaurants

      SET logo_url = $1

      WHERE id = $2
      `,
      [
        logoUrl,
        id
      ]
    );


    res.json({

      success: true,

      message:
        'Logo uploaded',

      logo_url:
        logoUrl

    });


  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: 'Server error'

    });

  }

};


// ======================================================
// GET MY RESTAURANT
// MANAGER / WAITER / KITCHEN
// ======================================================

exports.getMyRestaurant =
async (req, res) => {

  try {

    const pool =
      require('../config/db');


    const result =
      await pool.query(
        `
        SELECT
          id,
          name,
          logo_url,
          plan,
          status,
          expiry_date,
          food_type

        FROM restaurants

        WHERE id = $1
        `,
        [
          req.user.restaurant_id
        ]
      );


    if (!result.rowCount) {

      return res.status(404).json({

        success: false,

        message:
          'Restaurant not found'

      });

    }


    const restaurant =
      result.rows[0];


    // --------------------------------------------------
    // CALCULATE REMAINING DAYS
    // --------------------------------------------------

    let remaining_days =
      null;


    if (restaurant.expiry_date) {

      const today =
        new Date();

      const expiry =
        new Date(
          restaurant.expiry_date
        );


      today.setHours(
        0,
        0,
        0,
        0
      );

      expiry.setHours(
        0,
        0,
        0,
        0
      );


      const difference =
        expiry.getTime() -
        today.getTime();


      remaining_days =
        Math.ceil(
          difference /
          (1000 * 60 * 60 * 24)
        );


      if (
        remaining_days < 0
      ) {

        remaining_days = 0;

      }

    }


    // --------------------------------------------------
    // RESPONSE
    // --------------------------------------------------

    res.json({

      success: true,

      data: {

        ...restaurant,

        remaining_days

      }

    });


  } catch (err) {

    console.error(
      'getMyRestaurant:',
      err
    );


    res.status(500).json({

      success: false,

      message: 'Server error'

    });

  }

};


// ======================================================
// GET STAFF
// ======================================================

exports.getStaffList =
async (req, res) => {

  try {

    const { id } =
      req.params;


    const staff =
      await getRestaurantStaff(id);


    res.json({

      success: true,

      data: staff

    });


  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: 'Server error'

    });

  }

};

// ======================================================
// ADD STAFF MEMBER
// SUPER ADMIN ONLY
//
// IMPORTANT:
// Super Admin has NO plan limit here.
// Plan limits are applied only when restaurant is created.
// ======================================================

exports.addStaffMember = async (req, res) => {

  try {

    const { id } = req.params;

    const {
      full_name,
      username,
      password,
      role
    } = req.body;


    // --------------------------------------------------
    // REQUIRED
    // --------------------------------------------------

    if (!username || !password || !role) {

      return res.status(400).json({
        success: false,
        message: 'Username, password and role are required'
      });

    }


    // --------------------------------------------------
    // ALLOWED ROLES
    // --------------------------------------------------

    const allowedRoles = [
      'waiter',
      'counter',
      'display',
      'kitchen',
      'rider'
    ];

    if (!allowedRoles.includes(role)) {

      return res.status(400).json({
        success: false,
        message:
          'Invalid role. Allowed: waiter, counter, display, kitchen, rider'
      });

    }


    // --------------------------------------------------
    // PASSWORD
    // --------------------------------------------------

    if (password.length < 4) {

      return res.status(400).json({
        success: false,
        message: 'Password must be at least 4 characters'
      });

    }


    // --------------------------------------------------
    // CREATE STAFF
    //
    // NO PLAN LIMIT FOR SUPER ADMIN
    // --------------------------------------------------

    const staff = await addStaffMember(
      id,
      {
        full_name: full_name || role,
        username: username.trim(),
        password,
        role
      }
    );


    res.status(201).json({

      success: true,

      message: `${role} account created successfully`,

      data: staff

    });


  } catch (err) {

    console.error('addStaffMember:', err);


    // PostgreSQL duplicate username
    if (err.code === '23505') {

      return res.status(409).json({

        success: false,

        message: 'Username already taken'

      });

    }


    res.status(400).json({

      success: false,

      message: err.message || 'Failed to create staff member'

    });

  }

};


// ======================================================
// RESET STAFF PASSWORD
// ======================================================

exports.resetStaffPass =
async (req, res) => {

  try {

    const {
      id,
      userId
    } = req.params;


    const {
      new_password
    } = req.body;


    if (
      !new_password ||
      new_password.length < 4
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Password must be at least 4 characters'

      });

    }


    const user =
      await resetStaffPassword(
        id,
        userId,
        new_password
      );


    if (!user) {

      return res.status(404).json({

        success: false,

        message:
          'Staff not found'

      });

    }


    res.json({

      success: true,

      message:
        `Password updated for ${user.username}`,

      new_password

    });


  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: 'Server error'

    });

  }

};

// ======================================================
// DELETE STAFF MEMBER
// ======================================================

exports.removeStaffMember = async (req, res) => {

  try {

    const { id, userId } = req.params;

    const deleted = await deleteStaffMember(id, userId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Staff member not found'
      });
    }

    res.json({
      success: true,
      message: 'Staff member deleted',
      data: deleted
    });

  } catch (err) {

    console.error(err);

    res.status(400).json({
      success: false,
      message: err.message
    });

  }

};