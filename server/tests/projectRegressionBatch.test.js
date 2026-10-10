'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const pathUtil = require('node:path');

const calls = [];
let queryHandler = async () => ({ rows: [] });

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}
function record(sql, params, where) {
  const item = { sql: normalize(sql), params: params || [], where };
  calls.push(item);
  return item;
}
const client = {
  async query(sql, params) {
    const item = record(sql, params, 'client');
    return queryHandler(item.sql, item.params, 'client');
  },
  release() { calls.push({ sql: 'RELEASE', params: [], where: 'client' }); }
};
const poolMock = {
  async query(sql, params) {
    const item = record(sql, params, 'pool');
    return queryHandler(item.sql, item.params, 'pool');
  },
  async connect() { calls.push({ sql: 'CONNECT', params: [], where: 'pool' }); return client; }
};

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: poolMock };

const inventory = require('../models/inventoryModel');
const users = require('../models/userModel');
const suppliers = require('../models/supplierModel');
const reports = require('../models/reportModel');
const orders = require('../models/orderModel');
const deals = require('../models/dealModel');

function reset(handler = async () => ({ rows: [] })) {
  calls.length = 0;
  queryHandler = handler;
}
function rows(values) {
  return { rows: values, rowCount: values.length };
}
function sqlCalls(match, where) {
  return calls.filter(c => (!where || c.where === where) && match.test(c.sql));
}
function readSource(relative) {
  return fs.readFileSync(pathUtil.join(__dirname, '..', relative), 'utf8');
}

