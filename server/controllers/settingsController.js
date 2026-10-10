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

    // Reject malformed values instead of silently replacing them with zero.
    // Silent fallback can unexpectedly erase a restaurant's existing charges.
    const num = (field, max = null) => {
      if (body[field] === undefined) return 0;
      const raw = body[field];
      if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
        throw Object.assign(new Error('Invalid ' + field), { statusCode: 400 });
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || (max !== null && n > max)) {
        throw Object.assign(new Error('Invalid ' + field), { statusCode: 400 });
      }
      return n;
    };

    if (body.discount_type !== undefined && !['none', 'percent', 'fixed'].includes(body.discount_type)) {
      return res.status(400).json({ success: false, message: 'Invalid discount type' });
    }
    const discountType = body.discount_type === undefined ? 'none' : body.discount_type;
    const discountValue = num('discount_value', discountType === 'percent' ? 100 : null);

    const settings = {
      gst_percent:       num('gst_percent', 100),
      tax_percent:       num('tax_percent', 100),
      delivery_charge:   num('delivery_charge'),
      dine_charge:       num('dine_charge'),
      card_charge:       num('card_charge', 100),
      bank_charge:       num('bank_charge', 100),
      discount_enabled:  !!body.discount_enabled,
      discount_type:     discountType,
      discount_value:    discountValue,
      discount_reason:   String(body.discount_reason || '').slice(0, 200)
    };

    await pool.query(
      `UPDATE restaurants SET
         pos_settings = $2::jsonb,
         delivery_charge = $3,
         dine_charge = $4,
         card_charge = $5,
         bank_charge = $6
       WHERE id = $1`,
      [
        restaurantId,
        JSON.stringify(settings),
        settings.delivery_charge,
        settings.dine_charge,
        settings.card_charge,
        settings.bank_charge
      ]
    );

    return res.json({ success: true, message: 'POS settings saved', data: settings });
  } catch (err) {
    if (err?.statusCode === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
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
