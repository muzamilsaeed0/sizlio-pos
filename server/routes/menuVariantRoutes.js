const express = require('express');
const router = express.Router();
const { authMiddleware, authorize } = require('../middleware/authMiddleware');
const {
  getVariants,
  addVariant,
  editVariant,
  removeVariant
} = require('../controllers/menuVariantController');

router.get('/item/:itemId', authMiddleware, getVariants);
router.post('/item/:itemId', authMiddleware, authorize('manager', 'counter'), addVariant);

router.put('/:id', authMiddleware, authorize('manager', 'counter'), editVariant);
router.delete('/:id', authMiddleware, authorize('manager', 'counter'), removeVariant);

module.exports = router;
