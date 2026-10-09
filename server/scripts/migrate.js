const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pool = require("../config/db");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const MIGRATION_FILE_RE = /^(\d+)_([a-zA-Z0-9][a-zA-Z0-9_-]*)\.sql$/;
const ADVISORY_LOCK_KEY = "sizlio_pos_schema_migrations_v1";

function getMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MIGRATION_FILE_RE.test(entry.name))
    .map((entry) => {
      const match = entry.name.match(MIGRATION_FILE_RE);
      const version = Number(match[1]);
      const filePath = path.join(MIGRATIONS_DIR, entry.name);
      const sql = fs.readFileSync(filePath, "utf8");
      return {
        version,
        name: entry.name,
        path: filePath,
        sql,
        checksum: crypto.createHash("sha256").update(sql, "utf8").digest("hex"),
      };
    })
    .sort((a, b) => a.version - b.version);
}

function assertUniqueVersions(migrations) {
  const seen = new Set();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    seen.add(migration.version);
  }
}

function assertTransactional(migration) {
  // SQL migrations may begin/end with explanatory comments. Strip comments only
  // at the boundaries before validating the transaction wrapper.
  const stripLeadingComments = (sql) => {
    let value = sql.trimStart();
    while (true) {
      if (value.startsWith("--")) {
        const newline = value.indexOf("\n");
        value = newline === -1 ? "" : value.slice(newline + 1).trimStart();
        continue;
      }
      if (value.startsWith("/*")) {
        const commentEnd = value.indexOf("*/", 2);
        if (commentEnd === -1) return value;
        value = value.slice(commentEnd + 2).trimStart();
        continue;
      }
      return value;
    }
  };

  const stripTrailingComments = (sql) => {
    let value = sql.trimEnd();
    while (true) {
      const lineStart = value.lastIndexOf("\n") + 1;
      const lastLine = value.slice(lineStart).trim();
      if (lastLine.startsWith("--")) {
        value = value.slice(0, lineStart).trimEnd();
        continue;
      }
      if (value.endsWith("*/")) {
        const commentStart = value.lastIndexOf("/*");
        if (commentStart !== -1) {
          value = value.slice(0, commentStart).trimEnd();
          continue;
        }
      }
      return value;
    }
  };

  const normalized = stripTrailingComments(stripLeadingComments(migration.sql))
    .trim()
    .toUpperCase();

  if (!/^BEGIN\s*;[\s\S]*\bCOMMIT\s*;?$/.test(normalized)) {
    throw new Error(
      "Migration " + migration.name + " must be a single BEGIN ... COMMIT transaction."
    );
  }
}

async function ensureHistoryTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      baseline BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
}

async function readApplied(client) {
  const result = await client.query(
    `SELECT version, name, checksum, applied_at, baseline
     FROM public.schema_migrations
     ORDER BY version`
  );
  return result.rows;
}

function assertAppliedFilesUnchanged(applied, migrationsByVersion) {
  for (const row of applied) {
    const migration = migrationsByVersion.get(row.version);
    if (!migration) {
      throw new Error(
        `Migration ${row.version} (${row.name}) is recorded in the database but its file is missing from the repository.`
      );
    }

    if (migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(
        `Migration ${row.version} has changed after being applied. ${row.name} is recorded with checksum ${row.checksum}, but the repository contains ${migration.name} with checksum ${migration.checksum}. Restore the applied file or create a new migration.`
      );
    }
  }
}

async function acquireLock(client) {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [ADVISORY_LOCK_KEY]);
}

async function releaseLock(client) {
  await client.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_KEY]);
}

async function status(client, migrations) {
  await ensureHistoryTable(client);
  const applied = await readApplied(client);
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  assertAppliedFilesUnchanged(applied, migrationsByVersion);

  console.log("Sizlio POS migration status");
  console.log("--------------------------------");
  for (const migration of migrations) {
    const row = appliedByVersion.get(migration.version);
    if (!row) {
      console.log(`PENDING   ${migration.name}`);
    } else {
      console.log(`${row.baseline ? "BASELINE " : "APPLIED   "}${migration.name}  ${row.applied_at.toISOString()}`);
    }
  }
}

