import Dexie from 'https://cdn.jsdelivr.net/npm/dexie@4.0.8/dist/dexie.mjs';

// ✅ Fresh database name — purana abandon
const db = new Dexie('RestaurantPOS_v2');

db.version(1).stores({
  orders: '++id, table_no, status, created_at, synced, server_id',
  order_items: '++id, order_id, menu_item_id, variant_id, quantity, price, name',
  order_deals: '++id, order_id, deal_id, quantity',
  payments: '++id, order_id, amount, method, synced',
  sync_queue: '++id, type, data, created_at, status',
  customers_v2: '[restaurant_id+phone], restaurant_id, phone'
});

export default db;