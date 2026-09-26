const pool = require("../config/db");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

 require("../services/emailService");

// ======================================================
// ALLOWED RESTAURANT FOOD TYPES
// ======================================================

const ALLOWED_FOOD_TYPES = [
  "Fast Food",
  "Desi / Pakistani",
  "Fast Food + Desi",
  "Other / Custom"
];

// ======================================================
// PLAN LIMITS
//
// These limits are used ONLY when creating a restaurant.
//
// IMPORTANT:
// Super Admin "Add Member" is NOT restricted by these
// limits. Super Admin can add unlimited staff later.
// ======================================================

const PLAN_LIMITS = {

  Basic: {
    waiter: 2,
    counter: 1,
    display: 1,
    manager: 1,
    kitchen: 1,
    rider: 2
  },

  Standard: {
    waiter: 3,
    counter: 1,
    display: 1,
    manager: 1,
    kitchen: 1,
    rider: 3
  },

  Premium: {
    waiter: 4,
    counter: 2,
    display: 2,
    manager: 1,
    kitchen: 2,
    rider: 4
  },

   'Cafe Lite': {
    waiter: 0,
    counter: 1,
    display: 0,
    manager: 0,
    kitchen: 0,
    rider: 2
  }

};

// ======================================================
// GET ALL RESTAURANTS
// ======================================================

const getAllRestaurants = async () => {

  const result = await pool.query(`
    SELECT
      r.id,
      r.name,
      r.owner_name,
      r.phone,
      r.email,
      r.city,
      r.plan,
      r.status,
      r.expiry_date,
      r.created_at,
      r.food_type,

      COUNT(*) FILTER (
        WHERE u.role = 'waiter'
      ) AS waiter_count,

      COUNT(*) FILTER (
        WHERE u.role = 'kitchen'
      ) AS kitchen_count,

      COUNT(*) FILTER (
        WHERE u.role = 'counter'
      ) AS counter_count,
      COUNT(*) FILTER (
        WHERE u.role = 'display'
      ) AS display_count,
      COUNT(*) FILTER (
        WHERE u.role IN ('rider', 'delivery_rider','delivery')
      ) AS delivery_rider_count

    FROM restaurants r

    LEFT JOIN users u
      ON u.restaurant_id = r.id

    GROUP BY r.id

    ORDER BY r.created_at DESC
  `);

  return result.rows;
};

// ======================================================
// GENERATE PASSWORD
// ======================================================

function generatePassword() {

  return crypto
    .randomBytes(4)
    .toString("hex");

}

// ======================================================
// SLUGIFY RESTAURANT NAME
// ======================================================

function slugify(name) {

  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 15);

}

// ======================================================
// CREATE RESTAURANT
// ======================================================

