// src/db.js
// Single SQLite connection for the whole process. All other modules
// `require('./db')` instead of opening their own handle.
//
// Pragmas:
//   foreign_keys = ON   — enforces FK CASCADE behavior (off by default in SQLite)
//   journal_mode = WAL  — write-ahead log; better concurrent-read throughput
//
// sqlite-vec is loaded so future vector queries (vec_distance_cosine, etc.)
// work without per-route setup.
//
// NOTE on the adult-content filter (decision 2026-06-08):
// Every public catalog query must filter on anime.is_adult = 0. We will add
// the wrapper helpers here when we start writing those queries; until then
// this file is just connection setup.

const path = require('path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const DB_PATH = path.join(__dirname, '..', 'db', 'otakuguide.sqlite');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
sqliteVec.load(db);

module.exports = { db };