async function apply(client, migrations) {
  await ensureHistoryTable(client);
  const applied = await readApplied(client);
  const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  assertAppliedFilesUnchanged(applied, migrationsByVersion);

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));

  if (!pending.length) {
    console.log("✅ Database is already up to date.");
    return;
  }

  for (const migration of pending) {
    assertTransactional(migration);
    console.log(`⏳ Applying ${migration.name}...`);

    await client.query(migration.sql);

    await client.query(
      `INSERT INTO public.schema_migrations
         (version, name, checksum, baseline)
       VALUES ($1, $2, $3, FALSE)`,
      [migration.version, migration.name, migration.checksum]
    );

    console.log(`✅ Applied ${migration.name}`);
  }
}

async function applyOne(client, migrations, versionArg) {
  const targetVersion = Number(String(versionArg || "").replace(/^0+/, "") || "0");

  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new Error("Specify one migration version, e.g. npm run migrate:one -- 001.");
  }

  const migration = migrations.find((item) => item.version === targetVersion);
  if (!migration) {
    throw new Error(`Migration version ${versionArg} was not found.`);
  }

  await ensureHistoryTable(client);
  const applied = await readApplied(client);
  const migrationsByVersion = new Map(migrations.map((item) => [item.version, item]));
  assertAppliedFilesUnchanged(applied, migrationsByVersion);

  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  if (appliedByVersion.has(targetVersion)) {
    console.log(`✅ ${migration.name} is already recorded as applied.`);
    return;
  }

  const earlierPending = migrations.filter(
    (item) => item.version < targetVersion && !appliedByVersion.has(item.version)
  );
  if (earlierPending.length) {
    throw new Error(
      `Cannot apply ${migration.name} while earlier migrations are pending: ${earlierPending.map((item) => item.name).join(", ")}. Apply or explicitly baseline earlier migrations only after verifying the live schema.`
    );
  }

  assertTransactional(migration);
  console.log(`⏳ Applying only ${migration.name}...`);
  await client.query(migration.sql);
  await client.query(
    `INSERT INTO public.schema_migrations
       (version, name, checksum, baseline)
     VALUES ($1, $2, $3, FALSE)`,
    [migration.version, migration.name, migration.checksum]
  );
  console.log(`✅ Applied ${migration.name}`);
}

async function baseline(client, migrations, versionArg) {
  const targetVersion = Number(versionArg);

  if (!Number.isInteger(targetVersion) || targetVersion < 0) {
    throw new Error("Baseline version must be a non-negative integer, e.g. --baseline 016.");
  }

  const selected = migrations.filter((migration) => migration.version <= targetVersion);

  if (!selected.length) {
    throw new Error(`No migration exists at or below baseline version ${targetVersion}.`);
  }

  await ensureHistoryTable(client);
  const applied = await readApplied(client);
  const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  assertAppliedFilesUnchanged(applied, migrationsByVersion);

  const appliedVersions = new Set(applied.map((row) => row.version));
  const missing = selected.filter((migration) => !appliedVersions.has(migration.version));

  if (!missing.length) {
    console.log(`✅ Database is already baselined through ${targetVersion}.`);
    return;
  }

  console.warn("");
  console.warn("⚠️  BASELINE MODE DOES NOT RUN SQL.");
  console.warn("It records migrations as already applied because the database");
  console.warn("must already contain the schema represented by those migrations.");
  console.warn("");

  for (const migration of missing) {
    await client.query(
      `INSERT INTO public.schema_migrations
         (version, name, checksum, baseline)
       VALUES ($1, $2, $3, TRUE)`,
      [migration.version, migration.name, migration.checksum]
    );
    console.log(`📝 Baselined ${migration.name}`);
  }

  console.log(`✅ Baseline recorded through migration ${targetVersion}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "up";
  const migrations = getMigrations();

  assertUniqueVersions(migrations);

  const client = await pool.connect();

  try {
    await acquireLock(client);

    if (command === "status") {
      await status(client, migrations);
    } else if (command === "up") {
      await apply(client, migrations);
    } else if (command === "one") {
      await applyOne(client, migrations, args[1]);
    } else if (command === "baseline") {
      await baseline(client, migrations, args[1]);
    } else {
      throw new Error(
        `Unknown command "${command}". Use: up | status | one <version> | baseline <version>`
      );
    }
  } finally {
    try {
      await releaseLock(client);
    } catch (err) {
      console.error("Could not release migration advisory lock:", err.message);
    }
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Migration command failed:", err.message);
  process.exitCode = 1;
});
