const {
  getAllDeals,
  getDealById,
  createDeal,
  updateDeal,
  deactivateDeal
} = require('../models/dealModel');

const pool = require('../config/db');

function managerOnly(req, res) {
  if (req.user.role !== 'manager') {
    res.status(403).json({
      success: false,
      message: 'Only manager can manage deals'
    });
    return false;
  }

  return true;
}

function parseItems(value) {
  let items = value;

  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(items) || !items.length) {
    return null;
  }

  const normalized = items.map(item => ({
    menu_item_id: Number(item.menu_item_id),
    variant_id:
      item.variant_id === undefined ||
      item.variant_id === null ||
      item.variant_id === ''
        ? null
        : Number(item.variant_id),
    quantity: Number(item.quantity)
  }));

  if (
    normalized.some(
      item =>
        !Number.isInteger(item.menu_item_id) ||
        item.menu_item_id <= 0 ||
        (item.variant_id !== null &&
          (!Number.isInteger(item.variant_id) || item.variant_id <= 0)) ||
        !Number.isInteger(item.quantity) ||
        item.quantity <= 0
    )
  ) {
    return null;
  }

  const keys = normalized.map(
    item => item.menu_item_id + ':' + (item.variant_id || 0)
  );

  if (new Set(keys).size !== keys.length) {
    return null;
  }

  return normalized;
}

// ======================================================
// GET ALL DEALS
// ======================================================

