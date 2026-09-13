const pool = require("../config/db");

const findUserByUsername = async (username) => {
  const result = await pool.query(
    "SELECT * FROM users WHERE username = $1",
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

  // ======================================================
  // ROLE -> RESTAURANT LIMIT COLUMN
  // ======================================================

  const limitColumns = {
    waiter: "waiter_limit",
    kitchen: "kitchen_limit",
    counter: "counter_limit",
    display: "display_limit",
    delivery: "rider_limit",
  };

  const limitColumn = limitColumns[role];

  if (!limitColumn) {

    const error =
      new Error("Invalid staff role");

    error.code = "INVALID_ROLE";

    throw error;
  }


  // ======================================================
  // CHECK RESTAURANT
  // ======================================================

  const restaurantResult =
    await pool.query(
      `
      SELECT
        id,
        plan,
        ${limitColumn} AS staff_limit
      FROM restaurants
      WHERE id = $1
      `,
      [restaurantId]
    );


  if (!restaurantResult.rows.length) {

    const error =
      new Error("Restaurant not found");

    error.code =
      "RESTAURANT_NOT_FOUND";

    throw error;
  }


  const restaurant =
    restaurantResult.rows[0];

  const staffLimit =
    restaurant.staff_limit;


  // ======================================================
  // COUNT CURRENT ACTIVE STAFF
  // ======================================================

  const countResult =
    await pool.query(
      `
      SELECT COUNT(*)::int AS staff_count
      FROM users
      WHERE restaurant_id = $1
        AND role = $2
        AND is_active = true
      `,
      [
        restaurantId,
        role
      ]
    );


  const currentCount =
    countResult.rows[0].staff_count;


  // ======================================================
  // PLAN LIMIT
  //
  // SUPER ADMIN:
  // NO LIMIT AT ALL
  //
  // MANAGER:
  // RESTAURANT PLAN LIMIT APPLIES
  // ======================================================

  if (creatorRole !== "super_admin") {

    if (
      staffLimit !== null &&
      staffLimit !== undefined &&
      currentCount >= Number(staffLimit)
    ) {

      const error =
        new Error(
          `${role} limit reached. Your ${restaurant.plan || "current"} plan allows ${staffLimit} ${role}(s).`
        );

      error.code =
        "STAFF_LIMIT_REACHED";

      error.staffLimit =
        Number(staffLimit);

      error.currentCount =
        currentCount;

      throw error;
    }
  }


  // ======================================================
  // HASH PASSWORD
  // ======================================================

  const hashed =
    await bcrypt.hash(
      password,
      10
    );


  // ======================================================
  // CREATE STAFF
  // ======================================================

  const result =
    await pool.query(
      `
      INSERT INTO users
      (
        restaurant_id,
        full_name,
        username,
        password,
        role,
        is_active
      )

      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        true
      )

      RETURNING
        id,
        username,
        full_name,
        role,
        restaurant_id,
        is_active
      `,
      [
        restaurantId,
        fullName,
        username,
        hashed,
        role
      ]
    );


  return result.rows[0];
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
    // ✅ Validate password length
    if (password.length < 4) {
      throw new Error('Password must be at least 4 characters');
    }
    const hashed = await bcrypt.hash(password, 10);
    updates.push(`password = $${idx++}`);
    values.push(hashed);

    
    updates.push(`plain_password = $${idx++}`);
    values.push(password);
  }

  if (!updates.length) return null;

  values.push(id, restaurantId);

  const result = await pool.query(
    `UPDATE users SET ${updates.join(', ')}
     WHERE id = $${idx++} AND restaurant_id = $${idx}
       AND role IN ('waiter','kitchen','counter','delivery','display')
     RETURNING id, username, full_name, role, is_active, plain_password AS password`,  // ✅ Return password as well
    values
  );
  return result.rows[0];
};

const setStaffActive = async (id, restaurantId, isActive) => {
  const result = await pool.query(
    `UPDATE users SET is_active = $1
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