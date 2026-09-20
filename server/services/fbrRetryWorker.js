const { retryPendingInvoices } = require('./fbrService');

const RETRY_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes — adjust as needed

function startFbrRetryWorker() {
  setInterval(async () => {
    try {
      const results = await retryPendingInvoices();
      if (results.length) {
        console.log(`[FBR retry worker] processed ${results.length} invoice(s):`, results);
      }
    } catch (err) {
      console.error('[FBR retry worker] error:', err.message);
    }
  }, RETRY_INTERVAL_MS);

  console.log('[FBR retry worker] started — checking every', RETRY_INTERVAL_MS / 60000, 'minute(s)');
}

module.exports = { startFbrRetryWorker };