exports.getDeals = async (req, res) => {
  try {
    const deals = await getAllDeals(
      req.user.restaurant_id
    );

    return res.json({
      success: true,
      data: deals
    });

  } catch (err) {
    console.error('getDeals:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};


// ======================================================
// GET DEAL
// ======================================================

exports.getDeal = async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid deal id'
    });
  }

  try {
    const deal = await getDealById(
      id,
      req.user.restaurant_id
    );

    if (!deal) {
      return res.status(404).json({
        success: false,
        message: 'Deal not found'
      });
    }

    return res.json({
      success: true,
      data: deal
    });

  } catch (err) {
    console.error('getDeal:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};


// ======================================================
// CREATE DEAL
// ======================================================

exports.createDeal = async (req, res) => {
  if (!managerOnly(req, res)) return;

  let {
    name,
    price,
    type,
    category,
    image,
    items
  } = req.body;

  name = String(name || '').trim();

  price = Number(price);

  items = parseItems(items);

  if (!name) {
    return res.status(400).json({
      success: false,
      message: 'Deal name is required'
    });
  }

  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Deal price must be greater than 0'
    });
  }

  if (!items) {
    return res.status(400).json({
      success: false,
      message: 'At least one valid deal item is required'
    });
  }

  type = type || 'deal';

  if (!['deal', 'combo'].includes(type)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid deal type'
    });
  }

  try {
        const ids = [...new Set(items.map(item => item.menu_item_id))];

    const menuResult = await pool.query(
      `
      SELECT id
      FROM menu_items
      WHERE restaurant_id = $1
        AND active = true
        AND id = ANY($2::int[])
      `,
      [
        req.user.restaurant_id,
        ids
      ]
    );

    if (menuResult.rowCount !== ids.length) {
      return res.status(400).json({
        success: false,
        message:
          'One or more selected menu items are invalid'
      });
    }

    const variantIds = [
      ...new Set(
        items
          .map(item => item.variant_id)
          .filter(id => id !== null)
      )
    ];

    if (variantIds.length) {
      const variantResult = await pool.query(
        `
        SELECT miv.id, miv.menu_item_id
        FROM menu_item_variants miv
        JOIN menu_items mi ON mi.id = miv.menu_item_id
        WHERE mi.restaurant_id = $1
          AND miv.active = true
          AND miv.id = ANY($2::int[])
        `,
        [
          req.user.restaurant_id,
          variantIds
        ]
      );

      const variantMap = new Map(
        variantResult.rows.map(row => [row.id, row.menu_item_id])
      );

      const variantsValid = items.every(
        item =>
          item.variant_id === null ||
          variantMap.get(item.variant_id) === item.menu_item_id
      );

      if (
        variantMap.size !== variantIds.length ||
        !variantsValid
      ) {
        return res.status(400).json({
          success: false,
          message:
            'One or more selected size/pieces options are invalid'
        });
      }
    }

    const deal = await createDeal(
      name,
      price,
      type,
      category,
      image,
      req.user.restaurant_id,
      items
    );

    return res.status(201).json({
      success: true,
      message: 'Deal created successfully',
      data: deal
    });

  } catch (err) {
    console.error('createDeal:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};


// ======================================================
// UPDATE DEAL
// ======================================================

exports.updateDeal = async (req, res) => {
  if (!managerOnly(req, res)) return;

  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid deal id'
    });
  }

  let {
    name,
    price,
    type,
    category,
    image,
    items
  } = req.body;

  name = String(name || '').trim();

  price = Number(price);

  items = parseItems(items);

  if (!name) {
    return res.status(400).json({
      success: false,
      message: 'Deal name is required'
    });
  }

  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Deal price must be greater than 0'
    });
  }

  if (!items) {
    return res.status(400).json({
      success: false,
      message: 'At least one valid deal item is required'
    });
  }

  type = type || 'deal';

  if (!['deal', 'combo'].includes(type)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid deal type'
    });
  }

  try {
        const ids = [...new Set(items.map(item => item.menu_item_id))];

    const menuResult = await pool.query(
      `
      SELECT id
      FROM menu_items
      WHERE restaurant_id = $1
        AND active = true
        AND id = ANY($2::int[])
      `,
      [
        req.user.restaurant_id,
        ids
      ]
    );

    if (menuResult.rowCount !== ids.length) {
      return res.status(400).json({
        success: false,
        message:
          'One or more selected menu items are invalid'
      });
    }

    const variantIds = [
      ...new Set(
        items
          .map(item => item.variant_id)
          .filter(id => id !== null)
      )
    ];

    if (variantIds.length) {
      const variantResult = await pool.query(
        `
        SELECT miv.id, miv.menu_item_id
        FROM menu_item_variants miv
        JOIN menu_items mi ON mi.id = miv.menu_item_id
        WHERE mi.restaurant_id = $1
          AND miv.active = true
          AND miv.id = ANY($2::int[])
        `,
        [
          req.user.restaurant_id,
          variantIds
        ]
      );

      const variantMap = new Map(
        variantResult.rows.map(row => [row.id, row.menu_item_id])
      );

      const variantsValid = items.every(
        item =>
          item.variant_id === null ||
          variantMap.get(item.variant_id) === item.menu_item_id
      );

      if (
        variantMap.size !== variantIds.length ||
        !variantsValid
      ) {
        return res.status(400).json({
          success: false,
          message:
            'One or more selected size/pieces options are invalid'
        });
      }
    }

    const deal = await updateDeal(
      id,
      name,
      price,
      type,
      category,
      image,
      req.user.restaurant_id,
      items
    );

    if (!deal) {
      return res.status(404).json({
        success: false,
        message: 'Deal not found'
      });
    }

    return res.json({
      success: true,
      message: 'Deal updated successfully',
      data: deal
    });

  } catch (err) {
    console.error('updateDeal:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};


// ======================================================
// DELETE / DEACTIVATE DEAL
// ======================================================

exports.removeDeal = async (req, res) => {
  if (!managerOnly(req, res)) return;

  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid deal id'
    });
  }

  try {
    const deal = await deactivateDeal(
      id,
      req.user.restaurant_id
    );

    if (!deal) {
      return res.status(404).json({
        success: false,
        message: 'Deal not found'
      });
    }

    return res.json({
      success: true,
      message: 'Deal removed successfully',
      data: deal
    });

  } catch (err) {
    console.error('removeDeal:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
