const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const crypto = require('crypto');

exports.login = async (req, res) => {
  const { username, password, restaurant_id, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username and password are required'
    });
  }

  try {
    let query, params;

    // ==========================================
    // SUPER ADMIN – special handling
    // ==========================================
    if (role === 'super_admin' || (!role && !restaurant_id)) {
      query = `
        SELECT
          u.id, u.username, u.password, u.role, u.restaurant_id,
          u.full_name, u.is_active AS user_active,
          r.name AS restaurant_name, r.status AS restaurant_status,
          r.plan AS restaurant_plan, r.expiry_date
        FROM users u
        LEFT JOIN restaurants r ON u.restaurant_id = r.id
        WHERE u.username = $1
          AND u.role = 'super_admin'
      `;
      params = [username];
    }

    // ==========================================
    // RESTAURANT STAFF – pehle sirf username + restaurant_id
    // ==========================================
    else {
      if (!restaurant_id || !role) {
        return res.status(400).json({
          success: false,
          message: 'Restaurant and login role are required'
        });
      }

      query = `
        SELECT
          u.id, u.username, u.password, u.role, u.restaurant_id,
          u.full_name, u.is_active AS user_active,
          r.name AS restaurant_name, r.status AS restaurant_status,
          r.plan AS restaurant_plan, r.expiry_date
        FROM users u
        LEFT JOIN restaurants r ON u.restaurant_id = r.id
        WHERE u.username = $1
          AND u.restaurant_id = $2
      `;
      params = [username, restaurant_id];
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
      });
    }

    const user = result.rows[0];

    // ==========================================
    // ✅ ROLE CHECK – AB YAHAN KAREIN
    // ==========================================
    if (role && user.role !== role) {
      return res.status(403).json({
        success: false,
        message: `This login is for ${role}s only.`   // 👈 Yeh frontend pe show hoga
      });
    }

    // ==========================================
    // RESTAURANT ACTIVE CHECK
    // ==========================================
    if (user.role !== 'super_admin' && user.restaurant_status !== 'Active') {
      return res.status(403).json({
        success: false,
        message: 'Restaurant account is suspended. Contact support.'
      });
    }

    // ==========================================
    // USER ACTIVE CHECK
    // ==========================================
    if (user.user_active === false) {
      return res.status(403).json({
        success: false,
        message: 'User account is disabled. Contact support.'
      });
    }

    // ==========================================
    // SUBSCRIPTION EXPIRY
    // ==========================================
    if (user.role !== 'super_admin' && user.expiry_date && new Date(user.expiry_date) < new Date()) {
      return res.status(403).json({
        success: false,
        message: 'Restaurant subscription has expired. Please renew your plan.'
      });
    }

    // ==========================================
    // PASSWORD CHECK
    // ==========================================
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
      });
    }

    // ==========================================
    // SESSION & JWT
    // ==========================================
    const sessionId = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `UPDATE users SET current_session = $1 WHERE id = $2`,
      [sessionId, user.id]
    );

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        restaurant_id: user.restaurant_id,
        restaurant_name: user.restaurant_name,
        sessionId
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.full_name,
        role: user.role,
        restaurant_id: user.restaurant_id,
        restaurant_name: user.restaurant_name,
        plan: user.restaurant_plan,
        expiry_date: user.expiry_date
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error'
    });
  }
};

exports.updateSettings = async (req, res) => {

  try {

    const userId = req.user.id;
    const { username, current_password, new_password } = req.body;

    const result = await pool.query(
      `SELECT id, username, password FROM users WHERE id = $1`,
      [userId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = result.rows[0];

    if (!current_password) {
      return res.status(400).json({ success: false, message: 'Current password is required' });
    }

    const isMatch = await bcrypt.compare(current_password, user.password);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (username && username.trim() && username.trim() !== user.username) {
      updates.push(`username = $${idx++}`);
      values.push(username.trim());
    }

    // ✅ FIX: If new password provided, update both password (hashed) AND plain_password
    if (new_password) {
      if (new_password.length < 4) {
        return res.status(400).json({ success: false, message: 'New password must be at least 4 characters' });
      }

      const hashed = await bcrypt.hash(new_password, 10);

      // Update hashed password
      updates.push(`password = $${idx++}`);
      values.push(hashed);

      // ✅ Update plain_password (so Super Admin can see the actual password)
      updates.push(`plain_password = $${idx++}`);
      values.push(new_password);
    }

    if (!updates.length) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    values.push(userId);

    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`,
      values
    );

    return res.json({ success: true, message: 'Settings updated successfully' });

  } catch (err) {

    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Username already taken' });
    }

    console.error('updateSettings:', err);

    return res.status(500).json({ success: false, message: 'Server error' });

  }

};