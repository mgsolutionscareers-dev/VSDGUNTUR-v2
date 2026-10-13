/**
 * One-time migration: copies doc, orders and orders_archive from
 * the local SQLite file (data/vsd.db) into Postgres (DATABASE_URL).
 *
 * Safe to re-run – uses INSERT … ON CONFLICT DO UPDATE so existing rows
 * are overwritten with the SQLite version (SQLite wins).
 *
 * Usage:
 *   node server/migrate-sqlite-to-pg.js
 *   node server/migrate-sqlite-to-pg.js --data-dir /var/lib/vsd
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Pool }         = require('pg');

/* ── .env loader ── */
try {
  for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l);
    if (m && !l.trim().startsWith('#') && !process.env[m[1]])
      process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }

/* ── Args ── */
const ddIdx = process.argv.indexOf('--data-dir');
const DATA  = ddIdx !== -1 ? process.argv[ddIdx + 1] : (process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const DB    = path.join(DATA, 'vsd.db');

if (!fs.existsSync(DB)) {
  console.error(`SQLite file not found: ${DB}`);
  console.error('Pass --data-dir /path/to/data if your database is elsewhere.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const sqlite = new DatabaseSync(DB);
const pg     = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  /* ── Ensure tables exist ── */
  await pg.query(`
    CREATE TABLE IF NOT EXISTS doc (
      k TEXT PRIMARY KEY,
      v JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      no      TEXT PRIMARY KEY,
      created TEXT NOT NULL,
      phone   TEXT NOT NULL,
      j       JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_orders_created ON orders(created);
    CREATE INDEX IF NOT EXISTS ix_orders_phone   ON orders(phone);
    CREATE TABLE IF NOT EXISTS orders_archive (
      no          TEXT PRIMARY KEY,
      created     TEXT NOT NULL,
      phone       TEXT NOT NULL,
      j           JSONB NOT NULL,
      archived_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_orders_archive_created ON orders_archive(created);
  `);

  /* ── Migrate doc ── */
  const docRows = sqlite.prepare('SELECT k, v FROM doc').all();
  let docCount = 0;
  for (const row of docRows) {
    const val = JSON.parse(row.v);   // SQLite stores as TEXT, Postgres wants object
    await pg.query(
      `INSERT INTO doc(k,v) VALUES($1,$2)
       ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`,
      [row.k, val],
    );
    docCount++;
  }
  console.log(`doc: migrated ${docCount} row(s)`);

  /* ── Migrate orders ── */
  const orderRows = sqlite.prepare('SELECT no, created, phone, j FROM orders').all();
  let orderCount = 0;
  for (const row of orderRows) {
    const j = JSON.parse(row.j);
    await pg.query(
      `INSERT INTO orders(no,created,phone,j) VALUES($1,$2,$3,$4)
       ON CONFLICT(no) DO UPDATE SET j=EXCLUDED.j`,
      [row.no, row.created, row.phone, j],
    );
    orderCount++;
  }
  console.log(`orders: migrated ${orderCount} row(s)`);

  /* ── Migrate orders_archive (table may not exist in older SQLite DBs) ── */
  let archiveCount = 0;
  try {
    const archiveRows = sqlite.prepare('SELECT no, created, phone, j, archived_at FROM orders_archive').all();
    for (const row of archiveRows) {
      const j = JSON.parse(row.j);
      await pg.query(
        `INSERT INTO orders_archive(no,created,phone,j,archived_at) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(no) DO UPDATE SET j=EXCLUDED.j, archived_at=EXCLUDED.archived_at`,
        [row.no, row.created, row.phone, j, row.archived_at],
      );
      archiveCount++;
    }
  } catch {
    /* orders_archive didn't exist yet in this SQLite DB – skip */
  }
  console.log(`orders_archive: migrated ${archiveCount} row(s)`);

  console.log('\nMigration complete. You can now start the server with Postgres.');
  await pg.end();
})().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
