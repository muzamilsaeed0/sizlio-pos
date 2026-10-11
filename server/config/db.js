const { Pool } = require("pg");
require("dotenv").config();

// Verify PostgreSQL TLS certificates by default in production. If a hosting
// provider explicitly requires a non-public/self-signed CA, configure its CA
// certificate instead of disabling verification. The opt-out is deliberate,
// explicit, and should only be used temporarily after assessing the risk.
const production = process.env.NODE_ENV === 'production';
const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: production ? { rejectUnauthorized } : false
});

// Handle background errors from idle pooled clients. Without a listener,
// an idle-client error may become an unhandled EventEmitter error.
pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});

module.exports = pool;