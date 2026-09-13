const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');
const {
  getMenu,
  addMenuItem,
  editMenuItem,
  removeMenuItem,
} = require('../controllers/menuController');

router.get('/', authMiddleware, getMenu);
router.post('/', authMiddleware, upload.none(), addMenuItem);
router.put('/:id', authMiddleware, editMenuItem);
router.delete('/:id', authMiddleware, removeMenuItem);

module.exports = router;