// INVENTORY MODEL: tenant scope, stock validation, transaction integrity.
test('inventory get-by-id scopes by both item and restaurant', async () => {
  reset(() => rows([{ id: 8, restaurant_id: 12 }]));
  await inventory.getItemById(8, 12);
  const q = sqlCalls(/FROM inventory_items WHERE id = \$1 AND restaurant_id = \$2/)[0];
  assert.ok(q);
  assert.deepEqual(q.params, [8, 12]);
});
for (const status of ['all', 'active', 'inactive']) {
  test('inventory list always scopes to restaurant for status=' + status, async () => {
    reset(() => rows([]));
    await inventory.getAllItems(12, status);
    const q = sqlCalls(/FROM inventory_items WHERE restaurant_id = \$1/)[0];
    assert.ok(q);
    assert.deepEqual(q.params, [12]);
    if (status === 'active') assert.match(q.sql, /is_active = TRUE/);
    if (status === 'inactive') assert.match(q.sql, /is_active = FALSE/);
  });
}
for (const stock of [-1, NaN, Infinity, -Infinity, 'not-a-number']) {
  test('inventory creation rejects invalid opening stock ' + String(stock), async () => {
    reset();
    await assert.rejects(inventory.createItem({
      name: 'Test item', unit: 'kg', stock_quantity: stock, restaurant_id: 12
    }), /Opening stock must be 0 or greater/);
    assert.equal(sqlCalls(/INSERT INTO inventory_items/).length, 0);
    assert.ok(sqlCalls(/^ROLLBACK$/).length);
  });
}
test('inventory creation rejects supplier from another restaurant', async () => {
  reset((sql) => sql.includes('SELECT id FROM suppliers') ? rows([]) : rows([]));
  await assert.rejects(inventory.createItem({
    name: 'Test item', unit: 'kg', stock_quantity: 2, supplier_id: 4, restaurant_id: 12
  }), /Supplier not found/);
  assert.equal(sqlCalls(/INSERT INTO inventory_items/).length, 0);
  assert.ok(sqlCalls(/^ROLLBACK$/).length);
});
test('inventory creation records positive opening stock in its transaction', async () => {
  reset((sql) => {
    if (sql.includes('INSERT INTO inventory_items')) return rows([{ id: 99, name: 'Rice' }]);
    return rows([]);
  });
  await inventory.createItem({
    name: 'Rice', unit: 'kg', stock_quantity: 5, restaurant_id: 12
  });
  assert.ok(sqlCalls(/^BEGIN$/).length);
  assert.ok(sqlCalls(/INSERT INTO inventory_items/).length);
  const opening = sqlCalls(/INSERT INTO inventory_transactions/)[0];
  assert.ok(opening);
  assert.equal(opening.params[0], 99);
  assert.equal(opening.params[1], 5);
  assert.ok(sqlCalls(/^COMMIT$/).length);
});
test('zero opening stock does not create a false stock-in transaction', async () => {
  reset((sql) => sql.includes('INSERT INTO inventory_items') ? rows([{ id: 100 }]) : rows([]));
  await inventory.createItem({ name: 'Empty', unit: 'unit', stock_quantity: 0, restaurant_id: 12 });
  assert.equal(sqlCalls(/INSERT INTO inventory_transactions/).length, 0);
});
test('inventory update ignores client attempts to change stock and tenant columns', async () => {
  reset((sql) => sql.includes('UPDATE inventory_items') ? rows([{ id: 8, restaurant_id: 12 }]) : rows([]));
  await inventory.updateItem(8, 12, {
    name: 'Renamed', stock_quantity: 999, restaurant_id: 99, id: 77
  });
  const q = sqlCalls(/UPDATE inventory_items/)[0];
  assert.ok(q);
  assert.match(q.sql, /SET name = \$1/);
  const clauses = q.sql.split(/\bWHERE\b/i);
  const setClause = clauses[0];
  const whereClause = clauses.slice(1).join(' WHERE ');

  assert.doesNotMatch(setClause, /\bstock_quantity\s*=/i);
  assert.doesNotMatch(setClause, /(?:^|,)\s*restaurant_id\s*=/i);
  assert.doesNotMatch(setClause, /(?:^|,)\s*id\s*=/i);
  assert.match(whereClause, /\bid\s*=\s*\$2\s+AND\s+restaurant_id\s*=\s*\$3/i);
  assert.deepEqual(q.params, ['Renamed', 8, 12]);
});
test('inventory update validates supplier ID before querying', async () => {
  reset();
  await assert.rejects(inventory.updateItem(8, 12, { supplier_id: 'bad' }), /Invalid supplier/);
  assert.equal(sqlCalls(/UPDATE inventory_items/).length, 0);
  assert.ok(sqlCalls(/^ROLLBACK$/).length);
});
test('inventory update rejects a supplier not owned by the restaurant', async () => {
  reset(() => rows([]));
  await assert.rejects(inventory.updateItem(8, 12, { supplier_id: 44 }), /Supplier not found/);
  assert.equal(sqlCalls(/UPDATE inventory_items/).length, 0);
});
test('inventory deactivate is tenant-scoped', async () => {
  reset(() => rows([{ id: 8 }]));
  await inventory.setItemActive(8, 12, false);
  const q = sqlCalls(/UPDATE inventory_items/)[0];
  assert.ok(q);
  assert.match(q.sql, /restaurant_id = \$3/);
  assert.deepEqual(q.params, [false, 8, 12]);
});
test('inventory dashboard runs tenant-filtered queries for each panel', async () => {
  reset((sql) => sql.includes('COUNT(*)::int AS total_items') ? rows([{}]) : rows([]));
  await inventory.getDashboard(12);
  const queries = sqlCalls(/FROM inventory_items|FROM inventory_transactions/);
  assert.ok(queries.length >= 4);
  for (const q of queries) assert.ok(q.params.includes(12), q.sql);
});

