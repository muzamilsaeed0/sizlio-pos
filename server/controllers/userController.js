const {
  getStaffByRestaurant,
  createStaff,
  updateStaff,
  setStaffActive,
} = require('../models/userModel');

exports.getStaff = async (req, res) => {
  try {
    const staff = await getStaffByRestaurant(req.user.restaurant_id);
    res.json({ success: true, data: staff });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.addStaff = async (req, res) => {
  try {
    const { full_name, username, password, role } = req.body;

    if (!full_name || !username || !password || !role) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (!['waiter', 'kitchen', 'counter', 'delivery','display'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid staff role' });
    }

    const staff = await createStaff(req.user.restaurant_id, full_name, username, password, role, req.user.role);
    res.status(201).json({ success: true, message: 'Staff account created', data: staff });

    } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Username already taken'
      });
    }

    if (err.code === 'STAFF_LIMIT_REACHED') {
      return res.status(403).json({
        success: false,
        message: err.message,
        limit: err.staffLimit,
        current: err.currentCount
      });
    }

    if (err.code === 'RESTAURANT_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: 'Restaurant not found'
      });
    }
  };

    console.error(err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }

exports.editStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, username, password } = req.body;

    // ✅ Add validation
    if (password && password.length < 4) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 4 characters'
      });
    }

    const staff = await updateStaff(id, req.user.restaurant_id, full_name, username, password);

    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff not found or nothing to update' });
    }

    res.json({ success: true, message: 'Staff account updated', data: staff });

  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Username already taken' });
    }
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.deactivateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await setStaffActive(id, req.user.restaurant_id, false);
    if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });
    res.json({ success: true, message: 'Staff deactivated', data: staff });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.activateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await setStaffActive(id, req.user.restaurant_id, true);
    if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });
    res.json({ success: true, message: 'Staff activated', data: staff });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};