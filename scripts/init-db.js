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

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);

const relPath = path.relative(process.cwd(), DB_PATH);
console.log(`Initialized ${tables.length} tables at ${relPath}:`);
for (const t of tables) console.log(`  - ${t}`);

db.close();