// USER MODEL: role allow-list, password length, plan limit, tenant-bound writes.
for (const role of ['super_admin', 'admin', 'owner', 'manager', 'cashier', '', null, 'unknown']) {
  test('staff creation rejects disallowed role ' + String(role), async () => {
    reset();
    await assert.rejects(users.createStaff(12, 'Name', 'user', '1234', role, 'manager'), e => e.code === 'INVALID_ROLE');
    assert.equal(sqlCalls(/^CONNECT$/).length, 0);
  });
}
for (const password of ['', '1', '12', '123', '123456789', '1234567890', null, 1234, true]) {
  test('staff creation rejects invalid password type/length ' + String(password), async () => {
    reset();
    await assert.rejects(users.createStaff(12, 'Name', 'user', password, 'waiter', 'manager'), e => e.code === 'INVALID_PASSWORD');
    assert.equal(sqlCalls(/^CONNECT$/).length, 0);
  });
}
for (const password of ['1', '123', '123456789', 1234]) {
  test('staff update rejects invalid password ' + String(password), async () => {
    reset();
    await assert.rejects(users.updateStaff(5, 12, null, null, password), e => e.code === 'INVALID_PASSWORD');
    assert.equal(sqlCalls(/UPDATE users/).length, 0);
  });
}
test('staff update scopes changes by user, restaurant and allowed staff roles', async () => {
  reset(() => rows([{ id: 5, restaurant_id: 12, username: 'new-name' }]));
  await users.updateStaff(5, 12, 'New Name', 'new-name', null);
  const q = sqlCalls(/UPDATE users SET/)[0];
  assert.ok(q);
  assert.match(q.sql, /WHERE id = \$3 AND restaurant_id = \$4/);
  assert.match(q.sql, /role IN \('waiter','kitchen','counter','delivery','display'\)/);
  assert.deepEqual(q.params, ['New Name', 'new-name', 5, 12]);
});
test('deactivating staff clears current session and scopes by restaurant', async () => {
  reset(() => rows([{ id: 5, is_active: false }]));
  await users.setStaffActive(5, 12, false);
  const q = sqlCalls(/UPDATE users SET/)[0];
  assert.ok(q);
  assert.match(q.sql, /current_session = CASE WHEN \$1 = false THEN NULL/);
  assert.match(q.sql, /WHERE id = \$2 AND restaurant_id = \$3/);
  assert.deepEqual(q.params, [false, 5, 12]);
});
test('staff lookup returns no password column', async () => {
  reset(() => rows([]));
  await users.findUserByUsername('staff');
  const q = sqlCalls(/FROM users WHERE username/)[0];
  assert.ok(q);
  assert.match(q.sql, /SELECT id, username, full_name, role, restaurant_id, is_active/);
  assert.doesNotMatch(q.sql, /SELECT[^]*password/);
});

// SUPPLIER MODEL: every data path must include tenant context.
test('supplier list scopes to restaurant', async () => {
  reset(() => rows([]));
  await suppliers.listSuppliers(12);
  const q = sqlCalls(/FROM suppliers s/)[0];
  assert.ok(q);
  assert.match(q.sql, /s\.restaurant_id = \$1/);
  assert.deepEqual(q.params, [12]);
});
test('supplier list search is parameterized and tenant-scoped', async () => {
  reset(() => rows([]));
  await suppliers.listSuppliers(12, { search: "x%' OR 1=1 --" });
  const q = sqlCalls(/FROM suppliers s/)[0];
  assert.ok(q);
  assert.match(q.sql, /s\.restaurant_id = \$1/);
  assert.match(q.sql, /ILIKE \$2/);
  assert.deepEqual(q.params, [12, "%x%' OR 1=1 --%"]);
});
test('supplier lookup scopes by supplier and restaurant', async () => {
  reset(() => rows([]));
  await suppliers.getSupplierById(7, 12);
  const q = sqlCalls(/FROM suppliers/)[0];
  assert.ok(q);
  assert.match(q.sql, /id = \$1 AND restaurant_id = \$2/);
  assert.deepEqual(q.params, [7, 12]);
});
test('supplier aging query tenant-filters supplier, purchases and payments', async () => {
  reset(() => rows([]));
  await suppliers.getAgingReport(12);
  const q = sqlCalls(/FROM suppliers s/)[0];
  assert.ok(q);
  assert.match(q.sql, /s\.restaurant_id = \$1/);
  assert.match(q.sql, /FROM supplier_purchases WHERE restaurant_id = \$1/);
  assert.match(q.sql, /FROM supplier_payments WHERE restaurant_id = \$1/);
  assert.deepEqual(q.params, [12]);
});
test('supplier aging classifies zero balance as settled', async () => {
  reset(() => rows([{ id: 1, name: 'Paid', balance: '0', oldest_unpaid_date: null }]));
  const result = await suppliers.getAgingReport(12);
  assert.equal(result[0].bucket, 'Settled');
  assert.equal(result[0].balance, 0);
});
test('supplier aging classifies positive balance without old date as current', async () => {
  reset(() => rows([{ id: 2, name: 'New', balance: '50.25', oldest_unpaid_date: null }]));
  const result = await suppliers.getAgingReport(12);
  assert.equal(result[0].bucket, 'Current');
  assert.equal(result[0].balance, 50.25);
});

