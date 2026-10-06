const express = require('express');
const router = express.Router();
const { authMiddleware, authorize } = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');
const {
  getMenu,
  addMenuItem,
  editMenuItem,
  removeMenuItem,
} = require('../controllers/menuController');

router.get('/', authMiddleware, getMenu);
router.post('/', authMiddleware, authorize('manager', 'counter'), upload.none(), addMenuItem);
router.put('/:id', authMiddleware, authorize('manager', 'counter'), editMenuItem);
router.delete('/:id', authMiddleware, authorize('manager', 'counter'), removeMenuItem);

module.exports = router;