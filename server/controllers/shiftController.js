const {
  getActiveShift,
  startShift,
  endShift,
  getShiftSummary,
  listShifts,
  getAllShiftsForManager   // ✅ NEW
} = require('../models/shiftModel');

// Only managers (and admins, if that role exists in your system) can
// see every staff member's shifts. Every other role — kitchen, rider,
// counter, waiter, etc. — only ever sees its own shifts.
function canViewAllShifts(role) {
  return role === 'manager' || role === 'admin';
}

// ======================================================
// GET CURRENT ACTIVE SHIFT (for logged-in user)
// ======================================================
exports.getCurrent = async (req, res) => {
  try {

    const shift = await getActiveShift(
      req.user.id,
      req.user.restaurant_id
    );

    return res.json({
      success: true,
      data: shift
    });

  } catch (err) {
    console.error('getCurrent shift:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ======================================================
// START SHIFT
// ======================================================
exports.start = async (req, res) => {
  try {

    const existing = await getActiveShift(
      req.user.id,
      req.user.restaurant_id
    );

    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active shift',
        data: existing
      });
    }

    const shift = await startShift(
      req.user.id,
      req.user.restaurant_id
    );

    return res.status(201).json({
      success: true,
      message: 'Shift started',
      data: shift
    });

  } catch (err) {
    console.error('start shift:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ======================================================
// END SHIFT
// ======================================================
exports.end = async (req, res) => {
  try {

    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid shift id'
      });
    }

    const shift = await endShift(
      id,
      req.user.id,
      req.user.restaurant_id
    );

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Active shift not found'
      });
    }

    const summary = await getShiftSummary(
      id,
      req.user.restaurant_id
    );

    return res.json({
      success: true,
      message: 'Shift ended',
      data: summary
    });

  } catch (err) {
    console.error('end shift:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ======================================================
// GET SHIFT SUMMARY
// Blocks viewing another user's shift unless the
// requester is a manager.
// ======================================================
exports.summary = async (req, res) => {
  try {

    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid shift id'
      });
    }

    const summary = await getShiftSummary(
      id,
      req.user.restaurant_id
    );

    if (!summary) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    if (
      !canViewAllShifts(req.user.role) &&
      Number(summary.user_id) !== Number(req.user.id)
    ) {
      return res.status(403).json({
        success: false,
        message: 'You can only view your own shift'
      });
    }

    return res.json({
      success: true,
      data: summary
    });

  } catch (err) {
    console.error('shift summary:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ======================================================
// LIST SHIFTS (reports — filter by date / username)
// Managers see every staff member's shifts. Every other
// role only ever sees its own — the username filter is
// ignored for non-managers since it would otherwise let
// them search into other staff's shifts.
// ======================================================
exports.list = async (req, res) => {
  try {

    const { date, username } = req.query;
    const isManager = canViewAllShifts(req.user.role);

    const filters = { date };

    if (isManager) {
      filters.username = username;
    } else {
      filters.own_user_id = req.user.id;
    }

    const shifts = await listShifts(
      req.user.restaurant_id,
      filters
    );

    return res.json({
      success: true,
      data: shifts
    });

  } catch (err) {
    console.error('list shifts:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ======================================================
// MANAGER — ALL STAFF SHIFTS
//
// Rider, Kitchen, Counter, Waiter — sab ki shift
// summaries with orders count, sales, collected.
//
// Filters (query params):
//   - date     (YYYY-MM-DD)              exact day
//   - from,to  (YYYY-MM-DD)              date range
//   - role     'delivery' | 'kitchen' | 'counter' | 'waiter'
//   - username (partial match)
// ======================================================
exports.getAllShiftsForManager = async (req, res) => {
  try {

    // Only manager / admin can access
    if (!canViewAllShifts(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Only managers can view all staff shifts'
      });
    }

    const restaurantId = Number(req.user?.restaurant_id);

    if (!Number.isInteger(restaurantId) || restaurantId <= 0) {
      return res.status(401).json({
        success: false,
        message: 'Restaurant information is missing'
      });
    }

    const { date, from, to, role, username } = req.query;

    const result = await getAllShiftsForManager(restaurantId, {
      date,
      from,
      to,
      role,
      username
    });

    return res.json({
      success: true,
      count: result.shifts.length,
      shifts: result.shifts,
      totals_by_role: result.totals_by_role
    });

  } catch (err) {
    console.error('getAllShiftsForManager:', err);

    return res.status(500).json({
      success: false,
      message: 'Could not load shifts'
    });
  }
};