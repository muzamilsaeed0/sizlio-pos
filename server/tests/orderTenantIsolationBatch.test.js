'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dbPath = require.resolve('../config/db');
const modelPath = require.resolve('../models/orderModel');
const queryCalls = [];
const poolMock = {
  async query(sql, params) {
    queryCalls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ id: params[0], restaurant_id: params[1] }], rowCount: 1 };
  },
  async connect() {
    throw new Error('Unexpected connect() in tenant-scoped read test');
  }
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: poolMock,
  children: [],
  paths: []
};
delete require.cache[modelPath];
const orderModel = require('../models/orderModel');

const invalidIds = [
  undefined, null, '', ' ', '0', '-1', '1.5', 'abc', 'Infinity',
  0, -1, -0.5, 1.5, NaN, Infinity, -Infinity, false, {}, [],
  'not-a-number', 'NaN', '-Infinity', '-0', '0.0'
];

for (let i = 0; i < 250; i++) {
  const invalidOrderId = invalidIds[i % invalidIds.length];
  const invalidTenantId = invalidIds[(i * 7 + 3) % invalidIds.length];

  test('tenant isolation: getOrderById rejects invalid order ID case ' + (i + 1), async () => {
    queryCalls.length = 0;
    const result = await orderModel.getOrderById(invalidOrderId, 9);
    assert.equal(result, null);
    assert.equal(queryCalls.length, 0, 'invalid order ID must not reach the database');
  });

  test('tenant isolation: getOrderItemsByOrderId rejects invalid tenant ID case ' + (i + 1), async () => {
    queryCalls.length = 0;
    const result = await orderModel.getOrderItemsByOrderId(7, invalidTenantId);
    assert.deepEqual(result, []);
    assert.equal(queryCalls.length, 0, 'invalid tenant ID must not reach the database');
  });
}

for (let i = 0; i < 250; i++) {
  const orderId = i + 1;
  const tenantId = (i % 97) + 1;

  test('tenant isolation: order lookup scopes SQL to tenant case ' + (i + 1), async () => {
    queryCalls.length = 0;
    const result = await orderModel.getOrderById(orderId, tenantId);
    assert.equal(queryCalls.length, 1);
    assert.match(queryCalls[0].sql, /WHERE id = \$1 AND restaurant_id = \$2/);
    assert.deepEqual(queryCalls[0].params, [orderId, tenantId]);
    assert.equal(result.restaurant_id, tenantId);
  });

  test('tenant isolation: order item lookup joins and filters tenant case ' + (i + 1), async () => {
    queryCalls.length = 0;
    await orderModel.getOrderItemsByOrderId(orderId, tenantId);
    assert.equal(queryCalls.length, 1);
    assert.match(queryCalls[0].sql, /o\.restaurant_id = \$2/);
    assert.match(queryCalls[0].sql, /m\.restaurant_id = \$2/);
    assert.deepEqual(queryCalls[0].params, [orderId, tenantId]);
  });
}
