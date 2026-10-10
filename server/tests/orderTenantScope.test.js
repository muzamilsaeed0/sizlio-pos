'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'models', 'orderModel.js'),
  'utf8'
);

test('order-by-id lookup requires a valid tenant and scopes the query', () => {
  const start = source.indexOf('const getOrderById = async');
  const end = source.indexOf('// GET ORDER ITEMS BY ORDER ID', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /const tenantId = Number\(restaurantId\)/);
  assert.match(body, /if \(!Number\.isInteger\(tenantId\)[\s\S]*?return null/);
  assert.match(body, /WHERE id = \$1 AND restaurant_id = \$2/);
  assert.match(body, /\[id, tenantId\]/);
  assert.doesNotMatch(body, /restaurantId\s*=\s*null/);
});

test('order item lookup fails closed and scopes both order and menu item to tenant', () => {
  const start = source.indexOf('const getOrderItemsByOrderId = async');
  const end = source.indexOf('module.exports =', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /if \(!Number\.isInteger\(tenantId\)[\s\S]*?return \[\]/);
  assert.match(body, /o\.restaurant_id = \$2/);
  assert.match(body, /m\.restaurant_id = \$2/);
  assert.match(body, /\[id, tenantId\]/);
  assert.doesNotMatch(body, /\$2::integer IS NULL/);
  assert.doesNotMatch(body, /restaurantId\s*=\s*null/);
});
