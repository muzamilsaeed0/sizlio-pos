const express = require('express');

const router = express.Router();

const {
  authMiddleware
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
  addCategory
);


// Edit category
router.put(
  '/:id',
  authMiddleware,
  updateCategory
);


// Remove category
router.delete(
  '/:id',
  authMiddleware,
  removeCategory
);


module.exports = router;
