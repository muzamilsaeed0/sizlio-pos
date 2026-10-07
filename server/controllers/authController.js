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

    // Authentication must not reveal account role before the password
    // has been verified. The requested role is therefore validated only
    // after a successful password check.
    //
    // Super Admin login is identified by the absence of a restaurant
    // context (or an explicit super_admin role request). The user is
    // looked up by username only so a wrong requested role cannot reveal
    // whether that username belongs to a particular role.
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
      `;
      params = [username];
    }

    // Restaurant staff lookup remains tenant-scoped, but the requested
    // role is deliberately excluded from the SQL predicate.
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

    // Verify the password before checking role, account state, or
    // subscription state. This prevents role/account enumeration.
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
      });
    }

    // Requested role is checked only after successful authentication.
    // Keep the response generic so a valid username/password cannot be
    // used to probe which role is assigned to the account.
    if (role && user.role !== role) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
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
    // SESSION & JWT + LOGIN TRACKING
    // ==========================================
    const sessionId = crypto.randomBytes(16).toString('hex');

    // Client IP (proxy-aware)
    const clientIp =
      (req.headers['x-forwarded-for']?.split(',')[0].trim()) ||
      req.headers['x-real-ip'] ||
      req.connection?.remoteAddress ||
      req.ip ||
      'Unknown';

    // Device info (browser/OS)
    const userAgent = req.headers['user-agent'] || 'Unknown';

    // Session + login tracking in one query.
    await pool.query(
      `UPDATE users
       SET current_session = $1,
           last_login_at = NOW(),
           last_login_ip = $2,
           last_login_device = $3
       WHERE id = $4`,
      [sessionId, clientIp, userAgent, user.id]
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
    if (new_password) {
      if (new_password.length < 4) {
        return res.status(400).json({ success: false, message: 'New password must be at least 4 characters' });
      }

      const hashed = await bcrypt.hash(new_password, 10);
      updates.push(`password = $${idx++}`);
      values.push(hashed);
      // Password changes invalidate the current JWT immediately.
      updates.push('current_session = NULL');

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

exports.logout = async (req, res) => {
  try {
    await pool.query(
      `UPDATE users
       SET current_session = NULL
       WHERE id = $1
         AND current_session = $2`,
      [req.user.id, req.authSessionId]
    );

    return res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
