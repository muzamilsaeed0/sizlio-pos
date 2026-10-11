const pool = require("../config/db");

const findUserByUsername = async (username) => {
  const result = await pool.query(
    `SELECT id, username, full_name, role, restaurant_id, is_active
     FROM users WHERE username = $1`,
    [username]
  );

  return result.rows[0];
};

const bcrypt = require('bcrypt');

const getStaffByRestaurant = async (restaurantId) => {
  const result = await pool.query(
    `SELECT id, username, full_name, role, is_active
     FROM users
     WHERE restaurant_id = $1
       AND role IN ('waiter','kitchen','counter','delivery','display')
     ORDER BY full_name`,
    [restaurantId]
  );
  return result.rows;
};

const createStaff = async (
  restaurantId,
  fullName,
  username,
  password,
  role,
  creatorRole
) => {
  const limitColumns = {
    waiter: "waiter_limit",
    kitchen: "kitchen_limit",
    counter: "counter_limit",
    display: "display_limit",
    delivery: "rider_limit",
  };
  const limitColumn = limitColumns[role];
  if (!limitColumn) {
    const error = new Error("Invalid staff role");
    error.code = "INVALID_ROLE";
    throw error;
  }

  if (typeof password !== 'string' || password.length < 4 || password.length > 8) {
    const error = new Error('Password must be between 4 and 8 characters');
    error.code = 'INVALID_PASSWORD';
    throw error;
  }

  const hashed = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialize staff creation for this restaurant so concurrent requests
    // cannot both pass the same plan-limit count.
    const restaurantResult = await client.query(
      `SELECT id, plan, ${limitColumn} AS staff_limit
       FROM restaurants
       WHERE id = $1
       FOR UPDATE`,
      [restaurantId]
    );

    if (!restaurantResult.rowCount) {
      const error = new Error('Restaurant not found');
      error.code = 'RESTAURANT_NOT_FOUND';
      throw error;
    }

    const restaurant = restaurantResult.rows[0];

    // Cafe Lite is a Counter Lite + Rider plan. Enforce this on the server,
    // including Super Admin-created staff, so a direct API call cannot add
    // waiter, kitchen, display, or manager-style staff accounts.
    if (
      restaurant.plan === 'Cafe Lite' &&
      !['counter', 'delivery'].includes(role)
    ) {
      const error = new Error(
        'Cafe Lite only supports Counter Lite and Rider staff accounts.'
      );
      error.code = 'PLAN_ROLE_NOT_ALLOWED';
      throw error;
    }

    const countResult = await client.query(
      `SELECT COUNT(*)::int AS staff_count
       FROM users
       WHERE restaurant_id = $1 AND role = $2 AND is_active = true`,
      [restaurantId, role]
    );
    const currentCount = Number(countResult.rows[0].staff_count);
    const staffLimit = restaurant.staff_limit;

    if (
      creatorRole !== 'super_admin' &&
      staffLimit !== null &&
      staffLimit !== undefined &&
      currentCount >= Number(staffLimit)
    ) {
      const error = new Error(
        `${role} limit reached. Your ${restaurant.plan || 'current'} plan allows ${staffLimit} ${role}(s).`
      );
      error.code = 'STAFF_LIMIT_REACHED';
      error.staffLimit = Number(staffLimit);
      error.currentCount = currentCount;
      throw error;
    }

    const result = await client.query(
      `INSERT INTO users
        (restaurant_id, full_name, username, password, role, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true, true)
       RETURNING id, username, full_name, role, restaurant_id, is_active`,
      [restaurantId, fullName, username, hashed, role]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const updateStaff = async (id, restaurantId, fullName, username, password) => {
  const updates = [];
  const values = [];
  let idx = 1;

  if (fullName) {
    updates.push(`full_name = $${idx++}`);
    values.push(fullName);
  }
  if (username) {
    updates.push(`username = $${idx++}`);
    values.push(username);
  }
  if (password) {
    if (typeof password !== 'string' || password.length < 4) {
      const error = new Error('Password must be at least 4 characters');
      error.code = 'INVALID_PASSWORD';
      throw error;
    }
    if (password.length > 8) {
      const error = new Error('Password is too long (maximum 8 characters)');
      error.code = 'INVALID_PASSWORD';
      throw error;
    }
    const hashed = await bcrypt.hash(password, 12);
    updates.push(`password = ${idx++}`);
    values.push(hashed);
    // Require the staff member to choose their own password after a reset.
    updates.push('must_change_password = TRUE');
    updates.push('current_session = NULL');

    
  }

  if (!updates.length) return null;

  values.push(id, restaurantId);

  const result = await pool.query(
    `UPDATE users SET ${updates.join(', ')}
     WHERE id = $${idx++} AND restaurant_id = $${idx}
       AND role IN ('waiter','kitchen','counter','delivery','display')
     RETURNING id, username, full_name, role, is_active`,
    values
  );
  return result.rows[0];
};

const setStaffActive = async (id, restaurantId, isActive) => {
  const result = await pool.query(
    `UPDATE users SET
       is_active = $1,
       current_session = CASE WHEN $1 = false THEN NULL ELSE current_session END
     WHERE id = $2 AND restaurant_id = $3
       AND role IN ('waiter','kitchen','counter','delivery','display')
     RETURNING id, username, full_name, role, is_active`,
    [isActive, id, restaurantId]
  );
  return result.rows[0];
};

module.exports = {
  findUserByUsername,
  getStaffByRestaurant,
  createStaff,
  updateStaff,
  setStaffActive
};