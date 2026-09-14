import Dexie from 'https://cdn.jsdelivr.net/npm/dexie@4.0.8/dist/dexie.mjs';

const db = new Dexie('RestaurantPOS');

db.version(2).stores({
  orders: '++id, table_no, status, created_at, synced, server_id',
  order_items: '++id, order_id, menu_item_id, variant_id, quantity, price, name',
  order_deals: '++id, order_id, deal_id, quantity',  
  payments: '++id, order_id, amount, method, synced',
  sync_queue: '++id, type, data, created_at, status'
});

// ✅ Version 3: Customer cache (old)
db.version(3).stores({
  orders: '++id, table_no, status, created_at, synced, server_id',
  order_items: '++id, order_id, menu_item_id, variant_id, quantity, price, name',
  order_deals: '++id, order_id, deal_id, quantity',  
  payments: '++id, order_id, amount, method, synced',
  sync_queue: '++id, type, data, created_at, status',
  customers: 'phone'
});

// ✅ Version 4: Restaurant-wise customer cache (composite key)
db.version(4).stores({
  orders: '++id, table_no, status, created_at, synced, server_id',
  order_items: '++id, order_id, menu_item_id, variant_id, quantity, price, name',
  order_deals: '++id, order_id, deal_id, quantity',  
  payments: '++id, order_id, amount, method, synced',
  sync_queue: '++id, type, data, created_at, status',
  customers: '[restaurant_id+phone], restaurant_id, phone'
});

export default db;