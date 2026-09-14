import Dexie from 'https://cdn.jsdelivr.net/npm/dexie@4.0.8/dist/dexie.mjs';

const db = new Dexie('RestaurantPOS');

db.version(2).stores({
  orders: '++id, table_no, status, created_at, synced, server_id',
  order_items: '++id, order_id, menu_item_id, variant_id, quantity, price, name',
  order_deals: '++id, order_id, deal_id, quantity',  
  payments: '++id, order_id, amount, method, synced',
  sync_queue: '++id, type, data, created_at, status'
});

// ✅ Version 3: Offline customer lookup cache
db.version(3).stores({
  orders: '++id, table_no, status, created_at, synced, server_id',
  order_items: '++id, order_id, menu_item_id, variant_id, quantity, price, name',
  order_deals: '++id, order_id, deal_id, quantity',  
  payments: '++id, order_id, amount, method, synced',
  sync_queue: '++id, type, data, created_at, status',
  customers: 'phone'    // ✅ Naya store — phone primary key
});

export default db;