// REPORTS: tenant scope and date parameterization.
for (const [name, method] of [
  ['summary', reports.getSummary],
  ['sales details', reports.getSalesDetails],
  ['top items', reports.getTopItems],
  ['payment summary', reports.getPaymentSummary],
  ['sales chart', reports.getSalesChart]
]) {
  test('report ' + name + ' passes restaurant ID as first SQL parameter', async () => {
    reset(() => rows([]));
    await method(12);
    assert.ok(calls.some(c => c.params && c.params[0] === 12 && /restaurant_id = \$1/.test(c.sql)), name);
  });
}
for (const [name, method] of [
  ['sales details', reports.getSalesDetails],
  ['top items', reports.getTopItems],
  ['payment summary', reports.getPaymentSummary],
  ['sales chart', reports.getSalesChart]
]) {
  test('report ' + name + ' binds date filters as parameters', async () => {
    reset(() => rows([]));
    await method(12, '2026-01-01', '2026-01-31');
    const q = calls.find(c => c.params && c.params.length >= 3 && c.params[0] === 12);
    assert.ok(q, name + ' did not bind date params');
    assert.ok(q.params.includes('2026-01-01'));
    assert.ok(q.params.includes('2026-01-31'));
    assert.doesNotMatch(q.sql, /2026-01-01|2026-01-31/);
  });
}
test('sales details restricts records to completed paid orders', async () => {
  reset(() => rows([]));
  await reports.getSalesDetails(12);
  const q = sqlCalls(/FROM orders o/)[0];
  assert.ok(q);
  assert.match(q.sql, /o\.payment_status = 'paid'/);
  assert.match(q.sql, /o\.status = 'completed'/);
});
test('top items excludes deal line items and tenant-mismatched menu items', async () => {
  reset(() => rows([]));
  await reports.getTopItems(12);
  const q = sqlCalls(/FROM orders o/)[0];
  assert.ok(q);
  assert.match(q.sql, /oi\.order_deal_id IS NULL/);
  assert.match(q.sql, /m\.restaurant_id = o\.restaurant_id/);
});

// ORDER MODEL: tenant-scoped reads and safe date filters.
test('order lookup without tenant fails closed and never runs an unscoped query', async () => {
  reset(() => rows([{ id: 4 }]));
  const result = await orders.getOrderById(4);
  assert.equal(result, null);
  assert.equal(sqlCalls(/SELECT \\* FROM orders/).length, 0);
});
test('order lookup with tenant scopes order ID and restaurant', async () => {
  reset(() => rows([{ id: 4, restaurant_id: 12 }]));
  await orders.getOrderById(4, 12);
  const q = sqlCalls(/SELECT \* FROM orders/)[0];
  assert.ok(q);
  assert.match(q.sql, /id = \$1 AND restaurant_id = \$2/);
  assert.deepEqual(q.params, [4, 12]);
});
test('order items lookup tenant-filters through parent order', async () => {
  reset(() => rows([]));
  await orders.getOrderItemsByOrderId(4, 12);
  const q = sqlCalls(/FROM order_items oi/)[0];
  assert.ok(q);
  assert.match(q.sql, /INNER JOIN orders o ON o\.id = oi\.order_id/);
  assert.match(q.sql, /o\.restaurant_id = \$2/);
  assert.deepEqual(q.params, [4, 12]);
});

