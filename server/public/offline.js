// utils/offline.js

class OfflineManager {
  constructor() {
    this.isOnline = navigator.onLine;
    this.listeners = [];
    this.setupListeners();
  }

  setupListeners() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.notifyListeners('online');
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.notifyListeners('offline');
    });
  }

  on(event, callback) {
    this.listeners.push({ event, callback });
  }

  notifyListeners(event) {
    this.listeners.forEach(l => {
      if (l.event === event) l.callback();
    });
  }
}

export default new OfflineManager();