const createRestaurant = async (data) => {

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const {
      name,
      owner_name,
      phone,
      email,
      city,
      address,
      plan,
      expiry_date,

      

      manager_username,
      manager_password,
      manager_fullname,

      food_type
    } = data;

    const selectedPlan = plan || "Basic";

if (!PLAN_LIMITS[selectedPlan]) {

  throw new Error(
    "Invalid restaurant plan. Allowed plans: Basic, Standard, Premium, Cafe Lite."
  );

}

    // --------------------------------------------------
    // FOOD TYPE
    // --------------------------------------------------

    const selectedFoodType =
      food_type || "Fast Food";

    if (
      !ALLOWED_FOOD_TYPES.includes(
        selectedFoodType
      )
    ) {

      throw new Error(
        "Invalid restaurant food type."
      );

    }

    // --------------------------------------------------
    // CREATE RESTAURANT
    // --------------------------------------------------

    const restResult =
      await client.query(
        `
        INSERT INTO restaurants
        (
          name,
          owner_name,
          phone,
          email,
          city,
          address,
          plan,
          expiry_date,

          manager_username,
          manager_password,

          waiter_username,
          waiter_password,

          kitchen_username,
          kitchen_password,

          food_type
        )

        VALUES
        (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,
          $11,$12,
          $13,$14,
          $15
        )

        RETURNING *
        `,
        [
          name,
          owner_name,
          phone,
          email,
          city,
          address,

          selectedPlan,
          expiry_date,

          manager_username || null,
          manager_password || null,

          null,
          null,

          null,
          null,

          selectedFoodType
        ]
      );

    const restaurant =
      restResult.rows[0];

    // --------------------------------------------------
    // RESTAURANT SLUG
    // --------------------------------------------------

    const slug =
      slugify(name) + restaurant.id; // include id so two similarly-named restaurants never collide

    // --------------------------------------------------
    // MANAGER
    // --------------------------------------------------

    // --------------------------------------------------
// MANAGER (optional for Cafe Lite)
// --------------------------------------------------

let managerCreated = null;

if (manager_username && manager_password) {

  const hashedPassword = await bcrypt.hash(manager_password, 10);

  const mgrResult = await client.query(
    `INSERT INTO users (full_name, username, password, plain_password, role, restaurant_id, is_active)
     VALUES ($1, $2, $3, $4, 'manager', $5, true)
     RETURNING id, username, full_name, role`,
    [
      manager_fullname || manager_username,
      manager_username,
      hashedPassword,
      manager_password,
      restaurant.id
    ]
  );

  managerCreated = mgrResult.rows[0];

} else {

  console.log(`ℹ️ Cafe Lite: no manager created for restaurant #${restaurant.id}`);

}

// ======================================================
// AUTO CREATE STAFF ACCORDING TO PLAN
// ======================================================

const planLimits = PLAN_LIMITS[selectedPlan];

const generatedStaff = {
  waiter: [],
  kitchen: [],
  counter: [],
  display: [],
  delivery: []
};


// ======================================================
// HELPER: CREATE STAFF USER
// ======================================================

const createStaffUser = async (
  role,
  fullName,
  username,
  password
) => {

  const hashed =
    await bcrypt.hash(password, 10);

  await client.query(
    `
    INSERT INTO users
    (
      full_name,
      username,
      password,
      plain_password,
      role,
      restaurant_id
    )

    VALUES
    (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6
    )
    `,
    [
      fullName,
      username,
      hashed,
      password,
      role,
      restaurant.id
    ]
  );

  generatedStaff[role].push({
    username,
    password
  });

};


// ======================================================
// WAITER
// ======================================================

for (
  let i = 1;
  i <= planLimits.waiter;
  i++
) {

  const username =
    `${slug}_waiter${i}`;

  const password =
    generatePassword();

  await createStaffUser(
    'waiter',
    `Waiter ${i}`,
    username,
    password
  );

}


// ======================================================
// KITCHEN
// ======================================================

for (
  let i = 1;
  i <= planLimits.kitchen;
  i++
) {

  const username =
    `${slug}_kitchen${i}`;

  const password =
    generatePassword();

  await createStaffUser(
    'kitchen',
    `Kitchen ${i}`,
    username,
    password
  );

}


// ======================================================
// COUNTER
// ======================================================

for (
  let i = 1;
  i <= planLimits.counter;
  i++
) {

  const username =
    `${slug}_counter${i}`;

  const password =
    generatePassword();

  await createStaffUser(
    'counter',
    `Counter ${i}`,
    username,
    password
  );

}


// ======================================================
// DISPLAY
// ======================================================

for (
  let i = 1;
  i <= planLimits.display;
  i++
) {

  const username =
    `${slug}_display${i}`;

  const password =
    generatePassword();

  await createStaffUser(
    'display',
    `Display ${i}`,
    username,
    password
  );

}


// ======================================================
// RIDER
// ======================================================

for (
  let i = 1;
  i <= planLimits.rider;
  i++
) {

  const username =
    `${slug}_rider${i}`;

  const password =
    generatePassword();

  await createStaffUser(
    'delivery',
    `Rider ${i}`,
    username,
    password
  );

}

    

    await client.query("COMMIT");



// --------------------------------------------------
// RETURN
// --------------------------------------------------

return {

  restaurant: {
    ...restaurant,

    food_type: selectedFoodType,

    plan: selectedPlan
  },

  manager:
    managerCreated,

  staff:
    generatedStaff

};

  } catch (err) {

    await client.query(
      "ROLLBACK"
    );

    throw err;

  } finally {

    client.release();

  }

};