// FBR: super-admin order access is explicit, while tenant lookups stay fail-closed.
test('super-admin FBR lookup uses an explicit validated global order lookup', async () => {
  reset(() => rows([{ id: 4, restaurant_id: 88 }]));
  const result = await orders.getOrderByIdForSuperAdmin(4);
  assert.equal(result.restaurant_id, 88);
  const q = sqlCalls(/SELECT \* FROM orders WHERE id = \$1/)[0];
  assert.ok(q);
  assert.deepEqual(q.params, [4]);
});
test('super-admin global order lookup rejects invalid IDs without querying', async () => {
  reset();
  assert.equal(await orders.getOrderByIdForSuperAdmin('bad'), null);
  assert.equal(await orders.getOrderByIdForSuperAdmin(0), null);
  assert.equal(calls.length, 0);
});
test('FBR submit and status route through explicit super-admin lookup', () => {
  const source = readSource('controllers/fbrController.js');
  assert.match(source, /getOrderByIdForSuperAdmin/);
  assert.equal((source.match(/await getOrderByIdForSuperAdmin\(orderId\)/g) || []).length, 2);
  assert.doesNotMatch(source, /getOrderById\(\s*orderId,\s*req\.user\?\.role === 'super_admin' \? null/);
});

// DEAL MODEL: deal components must belong to the same restaurant.
test('deal creation rejects a menu item from another restaurant before inserting the deal', async () => {
  reset(() => rows([]));
  await assert.rejects(
    deals.createDeal('Test deal', 100, 'deal', null, null, 12, [
      { menu_item_id: 999, variant_id: null, quantity: 1 }
    ]),
    error => error.code === 'INVALID_DEAL_ITEM'
  );
  assert.equal(sqlCalls(/INSERT INTO deals/).length, 0);
  assert.equal(sqlCalls(/INSERT INTO deal_items/).length, 0);
  assert.ok(sqlCalls(/^ROLLBACK$/).length);
});

test('deal creation rejects invalid component IDs and quantities before database writes', async () => {
  reset();
  await assert.rejects(
    deals.createDeal('Test deal', 100, 'deal', null, null, 12, [
      { menu_item_id: 999, variant_id: -2, quantity: 0 }
    ]),
    error => error.code === 'INVALID_DEAL_ITEM'
  );
  assert.equal(sqlCalls(/INSERT INTO deals|INSERT INTO deal_items/).length, 0);
});

test('deal read joins prevent cross-restaurant menu and variant data from being attached', () => {
  const source = readSource('models/dealModel.js');
  assert.match(source, /mi\.restaurant_id = d\.restaurant_id/);
  assert.match(source, /miv\.menu_item_id = mi\.id/);
  assert.match(source, /await validateDealItems\(client, items, restaurantId\)/);
});

// ROUTE POLICY CONTRACTS: protect role/plan policies against accidental route changes.
const routeCases = [
  ['auth login is POST', 'routes/authRoutes.js', /router\.post\('\/login',\s*login\)/],
  ['staff listing is manager/counter only', 'routes/userRoutes.js', /router\.get\('\/', authMiddleware, authorize\('manager', 'counter'\)/],
  ['staff creation is manager only', 'routes/userRoutes.js', /router\.post\('\/', authMiddleware, authorize\('manager'\)/],
  ['staff activation is manager only', 'routes/userRoutes.js', /router\.patch\('\/:id\/activate', authMiddleware, authorize\('manager'\)/],
  ['restaurant listing is super-admin only', 'routes/restaurantRoutes.js', /router\.get\([\s\S]*?authorize\('super_admin'\)[\s\S]*?listRestaurants/],
  ['restaurant creation is super-admin only', 'routes/restaurantRoutes.js', /router\.post\([\s\S]*?authorize\('super_admin'\)[\s\S]*?addRestaurant/],
  ['reports summary is manager/counter only', 'routes/reportRoutes.js', /router\.get\('\/summary', authMiddleware, authorize\('manager', 'counter'\)/],
  ['sales report is manager/counter only', 'routes/reportRoutes.js', /router\.get\('\/sales', authMiddleware, authorize\('manager', 'counter'\)/],
  ['supplier router authenticates all routes', 'routes/supplierRoutes.js', /router\.use\(authMiddleware\)/],
  ['supplier create requires manager/counter', 'routes/supplierRoutes.js', /router\.post\('\/', authorize\('manager', 'counter'\)/],
  ['inventory creation requires manager/counter', 'routes/inventoryRoutes.js', /router\.post\("\/", authMiddleware, authorize\("manager", "counter"\)/],
  ['inventory transaction write requires manager/counter', 'routes/inventoryRoutes.js', /router\.post\([\s\S]*?\/:id\/transaction[\s\S]*?authorize\("manager", "counter"\)/],
  ['menu create requires manager/counter', 'routes/menuRoutes.js', /router\.post\('\/', authMiddleware, authorize\('manager', 'counter'\)/],
  ['deal create requires manager/counter', 'routes/dealRoutes.js', /router\.post\([\s\S]*?authorize\('manager', 'counter'\)[\s\S]*?createDeal/],
  ['wholesale sale requires staff role policy', 'routes/wholesaleRoutes.js', /const staff = authorize\('counter', 'manager'\)/],
  ['delivery list is rider-only', 'routes/orderRoutes.js', /router\.get\([\s\S]*?\/my-deliveries[\s\S]*?authorize\([\s\S]*?'delivery'[\s\S]*?\)[\s\S]*?getMyDeliveryOrders/],
  ['rider self-summary is rider-only', 'routes/orderRoutes.js', /router\.get\(\s*['\"]\/rider\/my-summary['\"][\s\S]*?authMiddleware[\s\S]*?authorize\(\s*['\"]delivery['\"]\s*\)[\s\S]*?getMyRiderSummary\s*\)/],
  ['QR payment endpoints use auth middleware', 'routes/paymentRoutes.js', /authMiddleware/],
  ['POS charge settings permit manager and Counter Lite', 'routes/settingsRoutes.js', /router\.put\('\/pos', managerOrCounter, settingsController\.savePosSettings\)/],
  ['Raast QR mutation remains manager-only', 'routes/settingsRoutes.js', /router\.put\('\/raast-qr', managerOnly, settingsController\.saveRaastQr\)/],
  ['table QR token endpoint checks tenant access', 'controllers/publicController.js', /req\.user\.role !== 'super_admin' && Number\(req\.user\.restaurant_id\) !== restaurantId/],
  ['table QR tokens use timing-safe comparison', 'controllers/publicController.js', /crypto\.timingSafeEqual/],
  ['table QR token generation is keyed by restaurant and table', 'controllers/publicController.js', /sizlio-table-qr:v1:\$\{restaurantId\}:\$\{tableNo\}/],
  ['auth session checks current session ID', 'middleware/authMiddleware.js', /user\.current_session !== decoded\.sessionId/],
  ['auth middleware requires session ID in token', 'middleware/authMiddleware.js', /!decoded\.id \|\| !decoded\.sessionId/],
  ['auth cookie writes enforce origin check', 'middleware/authMiddleware.js', /if \(cookieToken && !\['GET', 'HEAD', 'OPTIONS'\]\.includes\(req\.method\)\)/],
  ['password reset forces initial password change', 'models/userModel.js', /must_change_password = TRUE/],
  ['password reset invalidates existing session', 'models/userModel.js', /current_session = NULL/],
  ['staff query does not expose password hashes', 'models/userModel.js', /SELECT id, username, full_name, role, restaurant_id, is_active/],
  ['report joins menu items to the same tenant', 'models/reportModel.js', /m\.restaurant_id = o\.restaurant_id/],
];
for (const [label, file, pattern] of routeCases) {
  test('policy contract: ' + label, () => {
    const source = readSource(file);
    assert.match(source, pattern);
  });
}
