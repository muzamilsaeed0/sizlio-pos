const express = require('express');
const router = express.Router();
const { authMiddleware, authorize } = require('../middleware/authMiddleware');
const {
  getVariants,
  addVariant,
  editVariant,
  removeVariant
} = require('../controllers/menuVariantController');

// List / add options for a specific menu item
router.get('/item/:itemId', authMiddleware, getVariants);
router.post('/item/:itemId', authMiddleware, authorize('manager'), addVariant);

// Edit / remove a specific option
router.put('/:id', authMiddleware, authorize('manager'), editVariant);
router.delete('/:id', authMiddleware, authorize('manager'), removeVariant);

module.exports = router;
