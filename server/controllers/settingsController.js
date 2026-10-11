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

    // Merge partial updates with the saved settings. Treating an omitted
    // field as zero can silently erase a restaurant's configured charges.
    const existingResult = await pool.query(
      `SELECT pos_settings, delivery_charge, dine_charge, card_charge, bank_charge
       FROM restaurants WHERE id = $1`,
      [restaurantId]
    );
    if (!existingResult.rowCount) {
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }
    const stored = existingResult.rows[0];
    const currentSettings = {
      ...DEFAULT_POS_SETTINGS,
      ...(stored.pos_settings || {}),
      delivery_charge: stored.pos_settings?.delivery_charge ?? stored.delivery_charge ?? 0,
      dine_charge: stored.pos_settings?.dine_charge ?? stored.dine_charge ?? 0,
      card_charge: stored.pos_settings?.card_charge ?? stored.card_charge ?? 0,
      bank_charge: stored.pos_settings?.bank_charge ?? stored.bank_charge ?? 0
    };

    const num = (field, max = null) => {
      if (body[field] === undefined) {
        const existing = Number(currentSettings[field] ?? DEFAULT_POS_SETTINGS[field] ?? 0);
        if (!Number.isFinite(existing) || existing < 0 || (max !== null && existing > max)) {
          throw Object.assign(new Error('Stored ' + field + ' is invalid; provide a valid value to repair it'), { statusCode: 400 });
        }
        return existing;
      }
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
    const discountType = body.discount_type === undefined
      ? (currentSettings.discount_type || 'none')
      : body.discount_type;
    const discountValue = num('discount_value', discountType === 'percent' ? 100 : null);

    let discountEnabled = Boolean(currentSettings.discount_enabled);
    if (body.discount_enabled !== undefined) {
      if (typeof body.discount_enabled === 'boolean') {
        discountEnabled = body.discount_enabled;
      } else if (body.discount_enabled === 'true' || body.discount_enabled === 'false') {
        discountEnabled = body.discount_enabled === 'true';
      } else {
        return res.status(400).json({ success: false, message: 'Invalid discount_enabled' });
      }
    }

    const settings = {
      gst_percent:       num('gst_percent', 100),
      tax_percent:       num('tax_percent', 100),
      delivery_charge:   num('delivery_charge'),
      dine_charge:       num('dine_charge'),
      card_charge:       num('card_charge', 100),
      bank_charge:       num('bank_charge', 100),
      discount_enabled:  discountEnabled,
      discount_type:     discountType,
      discount_value:    discountValue,
      discount_reason:   body.discount_reason === undefined
        ? String(currentSettings.discount_reason || '').slice(0, 200)
        : String(body.discount_reason || '').slice(0, 200)
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