// ======================================================
// UPDATE RESTAURANT STATUS
// ======================================================

const updateRestaurantStatus =
async (id, status) => {

  const result =
    await pool.query(
      `
      UPDATE restaurants

      SET status = $1

      WHERE id = $2

      RETURNING *
      `,
      [
        status,
        id
      ]
    );

  return result.rows[0];

};

// ======================================================
// UPDATE SUBSCRIPTION
// ======================================================

const updateSubscription =
async (
  id,
  plan,
  expiry_date
) => {

  const result =
    await pool.query(
      `
      UPDATE restaurants

      SET
        plan = $1,
        expiry_date = $2

      WHERE id = $3

      RETURNING *
      `,
      [
        plan,
        expiry_date,
        id
      ]
    );

  return result.rows[0];

};

// ======================================================
// UPDATE FOOD TYPE
// SUPER ADMIN ONLY
// ======================================================

const updateFoodType =
async (
  id,
  food_type
) => {

  if (
    !ALLOWED_FOOD_TYPES.includes(
      food_type
    )
  ) {

    throw new Error(
      "Invalid restaurant food type."
    );

  }

  const result =
    await pool.query(
      `
      UPDATE restaurants

      SET food_type = $1

      WHERE id = $2

      RETURNING *
      `,
      [
        food_type,
        id
      ]
    );

  return result.rows[0];

};

// ======================================================
// RESET MANAGER PASSWORD
// (now just writes users.password + users.plain_password —
//  no restaurants-table syncing needed, so the old "stale
//  password after reset" bug can't happen anymore)
// ======================================================

const resetManagerPassword =
async (
  restaurantId,
  newPassword
) => {

  const hashed =
    await bcrypt.hash(
      newPassword,
      10
    );

  const result =
    await pool.query(
      `
      UPDATE users

      SET
        password = $1,
        plain_password = $2

      WHERE restaurant_id = $3
        AND role = 'manager'

      RETURNING
        id,
        username,
        full_name
      `,
      [
        hashed,
        newPassword,
        restaurantId
      ]
    );

  return result.rows[0];

};

// ======================================================
// GET RESTAURANT DETAIL
// ======================================================

const getRestaurantDetail =
async (id) => {

  const result =
    await pool.query(
      `
      SELECT
        r.*,

        COUNT(*) FILTER (
          WHERE u.role = 'waiter'
        ) AS waiter_count,

        COUNT(*) FILTER (
          WHERE u.role = 'kitchen'
        ) AS kitchen_count,

        COUNT(*) FILTER (
          WHERE u.role = 'counter'
        ) AS counter_count,

        COUNT(*) FILTER (
          WHERE u.role = 'display'
        ) AS display_count,

        COUNT(*) FILTER (
          WHERE u.role IN ('rider', 'delivery_rider','delivery')
        ) AS delivery_rider_count

      FROM restaurants r

      LEFT JOIN users u
        ON u.restaurant_id = r.id

      WHERE r.id = $1

      GROUP BY r.id
      `,
      [id]
    );

  return result.rows[0];

};

// ======================================================
// DELETE RESTAURANT
// ======================================================

