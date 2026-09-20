const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
  getCurrent,
  start,
  end,
  summary,
  list,
  getAllShiftsForManager   // ✅ NEW
} = require('../controllers/shiftController');

// ✅ Specific routes PEHLE
router.get('/all', authMiddleware, getAllShiftsForManager);   // ✅ NEW
router.get('/current', authMiddleware, getCurrent);
router.post('/start', authMiddleware, start);

// ✅ Parameterized routes BAAD MEIN
router.put('/:id/end', authMiddleware, end);
router.get('/:id/summary', authMiddleware, summary);
router.get('/', authMiddleware, list);

module.exports = router;