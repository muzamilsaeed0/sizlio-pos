// =====================================================
// SERVICE WORKER — Push Notifications
// =====================================================

self.addEventListener('install', event => {
    console.log('SW installed');
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    console.log('SW activated');
    event.waitUntil(self.clients.claim());
});

// =====================================================
// PUSH EVENT — screen off / browser closed
// =====================================================

self.addEventListener('push', event => {
    let data = {};
    
    try {
        data = event.data ? event.data.json() : {};
    } catch(e) {
        data = { 
            title: '🚴 Naya Order Aaya!', 
            body: 'Aapko naya delivery order assign hua hai' 
        };
    }
    
    const title = data.title || '🚴 Naya Order Aaya!';
    const options = {
        body: data.body || 'Naya delivery order assign hua hai',
        icon: data.icon || '/icon-192.png',
        badge: data.badge || '/icon-192.png',
        vibrate: [300, 150, 300, 150, 300, 150, 500],
        tag: data.tag || 'rider-order',
        renotify: true,
        requireInteraction: true,
        silent: false,
        data: data.data || { url: '/rider' },
        actions: [
            { action: 'open', title: '📱 Open App' },
            { action: 'dismiss', title: 'Dismiss' }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// =====================================================
// NOTIFICATION CLICK
// =====================================================

self.addEventListener('notificationclick', event => {
    event.notification.close();
    
    if (event.action === 'dismiss') return;
    
    const urlToOpen = event.notification.data?.url || '/rider';
    
    event.waitUntil(
        clients.matchAll({ 
            type: 'window', 
            includeUncontrolled: true 
        }).then(clientList => {
            // Focus existing rider window if open
            for (const client of clientList) {
                if (client.url.includes('rider') && 'focus' in client) {
                    return client.focus();
                }
            }
            // Otherwise open new window
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});