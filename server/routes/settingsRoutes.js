const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const settingsController = require('../controllers/settingsController');

router.use(authMiddleware);

function managerOnly(req, res, next) {
  if (!req.user || req.user.role !== 'manager') {
    return res.status(403).json({ success: false, message: 'Manager only' });
  }
  next();
}

function managerOrCounter(req, res, next) {
  if (!req.user || !['manager', 'counter'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Manager or counter only' });
  }
  next();
}

/* Counter Lite is a full single-screen POS:
   POS charge settings are editable by both manager and counter. */
router.get('/pos', managerOrCounter, settingsController.getPosSettings);
router.put('/pos', managerOrCounter, settingsController.savePosSettings);

/* RAAST QR remains manager-only configuration. */
router.get('/raast-qr', managerOrCounter, settingsController.getRaastQr);
router.put('/raast-qr', managerOnly, settingsController.saveRaastQr);

module.exports = router;