const deleteRestaurant = async (id) => {

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    // --------------------------------------------------
    // 1. ORDER ITEMS
    // --------------------------------------------------

    await client.query(
      `
      DELETE FROM order_items

      WHERE order_id IN
      (
        SELECT id
        FROM orders
        WHERE restaurant_id = $1
      )
      `,
      [id]
    );

    // --------------------------------------------------
    // 2. ORDERS
    // --------------------------------------------------

    await client.query(
      `
      DELETE FROM orders

      WHERE restaurant_id = $1
      `,
      [id]
    );

    // --------------------------------------------------
    // 3. RECIPE INGREDIENT LINKS
    // --------------------------------------------------

    await client.query(
      `
      DELETE FROM menu_item_ingredients

      WHERE menu_item_id IN
      (
        SELECT id
        FROM menu_items
        WHERE restaurant_id = $1
      )

      OR inventory_id IN
      (
        SELECT id
        FROM inventory_items
        WHERE restaurant_id = $1
      )
      `,
      [id]
    );

    // --------------------------------------------------
    // 4. INVENTORY TRANSACTIONS
    // --------------------------------------------------

    await client.query(
      `
      DELETE FROM inventory_transactions

      WHERE inventory_id IN
      (
        SELECT id
        FROM inventory_items
        WHERE restaurant_id = $1
      )
      `,
      [id]
    );

    // --------------------------------------------------
    // 5. INVENTORY ITEMS
    // --------------------------------------------------

    await client.query(
      `
      DELETE FROM inventory_items

      WHERE restaurant_id = $1
      `,
      [id]
    );

    // --------------------------------------------------
    // 6. MENU ITEMS
    // --------------------------------------------------

    await client.query(
      `
      DELETE FROM menu_items

      WHERE restaurant_id = $1
      `,
      [id]
    );

    // --------------------------------------------------
    // 7. ✅ SHIFTS — Delete BEFORE users
    //    (shifts.user_id references users.id)
    // --------------------------------------------------

    await client.query(
      `
      DELETE FROM shifts

      WHERE user_id IN
      (
        SELECT id
        FROM users
        WHERE restaurant_id = $1
      )
      `,
      [id]
    );

    // --------------------------------------------------
    // 8. USERS
    // --------------------------------------------------

    await client.query(
      `
      DELETE FROM users

      WHERE restaurant_id = $1
      `,
      [id]
    );

    // --------------------------------------------------
    // 9. RESTAURANT
    // --------------------------------------------------

    await client.query(
      `
      DELETE FROM restaurants

      WHERE id = $1
      `,
      [id]
    );

    await client.query("COMMIT");

  } catch (err) {

    await client.query("ROLLBACK");
    throw err;

  } finally {

    client.release();

  }

};

// ======================================================
// UPDATE RESTAURANT DETAILS
// ======================================================

const updateRestaurantDetails = async (id, data) => {
  
  const allowedFields = {
    name: 'name',
    owner_name: 'owner_name',
    phone: 'phone',
    email: 'email',
    city: 'city',
    address: 'address'
  };

  const updates = [];
  const values = [];
  let index = 1;

  for (const [key, column] of Object.entries(allowedFields)) {
    if (data[key] !== undefined) {
      updates.push(`${column} = $${index}`);
      values.push(data[key]);
      index++;
    }
  }

  if (updates.length === 0) {
    return getRestaurantDetail(id); // Kuch change nahi, existing data return karein
  }

  values.push(id);

  const query = `
    UPDATE restaurants
    SET ${updates.join(', ')}
    WHERE id = $${index}
    RETURNING *
  `;

  const result = await pool.query(query, values);
  return result.rows[0] || null;
};

// ======================================================
// GET RESTAURANT STAFF
// Now reads plain_password straight from each user's own row —
// works correctly no matter how many staff share a role.
// ======================================================

const getRestaurantStaff =
async (id) => {

  const usersResult =
    await pool.query(
      `
      SELECT
        id,
        username,
        full_name,
        role,
        is_active,
        restaurant_id,
        plain_password AS password

      FROM users

      WHERE restaurant_id = $1

      ORDER BY
        role,
        full_name
      `,
      [id]
    );

  return usersResult.rows;

};

// ======================================================
// RESET STAFF PASSWORD
// (simplified — only touches the one user row now)
// ======================================================

const resetStaffPassword =
async (
  restaurantId,
  userId,
  newPassword
) => {

  const hashed =
    await bcrypt.hash(
      newPassword,
      10
    );

  const result =
    await pool.query(
      `
      UPDATE users

      SET
        password = $1,
        plain_password = $2

      WHERE id = $3
        AND restaurant_id = $4

      RETURNING
        id,
        username,
        role
      `,
      [
        hashed,
        newPassword,
        userId,
        restaurantId
      ]
    );

  return result.rows[0] || null;

};

