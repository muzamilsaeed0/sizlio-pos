const {
  getAllMenuItems,
  createMenuItem,
  updateMenuItem,
  deactivateMenuItem,
} = require('../models/menuModel');


// Get Menu
exports.getMenu = async (req, res) => {
  try {

    const items = await getAllMenuItems(
      req.user.restaurant_id
    );

    return res.json({
      success: true,
      data: items
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });

  }
};


// Add Menu Item
exports.addMenuItem = async (req, res) => {

   if (!['manager', 'counter'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only manager or counter can add menu items'
    });
  }

  let { name, price, category, package_size, package_unit } = req.body;

  name = name?.trim();

  if (!name || price === undefined) {
    return res.status(400).json({
      success: false,
      message: 'Name and price are required'
    });
  }

  if (isNaN(price) || Number(price) <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid price'
    });
  }

  try {

   const item = await createMenuItem(
    name,
    Number(price),
    category,
    req.user.restaurant_id,
    package_size,
    package_unit
  );

    return res.status(201).json({
      success: true,
      message: 'Menu item created successfully',
      data: item
    });

  } catch (err) {

    if (err.message === 'Menu item already exists') {
      return res.status(409).json({
        success: false,
        message: err.message
      });
    }

    console.error(err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });

  }

};


// Edit Menu Item
exports.editMenuItem = async (req, res) => {

 if (!['manager', 'counter'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only manager or counter can edit menu items'
    });
  }

  let { name, price, category, package_size, package_unit } = req.body;

  name = name?.trim();

  if (!name || price === undefined) {
    return res.status(400).json({
      success: false,
      message: 'Name and price are required'
    });
  }

  if (isNaN(price) || Number(price) <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid price'
    });
  }

  try {

    const item = await updateMenuItem(
    id,
    name,
    Number(price),
    category,
    req.user.restaurant_id,
    package_size,
    package_unit
  );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Menu item not found'
      });
    }

    return res.json({
      success: true,
      message: 'Menu item updated successfully',
      data: item
    });

  } catch (err) {

    if (err.message === 'Menu item already exists') {
      return res.status(409).json({
        success: false,
        message: err.message
      });
    }

    console.error(err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });

  }

};


// Remove Menu Item
exports.removeMenuItem = async (req, res) => {

  if (!['manager', 'counter'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only manager or counter can remove menu items'
    });
  }

  const { id } = req.params;

  try {

    const item = await deactivateMenuItem(
      id,
      req.user.restaurant_id
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Menu item not found'
      });
    }

    return res.json({
      success: true,
      message: 'Menu item removed successfully',
      data: item
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });

  }

};