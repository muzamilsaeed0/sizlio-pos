const pool = require('../config/db');

/* =====================================================
   POS SETTINGS (per restaurant)
===================================================== */

const DEFAULT_POS_SETTINGS = {
  gst_percent: 0,
  tax_percent: 0,
  delivery_charge: 0,
  dine_charge: 0,
  card_charge: 0,
  bank_charge: 0,
  discount_enabled: false,
  discount_type: 'none',
  discount_value: 0,
  discount_reason: ''
};

/** GET /api/settings/pos */
exports.getPosSettings = async (req, res) => {
  try {
    const restaurantId = Number(req.user?.restaurant_id);
    if (!Number.isInteger(restaurantId) || restaurantId <= 0) {
      return res.status(401).json({ success: false, message: 'Restaurant info missing' });
    }

    const { rows } = await pool.query(
      `SELECT pos_settings FROM restaurants WHERE id = $1`,
      [restaurantId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }

    // Merge with defaults
    const settings = { ...DEFAULT_POS_SETTINGS, ...(rows[0].pos_settings || {}) };

    return res.json({ success: true, data: settings });
  } catch (err) {
    console.error('getPosSettings:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/** PUT /api/settings/pos */
exports.savePosSettings = async (req, res) => {
  try {
    const restaurantId = Number(req.user?.restaurant_id);
    if (!Number.isInteger(restaurantId) || restaurantId <= 0) {
      return res.status(401).json({ success: false, message: 'Restaurant info missing' });
    }

    const body = req.body || {};

    // Validate + normalize
    const num = (v, def = 0) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : def;
    };

    const discountType = ['none', 'percent', 'fixed'].includes(body.discount_type)
      ? body.discount_type
      : 'none';

    const discountValue = num(body.discount_value, 0);

    if (discountType === 'percent' && discountValue > 100) {
      return res.status(400).json({ success: false, message: 'Discount % cannot exceed 100' });
    }

    const settings = {
      gst_percent:       num(body.gst_percent, 0),
      tax_percent:       num(body.tax_percent, 0),
      delivery_charge:   num(body.delivery_charge, 0),
      dine_charge:       num(body.dine_charge, 0),
      card_charge:       num(body.card_charge, 0),
      bank_charge:       num(body.bank_charge, 0),
      discount_enabled:  !!body.discount_enabled,
      discount_type:     discountType,
      discount_value:    discountValue,
      discount_reason:   String(body.discount_reason || '').slice(0, 200)
    };

    await pool.query(
      `UPDATE restaurants SET pos_settings = $2::jsonb WHERE id = $1`,
      [restaurantId, JSON.stringify(settings)]
    );

    return res.json({ success: true, message: 'POS settings saved', data: settings });
  } catch (err) {
    console.error('savePosSettings:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/* =====================================================
   RAAST QR (existing)
===================================================== */

/** GET /api/settings/raast-qr */
exports.getRaastQr = async (req, res) => {
  try {
    const restaurantId = Number(req.user?.restaurant_id);
    const { rows } = await pool.query(
      `SELECT raast_qr_string FROM restaurants WHERE id = $1`,
      [restaurantId]
    );
    return res.json({ success: true, data: rows[0] || { raast_qr_string: '' } });
  } catch (err) {
    console.error('getRaastQr:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/** PUT /api/settings/raast-qr */
exports.saveRaastQr = async (req, res) => {
  try {
    const restaurantId = Number(req.user?.restaurant_id);
    const qr = String(req.body?.raast_qr_string || '').trim();
    await pool.query(
      `UPDATE restaurants SET raast_qr_string = $2 WHERE id = $1`,
      [restaurantId, qr]
    );
    return res.json({ success: true, message: 'Raast QR saved' });
  } catch (err) {
    console.error('saveRaastQr:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

