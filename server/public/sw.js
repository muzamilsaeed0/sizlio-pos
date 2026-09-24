// =====================================================
// SERVICE WORKER — Push Notifications + PWA Install
// =====================================================

const CACHE_NAME = 'sizlio-pwa-v1';
const STATIC_ASSETS = [
    '/rider',
    '/waiter.html',
    '/manifest.json',
    '/manifest-waiter.json',
    '/icon-192.png',
    '/icon-512.png'
];

// =====================================================
// INSTALL
// =====================================================

self.addEventListener('install', event => {
    console.log('SW installed');
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(STATIC_ASSETS).catch(err => {
                console.warn('SW: Some assets failed to cache:', err);
            });
        }).then(() => self.skipWaiting())
    );
});

// =====================================================
// ACTIVATE
// =====================================================

self.addEventListener('activate', event => {
    console.log('SW activated');
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

// =====================================================
// FETCH — offline support + PWA install requirement
// =====================================================

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Skip non-GET, API calls, and socket.io
    if (
        event.request.method !== 'GET' ||
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/socket.io/') ||
        url.pathname.startsWith('/push/')
    ) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Cache successful responses
                if (response.ok && response.type === 'basic') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, clone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Offline — serve from cache
                return caches.match(event.request).then(cached => {
                    if (cached) return cached;

                    // If navigation request, serve appropriate HTML
                    if (event.request.mode === 'navigate') {
                        if (url.pathname.includes('rider')) {
                            return caches.match('/rider');
                        }
                        if (url.pathname.includes('waiter')) {
                            return caches.match('/waiter.html');
                        }
                    }

                    return new Response('Offline', { status: 503 });
                });
            })
    );
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
            for (const client of clientList) {
                if (client.url.includes('rider') && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});