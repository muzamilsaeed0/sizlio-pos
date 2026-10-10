const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const runnerPath = path.join(__dirname, "..", "scripts", "migrate.js");
const source = fs.readFileSync(runnerPath, "utf8");

test("migration schema SQL and history row share one transaction", () => {
  const start = source.indexOf("async function runMigrationAndRecord(");
  const end = source.indexOf("\nasync function ensureHistoryTable(", start);
  assert.notEqual(start, -1, "transaction helper exists");
  assert.notEqual(end, -1, "transaction helper has a bounded source region");

  const helper = source.slice(start, end);
  const begin = helper.indexOf('await client.query("BEGIN")');
  const migrationSql = helper.indexOf("await client.query(body)");
  const historyInsert = helper.indexOf("INSERT INTO public.schema_migrations");
  const commit = helper.indexOf('await client.query("COMMIT")');
  const rollback = helper.indexOf('await client.query("ROLLBACK")');

  assert.ok(begin >= 0, "opens an explicit transaction");
  assert.ok(migrationSql > begin, "runs migration SQL inside the transaction");
  assert.ok(historyInsert > migrationSql, "records history after schema SQL");
  assert.ok(commit > historyInsert, "commits only after recording history");
  assert.ok(rollback > commit, "rolls back on failure");
});

test("bulk and single-migration commands use the atomic helper", () => {
  const applyStart = source.indexOf("async function apply(client, migrations)");
  const oneStart = source.indexOf("async function applyOne(client, migrations, versionArg)");
  const baselineStart = source.indexOf("async function baseline(client, migrations, versionArg)");
  assert.ok(applyStart >= 0 && oneStart > applyStart && baselineStart > oneStart);

  const applyBody = source.slice(applyStart, oneStart);
  const oneBody = source.slice(oneStart, baselineStart);

  assert.match(applyBody, /runMigrationAndRecord\(client, migration, false\)/);
  assert.match(oneBody, /runMigrationAndRecord\(client, migration, false\)/);
  assert.doesNotMatch(applyBody, /client\.query\(migration\.sql\)/);
  assert.doesNotMatch(oneBody, /client\.query\(migration\.sql\)/);
});
