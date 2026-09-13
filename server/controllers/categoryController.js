const {
  getCategories,
  findCategory,
  createCategory,
  reactivateCategory,
  updateCategory,
  deactivateCategory,
  categoryHasMenuItems
} = require('../models/categoryModel');

const {
  ALLOWED_FOOD_TYPES
} = require('../models/restaurantModel');

const pool = require('../config/db');

const CATEGORY_GROUPS = {
  fast: [
    'Burgers',
    'Pizza',
    'Sandwiches & Wraps',
    'Broast & Fried Chicken',
    'Fries',
    'Pasta',
    'Snacks',
    'Drinks'
        
  ],

  desi: [
    'Karahi',
    'Handi',
    'BBQ',
    'Rice',
    'Daal & Sabzi',
    'Roti',
    'Salad & Raita',
    'Dessert',
    'Drinks'
  ]
};

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function allowedCategoriesForFoodType(foodType) {
  const type = normalize(foodType);

  if (type.includes('fast') && type.includes('desi')) {
    return [
      ...new Set([
        ...CATEGORY_GROUPS.fast,
        ...CATEGORY_GROUPS.desi
      ])
    ];
  }

  if (type.includes('fast')) {
    return CATEGORY_GROUPS.fast;
  }

  if (
    type.includes('desi') ||
    type.includes('pakistani')
  ) {
    return CATEGORY_GROUPS.desi;
  }

  return [];
}

async function getRestaurantFoodType(restaurantId) {
  const result = await pool.query(
    `
    SELECT food_type
    FROM restaurants
    WHERE id = $1
    LIMIT 1
    `,
    [restaurantId]
  );

  return result.rows[0]?.food_type || 'Fast Food';
}


// ======================================================
// GET CATEGORIES
// ======================================================

exports.getCategories = async (req, res) => {
  try {
    const categories = await getCategories(
      req.user.restaurant_id
    );

    return res.json({
      success: true,
      data: categories
    });

  } catch (err) {
    console.error('getCategories:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};


// ======================================================
// ADD CATEGORY
// MANAGER ONLY
// ======================================================

exports.addCategory = async (req, res) => {
  if (req.user.role !== 'manager') {
    return res.status(403).json({
      success: false,
      message: 'Only manager can add categories'
    });
  }

  const name = String(req.body.name || '').trim();

  if (!name) {
    return res.status(400).json({
      success: false,
      message: 'Category name is required'
    });
  }

  if (name.length > 50) {
    return res.status(400).json({
      success: false,
      message: 'Category name cannot exceed 50 characters'
    });
  }

  try {
    const foodType = await getRestaurantFoodType(
      req.user.restaurant_id
    );

    const allowed = allowedCategoriesForFoodType(
      foodType
    );

    const requested = normalize(name);

    const matched = allowed.find(
      category => normalize(category) === requested
    );

    if (!matched) {
      return res.status(403).json({
        success: false,
        message:
          `Category "${name}" is not allowed for ${foodType} restaurant`,
        food_type: foodType,
        allowed_categories: allowed
      });
    }

        const existing = await findCategory(
      matched,
      req.user.restaurant_id
    );

    let category;

    if (existing) {

      if (existing.active) {
        return res.status(409).json({
          success: false,
          message: 'Category already exists'
        });
      }

      category = await reactivateCategory(
        existing.id,
        req.user.restaurant_id
      );

    } else {

      category = await createCategory(
        matched,
        req.user.restaurant_id
      );

    }

    return res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: category
    });

  } catch (err) {
    console.error('addCategory:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};


// ======================================================
// EDIT CATEGORY
// MANAGER ONLY
// ======================================================

exports.updateCategory = async (req, res) => {
  if (req.user.role !== 'manager') {
    return res.status(403).json({
      success: false,
      message: 'Only manager can edit categories'
    });
  }

  const id = Number(req.params.id);
  const name = String(req.body.name || '').trim();

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid category id'
    });
  }

  if (!name) {
    return res.status(400).json({
      success: false,
      message: 'Category name is required'
    });
  }

  try {
    const foodType = await getRestaurantFoodType(
      req.user.restaurant_id
    );

    const allowed = allowedCategoriesForFoodType(
      foodType
    );

    const requested = normalize(name);

    const matched = allowed.find(
      category => normalize(category) === requested
    );

    if (!matched) {
      return res.status(403).json({
        success: false,
        message:
          `Category "${name}" is not allowed for ${foodType} restaurant`,
        allowed_categories: allowed
      });
    }

    const existing = await findCategory(
      matched,
      req.user.restaurant_id
    );

    if (
      existing &&
      Number(existing.id) !== id &&
      existing.active
    ) {
      return res.status(409).json({
        success: false,
        message: 'Category already exists'
      });
    }

    const category = await updateCategory(
      id,
      matched,
      req.user.restaurant_id
    );

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    return res.json({
      success: true,
      message: 'Category updated successfully',
      data: category
    });

  } catch (err) {
    console.error('updateCategory:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};


// ======================================================
// REMOVE CATEGORY
// MANAGER ONLY
// ======================================================

exports.removeCategory = async (req, res) => {
  if (req.user.role !== 'manager') {
    return res.status(403).json({
      success: false,
      message: 'Only manager can remove categories'
    });
  }

  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid category id'
    });
  }

  try {
    const categories = await getCategories(
      req.user.restaurant_id
    );

    const category = categories.find(
      item => Number(item.id) === id
    );

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    const hasItems = await categoryHasMenuItems(
      category.name,
      req.user.restaurant_id
    );

    if (hasItems) {
      return res.status(409).json({
        success: false,
        message:
          'Cannot remove category while menu items are using it'
      });
    }

    const removed = await deactivateCategory(
      id,
      req.user.restaurant_id
    );

    return res.json({
      success: true,
      message: 'Category removed successfully',
      data: removed
    });

  } catch (err) {
    console.error('removeCategory:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};


// ======================================================
// GET ALLOWED CATEGORY POLICY
// ======================================================

exports.getCategoryPolicy = async (req, res) => {
  try {
    const foodType = await getRestaurantFoodType(
      req.user.restaurant_id
    );

    const allowed = allowedCategoriesForFoodType(
      foodType
    );

    return res.json({
      success: true,
      food_type: foodType,
      allowed_categories: allowed
    });

  } catch (err) {
    console.error('getCategoryPolicy:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
