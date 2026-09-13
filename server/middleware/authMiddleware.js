const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const authMiddleware = async (req, res, next) => {

  try {

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    if (!decoded.id) {
  return res.status(401).json({
    success: false,
    message: 'Invalid token'
  });
}

    const result = await pool.query(
      `
     SELECT
  u.id,
  u.role,
  u.restaurant_id,
  u.is_active,
  u.current_session,
  r.name AS restaurant_name,
  r.status,
  r.expiry_date
FROM users u
LEFT JOIN restaurants r
  ON r.id = u.restaurant_id
WHERE u.id = $1
      `,
      [decoded.id]
    );

    if (!result.rowCount) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: 'User account disabled'
      });
    }
    if (decoded.sessionId && user.current_session !== decoded.sessionId) {
  return res.status(401).json({
    success: false,
    message: 'You have been logged out because your account was used on another device.'
  });
}

    if (user.role !== 'super_admin' && user.status !== 'Active') {
      return res.status(403).json({
        success: false,
        message: 'Restaurant suspended'
      });
    }

    if (
  user.role !== 'super_admin' &&
  user.expiry_date &&
  new Date(user.expiry_date) < new Date()
) {
      return res.status(403).json({
        success: false,
        message: 'Restaurant subscription expired'
      });
    }

    req.user = {
      id: user.id,
      role: user.role,
      restaurant_id: user.restaurant_id
    };

    next();

  } catch (err) {

    console.error('Auth middleware:', err.message);

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });

  }

};

const authorize = (...roles) => {

  return (req, res, next) => {

    if (!roles.includes(req.user.role)) {

      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });

    }

    next();

  };

};

module.exports = {
  authMiddleware,
  authorize
};