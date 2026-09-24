const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const settingsController = require('../controllers/settingsController');

// All settings routes require login
router.use(authMiddleware);

/* -------- Manager-only guard -------- */
function managerOnly(req, res, next) {
  if (!req.user || req.user.role !== 'manager') {
    return res.status(403).json({ success: false, message: 'Manager only' });
  }
  next();
}

/* =====================================================
   POS SETTINGS
   - GET  : both counter + manager (counter needs to read)
   - PUT  : manager only
===================================================== */
router.get('/pos', settingsController.getPosSettings);
router.put('/pos', managerOnly, settingsController.savePosSettings);

/* =====================================================
   RAAST QR
   - GET  : both counter + manager
   - PUT  : manager only
===================================================== */
router.get('/raast-qr', settingsController.getRaastQr);
router.put('/raast-qr', managerOnly, settingsController.saveRaastQr);

module.exports = router;