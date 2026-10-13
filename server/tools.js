/**
 * Maintenance tools.
 *   npm run export  -> orders + products as CSV files in data/exports/ (open in Excel)
 *
 * NOTE: The `backup` command is no longer available – the database is now Postgres (Supabase).
 * Use your Supabase dashboard → Storage → Backups, or pg_dump, to take database backups.
 */
'use strict';
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

/* ── .env loader ── */
try {
  for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l);
    if (m && !l.trim().startsWith('#') && !process.env[m[1]])
      process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const day  = new Date().toISOString().slice(0, 10);
const cmd  = process.argv[2];

const csv = (rows) =>
  '\ufeff' +
  rows.map((r) => r.map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');

(async () => {
  if (cmd === 'backup') {
    console.log(
      'The backup command is not available for Postgres.\n' +
      'Use Supabase dashboard → Database → Backups, or run:\n' +
      '  pg_dump $DATABASE_URL > vsd-backup.sql',
    );
    await pool.end();
    return;
  }

  if (cmd === 'export') {
    const dir = path.join(DATA, 'exports');
    fs.mkdirSync(dir, { recursive: true });

    const orderRows = (await pool.query('SELECT j FROM orders ORDER BY created')).rows;
    const orders = orderRows.map((r) => r.j);
    fs.writeFileSync(
      path.join(dir, `orders-${day}.csv`),
      csv([
        ['Order','Date','Customer','Phone','Email','Address','Items','Subtotal','Shipping','Total','Payment','Status','India Post tracking'],
        ...orders.map((o) => [
          o.no, o.d.slice(0,16).replace('T',' '), o.cust, o.phone, o.email, o.addr,
          o.items.map((i) => `${i.q} x ${i.n}`).join('; '),
          o.sub, o.ship, o.tot, o.pay, o.st, o.track,
        ]),
      ]),
    );

    const catRow = await pool.query(`SELECT v FROM doc WHERE k='catalog'`);
    if (!catRow.rows.length) { console.error('No catalog found.'); await pool.end(); return; }
    const cat = catRow.rows[0].v;
    fs.writeFileSync(
      path.join(dir, `products-${day}.csv`),
      csv([
        ['Product','Category','Size','MRP','Price','Stock','Low-stock limit','Active'],
        ...cat.prods.flatMap((p) =>
          p.v.map((v) => [p.n, p.c, v.w, v.mrp, v.p, v.s, v.low, p.on ? 'yes' : 'no']),
        ),
      ]),
    );

    console.log(`Exported ${orders.length} orders and ${cat.prods.length} products to ${dir}`);
    await pool.end();
    return;
  }

  console.log('Usage: npm run export');
  await pool.end();
})();
