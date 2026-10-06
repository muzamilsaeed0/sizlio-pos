const express = require('express');

const router = express.Router();

const {
  authMiddleware,
  authorize
} = require('../middleware/authMiddleware');

const {
  getCategories,
  addCategory,
  updateCategory,
  removeCategory,
  getCategoryPolicy
} = require('../controllers/categoryController');

router.get('/', authMiddleware, getCategories);
router.get('/policy', authMiddleware, getCategoryPolicy);

router.post('/', authMiddleware, authorize('manager', 'counter'), addCategory);
router.put('/:id', authMiddleware, authorize('manager', 'counter'), updateCategory);
router.delete('/:id', authMiddleware, authorize('manager', 'counter'), removeCategory);

module.exports = router;
