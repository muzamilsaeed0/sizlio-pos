const express = require('express');
const router = express.Router();
const { login } = require('../controllers/authController');
const { authMiddleware } = require('../middleware/authMiddleware'); 

router.post('/login', login);

router.put('/settings', authMiddleware, 
  require('../controllers/authController').updateSettings);

// ✅ NEW: counter/manager apna username+password update kare
router.put('/update-account', authMiddleware, 
  require('../controllers/authController').updateAccount);

router.get('/me', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

router.get('/profile', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;