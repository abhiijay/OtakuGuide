// scripts/init-db.js
// Creates db/otakuguide.sqlite (if missing) and runs db/schema.sql.
// Idempotent: re-running won't drop tables — every CREATE has IF NOT EXISTS.
// Run with: npm run init-db

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'db', 'otakuguide.sqlite');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.exec(schema);

// Lightweight migrations for columns added after a DB was first initialized.
// CREATE TABLE IF NOT EXISTS never alters an existing table, so a column added
// to schema.sql later won't appear on an already-created DB. Each entry here is
// idempotent: we only ALTER when the column is actually missing. Re-running
// init-db is therefore always safe.
const COLUMN_MIGRATIONS = [
  // Added 2026-06-14 with the profile/avatar UI.
  { table: 'users', column: 'avatar', ddl: 'ALTER TABLE users ADD COLUMN avatar TEXT' },
];
for (const m of COLUMN_MIGRATIONS) {
  const exists = db
    .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
    .get(m.table, m.column);
  if (!exists) {
    db.exec(m.ddl);
    console.log(`Migrated: added ${m.table}.${m.column}`);
  }
}

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);

const relPath = path.relative(process.cwd(), DB_PATH);
console.log(`Initialized ${tables.length} tables at ${relPath}:`);
for (const t of tables) console.log(`  - ${t}`);

db.close();
