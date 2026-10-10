const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const authMiddleware = async (req, res, next) => {

  try {

    const authHeader = req.headers.authorization;
    const bearerToken =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : null;
    const cookieHeader = req.headers.cookie || '';
    const cookieToken = cookieHeader
      .split(';')
      .map(part => part.trim())
      .filter(part => part.startsWith('sizlio_session='))
      .map(part => decodeURIComponent(part.slice('sizlio_session='.length)))[0] || null;

    // Cookie-authenticated state-changing requests must originate from our
    // own web origin. Bearer clients remain supported during migration.
    const token = cookieToken || bearerToken;
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    if (cookieToken && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const allowedOrigins = new Set([
        'https://sizlio.com',
        'https://www.sizlio.com',
        ...(process.env.NODE_ENV === 'development'
          ? ['http://localhost:3000', 'http://localhost:5500']
          : [])
      ]);
      const origin = req.get('origin');
      if (!origin || !allowedOrigins.has(origin)) {
        return res.status(403).json({
          success: false,
          message: 'Request origin rejected'
        });
      }
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    if (!decoded.id || !decoded.sessionId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session token'
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
  COALESCE((to_jsonb(u)->>'must_change_password')::boolean, FALSE) AS must_change_password,
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
    if (!user.current_session || user.current_session !== decoded.sessionId) {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again.'
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
      restaurant_id: user.restaurant_id,
      must_change_password: Boolean(user.must_change_password)
    };
    req.authSessionId = decoded.sessionId;

    if (user.must_change_password) {
      const requestPath = String(req.originalUrl || '').split('?')[0];
      const allowedDuringPasswordChange =
        (req.method === 'POST' && requestPath === '/api/auth/first-password') ||
        (req.method === 'POST' && requestPath === '/api/auth/logout');
      if (!allowedDuringPasswordChange) {
        return res.status(403).json({
          success: false,
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'Please change your initial password before using Sizlio POS.'
        });
      }
    }

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

    // Defense in depth: authorization must fail closed even if a route
    // accidentally omits authMiddleware or req.user is malformed.
    if (!req.user || typeof req.user.role !== 'string' || !roles.includes(req.user.role)) {

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