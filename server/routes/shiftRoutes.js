const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
  getCurrent,
  start,
  end,
  summary,
  list
} = require('../controllers/shiftController');

router.get('/current', authMiddleware, getCurrent);
router.post('/start', authMiddleware, start);
router.put('/:id/end', authMiddleware, end);
router.get('/:id/summary', authMiddleware, summary);
router.get('/', authMiddleware, list);

module.exports = router;