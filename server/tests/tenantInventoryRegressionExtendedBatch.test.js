'use strict';

// Production-model regression matrix: tenant-bound order reads and inventory
// transaction validation. These tests use isolated DB mocks; they do not
// require credentials or mutate a live restaurant database.
const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../config/db');
const orders = require('../models/orderModel');
const inventory = require('../models/inventoryModel');

async function withPoolQuery(mock, callback) {
  const original = pool.query;
  pool.query = mock;
  try {
    await callback();
  } finally {
    pool.query = original;
  }
}

async function withPoolConnect(mock, callback) {
  const original = pool.connect;
  pool.connect = mock;
  try {
    await callback();
  } finally {
    pool.connect = original;
  }
}

// 2,500 fail-closed order lookup cases. Invalid/missing tenant or order IDs
// must return null without issuing any SQL.
for (let i = 1; i <= 2500; i++) {
  test('getOrderById refuses invalid or missing tenant/order identifier case ' + i, async () => {
    const bad = [undefined, null, 0, -i, NaN, Infinity, 'not-an-id', '1.5', '', '  '][i % 10];
    const orderId = i % 2 ? bad : i;
    const restaurantId = i % 2 ? 1 : bad;
    let queries = 0;

    await withPoolQuery(async () => {
      queries++;
      return { rows: [{ id: orderId, restaurant_id: restaurantId }] };
    }, async () => {
      const result = await orders.getOrderById(orderId, restaurantId);
      assert.equal(result, null);
    });

    assert.equal(queries, 0, 'invalid IDs must be rejected before SQL');
  });
}

// 2,500 fail-closed order-item lookup cases. No query may run unless both
// positive integer order and restaurant IDs are supplied.
for (let i = 1; i <= 2500; i++) {
  test('getOrderItemsByOrderId refuses invalid or missing tenant/order identifier case ' + i, async () => {
    const bad = [undefined, null, 0, -i, NaN, Infinity, 'bad', '2.2', '', '  '][i % 10];
    const orderId = i % 2 ? bad : i;
    const restaurantId = i % 2 ? 1 : bad;
    let queries = 0;

    await withPoolQuery(async () => {
      queries++;
      return { rows: [{ id: i }] };
    }, async () => {
      const result = await orders.getOrderItemsByOrderId(orderId, restaurantId);
      assert.deepEqual(result, []);
    });

    assert.equal(queries, 0, 'invalid IDs must be rejected before SQL');
  });
}

// 2,500 tenant-scoped inventory reads. Assert the SQL and bound parameters
// prevent an item ID alone from crossing a restaurant boundary.
for (let i = 1; i <= 2500; i++) {
  test('getItemById scopes inventory lookup to requested restaurant case ' + i, async () => {
    const itemId = i;
    const restaurantId = 1 + (i % 2000);
    let calls = 0;

    await withPoolQuery(async (sql, params) => {
      calls++;
      assert.match(sql, /FROM inventory_items/i);
      assert.match(sql, /WHERE id\s*=\s*\$1\s+AND restaurant_id\s*=\s*\$2/i);
      assert.deepEqual(params, [itemId, restaurantId]);
      return { rows: [] };
    }, async () => {
      assert.equal(await inventory.getItemById(itemId, restaurantId), null);
    });

    assert.equal(calls, 1);
  });
}

// 1,250 invalid quantities: non-finite, zero, negative and non-numeric values
// must rollback before inserting a stock transaction or updating stock.
for (let i = 1; i <= 1250; i++) {
  test('addTransaction rejects invalid stock quantity without writes case ' + i, async () => {
    const invalidQuantity = [
      0, -i, NaN, Infinity, -Infinity, 'NaN', 'Infinity', '', '   ', 'not-a-number'
    ][i % 10];
    const statements = [];
    let released = false;

    const client = {
      async query(sql, params) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        statements.push({ sql: normalized, params });
        if (/^SELECT id, stock_quantity, is_active FROM inventory_items/i.test(normalized)) {
          return { rows: [{ id: 55, stock_quantity: 100, is_active: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() { released = true; },
    };

    await withPoolConnect(async () => client, async () => {
      await assert.rejects(
        inventory.addTransaction({
          inventory_id: 55,
          restaurant_id: 12,
          type: 'out',
          quantity: invalidQuantity,
        }),
        /Quantity must be greater than 0/
      );
    });

    assert.ok(statements.some(s => s.sql === 'BEGIN'));
    assert.ok(statements.some(s => s.sql === 'ROLLBACK'));
    assert.equal(statements.some(s => /INSERT INTO inventory_transactions/i.test(s.sql)), false);
    assert.equal(statements.some(s => /UPDATE inventory_items/i.test(s.sql)), false);
    assert.equal(released, true);
  });
}

// 1,250 unsupported stock transaction types: an unknown type must fail closed
// and never insert a ledger entry or update the item's quantity.
for (let i = 1; i <= 1250; i++) {
  test('addTransaction rejects unsupported transaction type without writes case ' + i, async () => {
    const type = 'unsupported-type-' + i;
    const statements = [];
    let released = false;

    const client = {
      async query(sql, params) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        statements.push({ sql: normalized, params });
        if (/^SELECT id, stock_quantity, is_active FROM inventory_items/i.test(normalized)) {
          return { rows: [{ id: 56, stock_quantity: 100, is_active: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() { released = true; },
    };

    await withPoolConnect(async () => client, async () => {
      await assert.rejects(
        inventory.addTransaction({
          inventory_id: 56,
          restaurant_id: 13,
          type,
          quantity: 1,
        }),
        /Invalid transaction type/
      );
    });

    assert.ok(statements.some(s => s.sql === 'BEGIN'));
    assert.ok(statements.some(s => s.sql === 'ROLLBACK'));
    assert.equal(statements.some(s => /INSERT INTO inventory_transactions/i.test(s.sql)), false);
    assert.equal(statements.some(s => /UPDATE inventory_items/i.test(s.sql)), false);
    assert.equal(released, true);
  });
}
