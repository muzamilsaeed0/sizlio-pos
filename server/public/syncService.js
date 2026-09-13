// services/syncService.js

import db from './localDB.js';
import OfflineManager from './offline.js';

class SyncService {
  constructor() {
    this.API_BASE = '/api';
    this.setupAutoSync();
  }

  setupAutoSync() {
    OfflineManager.on('online', () => {
      this.syncPendingOrders();
    });
  }


async saveOrderOffline(orderData) {
  console.log('📦 saveOrderOffline called with:', orderData);
  console.log('📦 Items count:', orderData.items?.length || 0);
  console.log('📦 Deals count:', orderData.deals?.length || 0);

  // ✅ 1. Order save karo
  const order = {
    ...orderData,
    status: 'offline_pending',
    synced: 0,
    created_at: new Date().toISOString()
  };

  const orderId = await db.orders.add(order);
  console.log('📦 Order saved with ID:', orderId);

  // ✅ 2. Items save karo
  if (orderData.items && orderData.items.length) {
    for (const item of orderData.items) {
      const itemData = {
        menu_item_id: Number(item.menu_item_id),
        variant_id: item.variant_id ? Number(item.variant_id) : null,
        quantity: Number(item.quantity),
        price: Number(item.price) || 0,
        name: item.name || 'Item',
        order_id: orderId
      };
      await db.order_items.add(itemData);
    }
  }

  // ✅ 3. DEALS SAVE KARO (NEW)
  if (orderData.deals && orderData.deals.length) {
    for (const deal of orderData.deals) {
      const dealData = {
        deal_id: Number(deal.deal_id),
        quantity: Number(deal.quantity),
        order_id: orderId
      };
      await db.order_deals.add(dealData);
      console.log('📦 Deal saved:', dealData);
    }
  }

  // ✅ 4. Check items saved
  const savedItems = await db.order_items.where('order_id').equals(orderId).toArray();
  const savedDeals = await db.order_deals.where('order_id').equals(orderId).toArray();
  console.log('📦 Items saved in DB:', savedItems.length);
  console.log('📦 Deals saved in DB:', savedDeals.length);

  await this.addToQueue('create_order', { orderId });

  return orderId;
}

  // 📤 Sync queue mein entry add karo
  async addToQueue(type, data) {
    await db.sync_queue.add({
      type,
      data: JSON.stringify(data),
      created_at: new Date().toISOString(),
      status: 'pending'
    });
  }

  // 🔄 Pending orders sync karo
  async syncPendingOrders() {
     const token = localStorage.getItem('counter_token')
    if (!token) {
      console.warn('No token found — cannot sync');
      return;
    }

    const pending = await db.sync_queue
      .where('status')
      .equals('pending')
      .toArray();

    if (!pending.length) return;

    for (const entry of pending) {
      try {
        if (entry.type === 'create_order') {
          const orderData = JSON.parse(entry.data);
          const order = await db.orders.get(orderData.orderId);
          
          if (!order) {
            console.warn('Order not found:', orderData.orderId);
            await db.sync_queue.delete(entry.id);
            continue;
          }

          // ✅ Get order items with correct order_id
          const items = await db.order_items
            .where('order_id')
            .equals(order.id)
            .toArray();
            const deals = await db.order_deals
            .where('order_id')
            .equals(order.id)
            .toArray();


          console.log('📦 Items found for order', order.id, ':', items.length);
          console.log('📦 Items data:', items);
          // ✅ Build complete payload
          const payload = {
            table_no: Number(order.table_no) || 0,
            items: items.map(item => ({
              menu_item_id: Number(item.menu_item_id),
              variant_id: item.variant_id ? Number(item.variant_id) : null,
              quantity: Number(item.quantity)
            })),
            deals: deals.map(deal => ({
                deal_id: Number(deal.deal_id),
                quantity: Number(deal.quantity)
              })),
            customer_name: order.customer_name || null,
            order_type: order.order_type || 'dine_in',
            order_source: order.order_source || 'COUNTER',
            delivery_phone: order.delivery_phone || null,
            delivery_address: order.delivery_address || null,
            payment_timing: order.payment_timing || 'PAY_LATER',
            paid_amount: Number(order.paid_amount) || 0,
            pricing: {
              discount_type: order.discount_type || 'none',
              discount_value: Number(order.discount_value) || 0,
              gst_percent: Number(order.gst_percent) || 0,
              tax_percent: Number(order.tax_percent) || 0
            }
          };

          console.log('📤 SYNC PAYLOAD:', JSON.stringify(payload, null, 2));

          const response = await fetch(`${this.API_BASE}/orders`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
          });

          const responseData = await response.json().catch(() => ({}));

          if (response.ok) {
            const serverOrder = responseData.order || responseData.data || responseData;
            await db.orders.update(order.id, {
              synced: 1,
              server_id: serverOrder.id,
              status: 'placed'
            });
            
            await db.sync_queue.delete(entry.id);
            console.log('✅ Order synced successfully:', serverOrder.id);
          } else {
            console.error('❌ Sync failed:', response.status, responseData);
            if (response.status === 401) {
              localStorage.removeItem('counter_token');
              window.location.href = '/counter.html';
            }
          }
        }
      } catch (error) {
        console.error('Sync failed for entry:', entry.id, error);
      }
    }
  }

  // 🔄 Manual sync trigger
  async manualSync() {
    return await this.syncPendingOrders();
  }
}

export default new SyncService();