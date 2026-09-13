const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
  getVariants,
  addVariant,
  editVariant,
  removeVariant
} = require('../controllers/menuVariantController');

// List / add options for a specific menu item
router.get('/item/:itemId', authMiddleware, getVariants);
router.post('/item/:itemId', authMiddleware, addVariant);

// Edit / remove a specific option
router.put('/:id', authMiddleware, editVariant);
router.delete('/:id', authMiddleware, removeVariant);

module.exports = router;
