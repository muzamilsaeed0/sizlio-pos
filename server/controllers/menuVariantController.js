const {
  getVariantsForItem,
  findMenuItemForRestaurant,
  createVariant,
  updateVariant,
  deactivateVariant
} = require('../models/menuVariantModel');

function managerOnly(req, res) {
  if (req.user.role !== 'manager') {
    res.status(403).json({
      success: false,
      message: 'Only manager can manage sizes/pieces'
    });
    return false;
  }
  return true;
}

// ======================================================
// GET VARIANTS FOR A MENU ITEM
// ======================================================
exports.getVariants = async (req, res) => {
  const itemId = Number(req.params.itemId);

  if (!Number.isInteger(itemId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid menu item id'
    });
  }

  try {
    const variants = await getVariantsForItem(
      itemId,
      req.user.restaurant_id
    );

    return res.json({
      success: true,
      data: variants
    });

  } catch (err) {
    console.error('getVariants:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ======================================================
// ADD VARIANT (e.g. Small / 250ml / 5 pcs)
// ======================================================
exports.addVariant = async (req, res) => {
  if (!managerOnly(req, res)) return;

  const itemId = Number(req.params.itemId);

  let { label, price } = req.body;

  label = String(label || '').trim();
  price = Number(price);

  if (!Number.isInteger(itemId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid menu item id'
    });
  }

  if (!label) {
    return res.status(400).json({
      success: false,
      message: 'Label is required (e.g. Small, 250ml, 5 pcs)'
    });
  }

  if (label.length > 50) {
    return res.status(400).json({
      success: false,
      message: 'Label cannot exceed 50 characters'
    });
  }

  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Price must be greater than 0'
    });
  }

  try {
    const item = await findMenuItemForRestaurant(
      itemId,
      req.user.restaurant_id
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Menu item not found'
      });
    }

    const variant = await createVariant(
      itemId,
      label,
      price
    );

    return res.status(201).json({
      success: true,
      message: 'Option added successfully',
      data: variant
    });

  } catch (err) {
    console.error('addVariant:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ======================================================
// EDIT VARIANT
// ======================================================
exports.editVariant = async (req, res) => {
  if (!managerOnly(req, res)) return;

  const id = Number(req.params.id);

  let { label, price } = req.body;

  label = String(label || '').trim();
  price = Number(price);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid option id'
    });
  }

  if (!label) {
    return res.status(400).json({
      success: false,
      message: 'Label is required (e.g. Small, 250ml, 5 pcs)'
    });
  }

  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Price must be greater than 0'
    });
  }

  try {
    const variant = await updateVariant(
      id,
      label,
      price,
      req.user.restaurant_id
    );

    if (!variant) {
      return res.status(404).json({
        success: false,
        message: 'Option not found'
      });
    }

    return res.json({
      success: true,
      message: 'Updated successfully',
      data: variant
    });

  } catch (err) {
    console.error('editVariant:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ======================================================
// REMOVE VARIANT
// ======================================================
exports.removeVariant = async (req, res) => {
  if (!managerOnly(req, res)) return;

  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid option id'
    });
  }

  try {
    const variant = await deactivateVariant(
      id,
      req.user.restaurant_id
    );

    if (!variant) {
      return res.status(404).json({
        success: false,
        message: 'Option not found'
      });
    }

    return res.json({
      success: true,
      message: 'Removed successfully'
    });

  } catch (err) {
    console.error('removeVariant:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