// ======================================================
// ADD STAFF MEMBER
//
// SUPER ADMIN ONLY
//
// IMPORTANT:
// NO PLAN LIMIT IS CHECKED HERE.
//
// This means:
// Basic restaurant can have 2 initial waiters,
// but Super Admin can later add waiter #3, #4, #5...
// ======================================================

const addStaffMember = async (
  restaurantId,
  data
) => {

  const {
    full_name,
    username,
    password,
    role
  } = data;


  // --------------------------------------------------
  // CHECK RESTAURANT
  // --------------------------------------------------

  const restaurantResult =
    await pool.query(
      `
      SELECT
        id,
        name
      FROM restaurants
      WHERE id = $1
      `,
      [restaurantId]
    );


  if (!restaurantResult.rows[0]) {

    throw new Error(
      "Restaurant not found."
    );

  }


  // --------------------------------------------------
  // ALLOWED STAFF ROLES
  // --------------------------------------------------

  const allowedRoles = [
    "waiter",
    "counter",
    "display",
    "kitchen",
    "rider"
  ];


  if (!allowedRoles.includes(role)) {

    throw new Error(
      "Invalid staff role."
    );

  }


  // --------------------------------------------------
  // USERNAME
  // --------------------------------------------------

  if (!username || username.trim().length < 2) {

    throw new Error(
      "Username is required."
    );

  }


  // --------------------------------------------------
  // PASSWORD
  // --------------------------------------------------

  if (!password || password.length < 4) {

    throw new Error(
      "Password must be at least 4 characters."
    );

  }


  // --------------------------------------------------
  // HASH PASSWORD
  // --------------------------------------------------

  const hashedPassword =
    await bcrypt.hash(
      password,
      10
    );


  // --------------------------------------------------
  // CREATE USER
  //
  // NO PLAN LIMIT CHECK HERE
  // --------------------------------------------------

  const result =
    await pool.query(
      `
      INSERT INTO users
      (
        full_name,
        username,
        password,
        plain_password,
        role,
        restaurant_id
      )

      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6
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
        full_name || role,
        username.trim(),
        hashedPassword,
        password,
        role,
        restaurantId
      ]
    );


  return {

    ...result.rows[0],

    password

  };

};

// ======================================================
// DELETE STAFF MEMBER
// Never deletes the manager through this route — a restaurant
// must always keep its manager account (use "Delete Restaurant"
// or a future "reassign manager" flow for that case instead).
// ======================================================

const deleteStaffMember = async (restaurantId, userId) => {

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const check = await client.query(
      `SELECT role FROM users WHERE id = $1 AND restaurant_id = $2`,
      [userId, restaurantId]
    );

    if (!check.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    if (check.rows[0].role === "manager") {
      await client.query("ROLLBACK");
      throw new Error("Manager account cannot be deleted from the staff list.");
    }

    // shifts.user_id references users.id — remove this staff
    // member's shift records first, or the delete below fails
    // with a foreign key error.
    await client.query(
      `DELETE FROM shifts WHERE user_id = $1`,
      [userId]
    );

    const result = await client.query(
      `DELETE FROM users WHERE id = $1 AND restaurant_id = $2 RETURNING id, username, role`,
      [userId, restaurantId]
    );

    await client.query("COMMIT");
    return result.rows[0];

  } catch (err) {

    await client.query("ROLLBACK");
    throw err;

  } finally {

    client.release();

  }

};

// ======================================================
// EXPORTS
// ======================================================

module.exports = {

  getAllRestaurants,

  createRestaurant,

  updateRestaurantStatus,

  updateSubscription,

  updateFoodType,

  resetManagerPassword,

  getRestaurantDetail,

  deleteRestaurant,

  getRestaurantStaff,

  addStaffMember,

  resetStaffPassword,

  deleteStaffMember,

  updateRestaurantDetails,

  ALLOWED_FOOD_TYPES

};