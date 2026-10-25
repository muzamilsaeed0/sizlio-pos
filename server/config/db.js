const { Pool } = require("pg");
require("dotenv").config();

const production = process.env.NODE_ENV === 'production';
const databaseSslCa = process.env.DATABASE_SSL_CA
  ? process.env.DATABASE_SSL_CA.replace(/\\n/g, '\n')
  : null;
// Production PostgreSQL connections verify certificates unless explicitly disabled.
const rejectUnauthorized =
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' || !!databaseSslCa;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false  // Railway internal Postgres self-signed cert use karta hai
  }
});
// Handle background errors from idle pooled clients. Without a listener,
// an idle-client error may become an unhandled EventEmitter error.
pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});

module.exports = pool;