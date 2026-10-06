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


// Get restaurant categories
router.get(
  '/',
  authMiddleware,
  getCategories
);


// Get food-type category policy
router.get(
  '/policy',
  authMiddleware,
  getCategoryPolicy
);


// Add category
router.post(
  '/',
  authMiddleware,
  authorize('manager'),
  addCategory
);


// Edit category
router.put(
  '/:id',
  authMiddleware,
  authorize('manager'),
  updateCategory
);


// Remove category
router.delete(
  '/:id',
  authMiddleware,
  authorize('manager'),
  removeCategory
);


module.exports = router;
