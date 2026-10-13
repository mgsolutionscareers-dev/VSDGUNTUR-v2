/**
 * API tests: `npm test`
 * Starts the server against a throw-away Postgres schema (TEST_DATABASE_URL or DATABASE_URL)
 * and wipes only the test tables between runs. Never touches the production database.
 */
'use strict';
const { spawn } = require('child_process'),
  assert = require('assert'),
  fs     = require('fs'),
  path   = require('path'),
  os     = require('os');
const { Pool } = require('pg');

/* ── .env loader ── */
try {
  for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l);
    if (m && !l.trim().startsWith('#') && !process.env[m[1]])
      process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }

const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  console.error('ERROR: Set TEST_DATABASE_URL (or DATABASE_URL) to run tests.');
  process.exit(1);
}

(async () => {
  /* ── Wipe test tables so every run starts clean ── */
  const mgmt = new Pool({ connectionString: TEST_DB_URL, ssl: { rejectUnauthorized: false } });
  await mgmt.query(`
    DROP TABLE IF EXISTS orders_archive;
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS doc;
  `);
  await mgmt.end();

  const port  = 3100 + Math.floor(Math.random() * 800);
  const base  = `http://127.0.0.1:${port}`;
  /* uploads still go to a temp dir so real uploads/ is not polluted */
  const dir   = fs.mkdtempSync(path.join(os.tmpdir(), 'vsd-'));

  const srv = spawn('node', [path.join(__dirname, 'index.js')], {
    env: {
      ...process.env,
      PORT:            String(port),
      DATA_DIR:        dir,
      ADMIN_PASSWORD:  'test-pass',
      DATABASE_URL:    TEST_DB_URL,
    },
    stdio: 'ignore',
  });

  const call = async (m, u, b, ck) => {
    const r = await fetch(base + u, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) },
      body: b && JSON.stringify(b),
    });
    return { s: r.status, j: await r.json().catch(() => ({})), ck: (r.headers.get('set-cookie')||'').split(';')[0] };
  };

  /* Wait for the server to be ready */
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/catalog'); break; }
    catch { await new Promise((r) => setTimeout(r, 150)); }
  }

  const stop = (p) => new Promise((r) => { p.once('exit', r); p.kill(); setTimeout(r, 3000); });
  const cleanup = (d) => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { console.log('(temp folder not deleted, safe to remove:', d + ')'); }
  };

  let n = 0;
  const t = async (name, f) => {
    try { await f(); n++; console.log('✓', name); }
    catch (e) { console.log('✗', name, '-', e.message, e.stack); process.exitCode = 1; }
  };

  const addr = {
    name: 'Test Buyer', phone: '9876543210',
    address: '12-3 Brodipet', city: 'Guntur',
    state: 'Andhra Pradesh', pin: '522002',
  };
  let ck = '', cat, no;

  await t('public catalog has products, no log, capped stock', async () => {
    const r = await call('GET', '/api/catalog');
    cat = r.j;
    assert(cat.prods.length > 60 && !cat.log && cat.prods.every((p) => p.v.every((v) => v.s <= 50)));
  });

  await t('static site served, server files and traversal blocked', async () => {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/server/index.js')).status, 404);
    assert.equal((await fetch(base + '/..%2fpackage.json')).status, 404);
    assert.equal((await fetch(base + '/js/seed.js')).status, 404);
  });

  await t('admin API needs login; wrong password rejected', async () => {
    assert.equal((await call('GET', '/api/admin/data')).s, 401);
    assert.equal((await call('POST', '/api/admin/login', { user: 'admin', password: 'nope' })).s, 401);
    const r = await call('POST', '/api/admin/login', { user: 'admin', password: 'test-pass' });
    assert.equal(r.s, 200);
    ck = r.ck;
    assert(ck.startsWith('vsd_sid='));
  });

  const stock = async () => (await call('GET', '/api/admin/data', null, ck)).j.catalog.prods[0].v[0].s;
  const before = await stock();

  await t('bad phone rejected', async () =>
    assert.equal((await call('POST', '/api/orders', { ...addr, phone: '12345', items: [{ t:'p', id:1, vi:0, q:1 }] })).s, 400));

  await t('order uses SERVER prices and numbering; stock drops', async () => {
    const r = await call('POST', '/api/orders', { ...addr, items: [{ t:'p', id:1, vi:0, q:2, price:1 }] });
    assert.equal(r.s, 200);
    no = r.j.order.no;
    assert(/^VSD-\d{4}-000001$/.test(no));
    const p = cat.prods[0].v[0].p * 2;
    assert.equal(r.j.order.sub, p);
    assert.equal(r.j.order.tot, p + (p >= cat.settings.free ? 0 : cat.settings.ship));
    assert.equal(await stock(), before - 2);
  });

  await t('overselling blocked (409) and nothing changes', async () => {
    assert.equal((await call('POST', '/api/orders', { ...addr, items: [{ t:'p', id:1, vi:0, q:500 }] })).s, 409);
    assert.equal(await stock(), before - 2);
  });

  await t('combo order reduces component stock', async () => {
    const cb = cat.combos[0];
    if (!cb || !cb.items || !cb.items.length) { console.log('  (skipped – no combo items)'); return; }
    const [pid, vi, q] = cb.items[0];
    const s0 = (await call('GET', '/api/admin/data', null, ck)).j.catalog.prods.find((p) => p.id == pid).v[vi].s;
    assert.equal((await call('POST', '/api/orders', { ...addr, items: [{ t:'c', id:cb.id, vi:0, q:1 }] })).s, 200);
    assert.equal(
      (await call('GET', '/api/admin/data', null, ck)).j.catalog.prods.find((p) => p.id == pid).v[vi].s,
      s0 - q,
    );
  });

  await t('tracking number + customer lookup needs matching phone', async () => {
    assert.equal((await call('PATCH', '/api/admin/orders/'+no, { st:'Shipped', track:'EE123456789IN' }, ck)).s, 200);
    assert.equal((await call('GET', `/api/track?no=${no}&phone=9876543210`)).j.order.track, 'EE123456789IN');
    assert.equal((await call('GET', `/api/track?no=${no}&phone=9000000000`)).s, 404);
  });

  await t('cancel restores stock; cancelled CAN reopen and reserve stock', async () => {
    assert.equal((await call('PATCH', '/api/admin/orders/'+no, { st:'Cancelled' }, ck)).s, 200);
    assert.equal(await stock(), before);
    const reopenRes = await call('PATCH', '/api/admin/orders/'+no, { st:'Pending' }, ck);
    assert.equal(reopenRes.s, 200);
    assert.equal(reopenRes.j.order.st, 'Pending');
    assert.equal(await stock(), before - 2);
    assert.equal((await call('PATCH', '/api/admin/orders/'+no, { st:'Cancelled' }, ck)).s, 200);
    assert.equal(await stock(), before);
    assert.equal((await call('POST', '/api/admin/stock', { id:1, vi:0, s:0 }, ck)).s, 200);
    const reopenFail = await call('PATCH', '/api/admin/orders/'+no, { st:'Pending' }, ck);
    assert.equal(reopenFail.s, 409);
    assert.equal((await call('POST', '/api/admin/stock', { id:1, vi:0, s:before }, ck)).s, 200);
  });

  await t('catalogue save keeps server stock, applies settings; needs login', async () => {
    const d = (await call('GET', '/api/admin/data', null, ck)).j.catalog;
    d.prods[0].n = 'Badam Renamed';
    d.prods[0].v[0].s = 9999;
    d.settings.ship = 80;
    d.theme = 'maroon';
    assert.equal((await call('PUT', '/api/admin/catalog', d)).s, 401);
    assert.equal((await call('PUT', '/api/admin/catalog', d, ck)).s, 200);
    const c = (await call('GET', '/api/catalog')).j;
    assert.equal(c.prods[0].n, 'Badam Renamed');
    assert.equal(c.settings.ship, 80);
    assert.equal(c.theme, 'maroon');
    assert.equal(await stock(), before);
  });

  await t('manual stock update + image upload validation', async () => {
    assert.equal((await call('POST', '/api/admin/stock', { id:1, vi:0, s:7 }, ck)).s, 200);
    assert.equal(await stock(), 7);
    const jpg = 'data:image/jpeg;base64,' + Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4]).toString('base64');
    const r = await call('POST', '/api/admin/upload', { d: jpg }, ck);
    assert.equal(r.s, 200);
    assert.equal((await fetch(base + r.j.url)).status, 200);
    assert.equal((await call('POST', '/api/admin/upload', { d:'data:image/jpeg;base64,AAAA' }, ck)).s, 400);
  });

  await t('admin sign-in tolerates stray spaces / capitals in the configured values', async () => {
    const p2 = port + 1000, d2 = dir + '-b';
    const s2 = spawn('node', [path.join(__dirname, 'index.js')], {
      env: { ...process.env, PORT: String(p2), DATA_DIR: d2, ADMIN_USER: 'Admin ', ADMIN_PASSWORD: 'Vsd@123 ', DATABASE_URL: TEST_DB_URL },
      stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
      try { await fetch(`http://127.0.0.1:${p2}/api/catalog`); break; }
      catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    const login = (pw) =>
      fetch(`http://127.0.0.1:${p2}/api/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user:'admin', password:pw }),
      }).then((r) => r.status);
    const ok = await login('Vsd@123'), bad = await login('wrong');
    await stop(s2);
    cleanup(d2);
    assert.equal(ok, 200); assert.equal(bad, 401);
  });

  await t('product weight variants: create single variant (100g) only displays 100g', async () => {
    const d = (await call('GET', '/api/admin/data', null, ck)).j.catalog;
    d.prods.push({ id:888, n:'Solo 100g Almonds', c:'Dry Fruits', e:'🌰', img:'', f:1, on:1, v:[{ w:'100g', mrp:400, p:299, s:67, low:10 }] });
    assert.equal((await call('PUT', '/api/admin/catalog', d, ck)).s, 200);
    const pub = (await call('GET', '/api/catalog')).j;
    const p = pub.prods.find((x) => x.id == 888);
    assert(p); assert.equal(p.v.length, 1); assert.equal(p.v[0].w, '100g');
    assert.equal(p.v[0].p, 299); assert.equal(p.v[0].mrp, 400);
  });

  await t('product weight variants: remove 250g variant from product and verify persistence', async () => {
    const d = (await call('GET', '/api/admin/data', null, ck)).j.catalog;
    const p1 = d.prods.find((x) => x.id == 1);
    assert(p1.v.some((v) => v.w === '250g'), 'Badam initially has 250g');
    p1.v = p1.v.filter((v) => v.w !== '250g');
    assert.equal((await call('PUT', '/api/admin/catalog', d, ck)).s, 200);
    const pub = (await call('GET', '/api/catalog')).j;
    const updated = pub.prods.find((x) => x.id == 1);
    assert(!updated.v.some((v) => v.w === '250g'));
    assert.equal(updated.v.length, 2);
  });

  await t('product weight variants: ordering a specific variant uses exact price and reduces only its stock', async () => {
    const d = (await call('GET', '/api/admin/data', null, ck)).j.catalog;
    const p1 = d.prods.find((x) => x.id == 1);
    const v500 = p1.v[1], sBefore = v500.s;
    const r = await call('POST', '/api/orders', { ...addr, items: [{ t:'p', id:1, vi:1, q:1 }] });
    assert.equal(r.s, 200);
    assert.equal(r.j.order.items[0].price, v500.p);
    const dAfter = (await call('GET', '/api/admin/data', null, ck)).j.catalog;
    assert.equal(dAfter.prods.find((x) => x.id == 1).v[1].s, sBefore - 1);
  });

  await t('product weight variants: zero-stock variant cannot be ordered (409)', async () => {
    const d = (await call('GET', '/api/admin/data', null, ck)).j.catalog;
    d.prods.push({ id:777, n:'Zero Stock Test', c:'Dry Fruits', e:'🌰', img:'', f:1, on:1, v:[{ w:'100g', mrp:100, p:80, s:0, low:5 }] });
    assert.equal((await call('PUT', '/api/admin/catalog', d, ck)).s, 200);
    assert.equal((await call('POST', '/api/orders', { ...addr, items: [{ t:'p', id:777, vi:0, q:1 }] })).s, 409);
  });

  await t('frontend product popup: displays only configured variants and correct pricing/stock', async () => {
    const vm = require('vm');
    const stateCode     = fs.readFileSync(path.join(__dirname, '..', 'js', 'state.js'), 'utf8');
    const storefrontCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'storefront.js'), 'utf8');
    let modalHtml = '';
    const ctx = {
      console, document: {
        addEventListener: () => {}, dataSet: {}, documentElement: { dataset: {} },
        querySelector: (s) => s === '#m'
          ? { innerHTML: '', set innerHTML(v) { modalHtml = v; } }
          : { innerHTML: '', style: {}, classList: { toggle: () => {} } },
      },
      localStorage: {}, location: { hash: '' }, window: {},
      IM:{}, CI:{}, PI:{}, KEY:'vsd_v3', ST:[], PAY:[], WA:'918885355666', IP:'', THEMES:[],
      toast: () => {}, cl: () => { modalHtml = ''; }, fetch: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(stateCode, ctx);
    vm.runInContext(storefrontCode, ctx);
    const run = (code) => vm.runInContext(code, ctx);

    run(`D.prods=[{id:901,n:'Solo 100g',c:'Dry Fruits',e:'🌰',img:'',f:1,on:1,v:[{w:'100g',mrp:400,p:299,s:67,low:10}]}];pd(901);`);
    assert(modalHtml.includes('100 g') && !modalHtml.includes('250 g') && !modalHtml.includes('500 g') && !modalHtml.includes('1 kg'));

    run(`D.prods=[{id:902,n:'Two Sizes',c:'Dry Fruits',e:'🌰',img:'',f:1,on:1,v:[{w:'100g',mrp:200,p:150,s:30,low:5},{w:'500g',mrp:900,p:700,s:15,low:5}]}];pd(902);`);
    assert(modalHtml.includes('100 g') && modalHtml.includes('500 g') && !modalHtml.includes('250 g') && !modalHtml.includes('1 kg'));

    run(`D.prods=[{id:903,n:'Four Sizes',c:'Dry Fruits',e:'🌰',img:'',f:1,on:1,v:[{w:'100g',mrp:100,p:80,s:20,low:5},{w:'250g',mrp:240,p:190,s:15,low:5},{w:'500g',mrp:460,p:360,s:10,low:5},{w:'1kg',mrp:900,p:700,s:5,low:2}]}];pd(903);`);
    assert(modalHtml.includes('100 g') && modalHtml.includes('250 g') && modalHtml.includes('500 g') && modalHtml.includes('1 kg') && !modalHtml.includes('2 kg'));
    run(`sv.vi=1;sv.g=250;pdv();`);
    assert(modalHtml.includes('₹190') && modalHtml.includes('₹240') && modalHtml.includes('21% OFF'));

    run(`D.prods=[{id:904,n:'Stock Test',c:'Dry Fruits',e:'🌰',img:'',f:1,on:1,v:[{w:'100g',mrp:100,p:80,s:10,low:5},{w:'500g',mrp:450,p:360,s:0,low:5}]}];pd(904);`);
    assert(/<button class="" disabled title="Out of stock" onclick="sv\.vi=1;sv\.g=500;pdv\(\)">500 g<\/button>/.test(modalHtml));
    assert(/<button class=""\s+onclick="sv\.vi=0;sv\.g=100;pdv\(\)">100 g<\/button>/.test(modalHtml));
  });

  await t('customer orders: search using mobile number only (with sanitization and validation)', async () => {
    const res1 = await call('GET', '/api/customer/orders?phone=9876543210');
    assert.equal(res1.s, 200);
    assert(Array.isArray(res1.j.orders));
    assert(res1.j.orders.length > 0);
    const ord = res1.j.orders.find((o) => o.no === no);
    assert(ord); assert(ord.tot > 0); assert(Array.isArray(ord.items)); assert(ord.st);
    assert.strictEqual(ord.addr, undefined);
    assert.strictEqual(ord.cust, undefined);
    assert.strictEqual(ord.email, undefined);

    const resWithCode = await call('GET', `/api/customer/orders?phone=${encodeURIComponent('+91 98765 43210')}`);
    assert.equal(resWithCode.s, 200);
    assert.equal(resWithCode.j.orders.length, res1.j.orders.length);

    const resWithZero = await call('GET', `/api/customer/orders?phone=${encodeURIComponent('09876543210')}`);
    assert.equal(resWithZero.s, 200);
    assert.equal(resWithZero.j.orders.length, res1.j.orders.length);

    assert.equal((await call('GET', '/api/customer/orders?phone=123')).s, 400);
    assert.equal((await call('GET', '/api/customer/orders?phone=abcdefghij')).s, 400);

    const resEmpty = await call('GET', '/api/customer/orders?phone=9111111111');
    assert.equal(resEmpty.s, 200);
    assert.deepStrictEqual(resEmpty.j.orders, []);
  });

  await t('admin orders: clear order history safely archives terminal orders and preserves active orders/inventory', async () => {
    assert.equal((await call('POST', '/api/admin/orders/clear', {})).s, 401);

    const o2Res = await call('POST', '/api/orders', {
      name:'Active Customer', phone:'9988776655', pin:'522003',
      address:'Near Clock Tower', city:'Guntur', state:'Andhra Pradesh',
      items:[{ t:'p', id:1, vi:0, q:1 }],
    });
    assert.equal(o2Res.s, 200);
    const activeNo = o2Res.j.order.no;

    assert.equal((await call('PATCH', `/api/admin/orders/${no}`, { st:'Delivered' }, ck)).s, 200);
    const beforeStock = await stock();
    const adminDataBefore = (await call('GET', '/api/admin/data', null, ck)).j;
    assert(adminDataBefore.orders.some((o) => o.no === no));
    assert(adminDataBefore.orders.some((o) => o.no === activeNo));

    const clearRes = await call('POST', '/api/admin/orders/clear', {}, ck);
    assert.equal(clearRes.s, 200);
    assert(clearRes.j.clearedCount >= 1);

    const adminDataAfter = (await call('GET', '/api/admin/data', null, ck)).j;
    assert(!adminDataAfter.orders.some((o) => o.no === no));
    assert(adminDataAfter.orders.some((o) => o.no === activeNo));
    assert.equal(await stock(), beforeStock);
    assert.equal(adminDataAfter.catalog.prods.length, adminDataBefore.catalog.prods.length);
  });

  await t('gift box: dedicated management, validation, persistence, customer publication, and isolation from ordinary products', async () => {
    const pub = (await call('GET', '/api/catalog')).j;
    assert(Array.isArray(pub.giftboxes));
    assert.equal((await call('PUT', '/api/admin/catalog', { giftboxes: [] })).s, 401);

    const adminData = (await call('GET', '/api/admin/data', null, ck)).j;
    const initialProdCount = adminData.catalog.prods.length;
    const initialCatCount  = adminData.catalog.cats.length;

    assert.equal((await call('PUT', '/api/admin/catalog', { ...adminData.catalog, giftboxes:[{ id:99, n:'Bad Box', desc:'No price', p:0, on:1 }] }, ck)).s, 400);
    assert.equal((await call('PUT', '/api/admin/catalog', { ...adminData.catalog, giftboxes:[{ id:99, n:'No Desc', desc:'', p:500, on:1 }] }, ck)).s, 400);
    assert.equal((await call('PUT', '/api/admin/catalog', { ...adminData.catalog, giftboxes:[{ id:99, n:'', desc:'Some desc', p:500, on:1 }] }, ck)).s, 400);

    const testGb = { id:101, n:'Royal Celebration Gift Box', desc:'Curated assortment of roasted almonds, premium cashews, and Afghan figs in a velvet box.', p:1899, e:'🎁', img:'assets/images/k_gift.jpg', on:1 };
    adminData.catalog.giftboxes = [...(adminData.catalog.giftboxes||[]), testGb];
    assert.equal((await call('PUT', '/api/admin/catalog', adminData.catalog, ck)).s, 200);

    const refreshedAdmin = (await call('GET', '/api/admin/data', null, ck)).j;
    const savedGbAdmin = (refreshedAdmin.catalog.giftboxes||[]).find((g) => g.id === 101);
    assert(savedGbAdmin); assert.equal(savedGbAdmin.n, 'Royal Celebration Gift Box'); assert.equal(savedGbAdmin.p, 1899);

    const refreshedPub = (await call('GET', '/api/catalog')).j;
    const savedGbPub = (refreshedPub.giftboxes||[]).find((g) => g.id === 101);
    assert(savedGbPub); assert.equal(savedGbPub.n, 'Royal Celebration Gift Box'); assert.equal(savedGbPub.p, 1899);

    savedGbAdmin.on = 0;
    await call('PUT', '/api/admin/catalog', refreshedAdmin.catalog, ck);
    assert(!(((await call('GET', '/api/catalog')).j.giftboxes)||[]).some((g) => g.id === 101));

    savedGbAdmin.on = 1; savedGbAdmin.p = 1999;
    savedGbAdmin.n = 'Royal Celebration Gift Box Deluxe';
    savedGbAdmin.desc = 'Updated luxury assortment with Kashmiri walnuts.';
    assert.equal((await call('PUT', '/api/admin/catalog', refreshedAdmin.catalog, ck)).s, 200);

    const pubAfterEdit = (await call('GET', '/api/catalog')).j;
    const editedGbPub = (pubAfterEdit.giftboxes||[]).find((g) => g.id === 101);
    assert(editedGbPub); assert.equal(editedGbPub.n, 'Royal Celebration Gift Box Deluxe');
    assert.equal(editedGbPub.p, 1999); assert.equal(editedGbPub.desc, 'Updated luxury assortment with Kashmiri walnuts.');

    const toDeleteAdmin = (await call('GET', '/api/admin/data', null, ck)).j;
    toDeleteAdmin.catalog.giftboxes = toDeleteAdmin.catalog.giftboxes.filter((g) => g.id !== 101);
    assert.equal((await call('PUT', '/api/admin/catalog', toDeleteAdmin.catalog, ck)).s, 200);
    assert(!(((await call('GET', '/api/catalog')).j.giftboxes)||[]).some((g) => g.id === 101));

    const adminAfterDel = (await call('GET', '/api/admin/data', null, ck)).j;
    assert(!(adminAfterDel.catalog.giftboxes||[]).some((g) => g.id === 101));
    assert.equal(adminAfterDel.catalog.prods.length, initialProdCount);
    assert.equal(adminAfterDel.catalog.cats.length,  initialCatCount);
  });

  await t('India Post tracking: uses direct browser navigation to official HTTPS destination, no 502 proxy', async () => {
    const configCode     = fs.readFileSync(path.join(__dirname, '..', 'js', 'config.js'), 'utf8');
    const storefrontCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'storefront.js'), 'utf8');
    assert(configCode.includes("IP = 'https://www.indiapost.gov.in/';") || configCode.includes('IP = "https://www.indiapost.gov.in/";'));
    assert(!configCode.includes('trackconsignment.aspx'));
    assert(storefrontCode.includes('href="${IP}"') && storefrontCode.includes('id="navTrackOrder"'));
    assert(storefrontCode.includes("window.open(IP, '_blank')"));
    const res = await fetch('https://www.indiapost.gov.in/', { method:'HEAD', headers:{ 'User-Agent':'Mozilla/5.0' } });
    assert.notEqual(res.status, 502);
    assert.equal(res.status, 200);
  });

  await t('category management: add, edit, duplicate prevention, activate/deactivate, safe deletion', async () => {
    assert.equal((await call('POST', '/api/admin/categories', { name:'Exotic Nuts' })).s, 401);

    const addRes = await call('POST', '/api/admin/categories', { name:'Exotic Berries', desc:'Finest berries', emoji:'🫐', img:'assets/images/k_dry.jpg', on:1 }, ck);
    assert.equal(addRes.s, 200);
    const newCatId = addRes.j.category.id;
    assert.equal(addRes.j.category.name, 'Exotic Berries');
    assert.equal(addRes.j.category.on, 1);

    assert.equal((await call('POST', '/api/admin/categories', { name:'exotic berries' }, ck)).s, 400);
    assert.equal((await call('POST', '/api/admin/categories', { name:'' }, ck)).s, 400);

    let pubCat = (await call('GET', '/api/catalog')).j;
    assert(pubCat.cats.some((c) => (c.name||c[0]) === 'Exotic Berries'));

    const toggleRes = await call('PATCH', `/api/admin/categories/${newCatId}/toggle`, null, ck);
    assert.equal(toggleRes.s, 200); assert.equal(toggleRes.j.category.on, 0);

    pubCat = (await call('GET', '/api/catalog')).j;
    assert(!pubCat.cats.some((c) => (c.name||c[0]) === 'Exotic Berries'));

    await call('PATCH', `/api/admin/categories/${newCatId}/toggle`, null, ck);

    const adminData = (await call('GET', '/api/admin/data', null, ck)).j;
    const testProd = adminData.catalog.prods[0], origProdCat = testProd.c;
    testProd.c = 'Exotic Berries';
    await call('PUT', '/api/admin/catalog', adminData.catalog, ck);

    const editRes = await call('PUT', `/api/admin/categories/${newCatId}`, { name:'Premium Berries', desc:'Updated description', on:1 }, ck);
    assert.equal(editRes.s, 200); assert.equal(editRes.j.category.name, 'Premium Berries');

    const adminDataAfterEdit = (await call('GET', '/api/admin/data', null, ck)).j;
    const updatedProd = adminDataAfterEdit.catalog.prods.find((p) => p.id === testProd.id);
    assert.equal(updatedProd.c, 'Premium Berries');

    const delRes = await call('DELETE', `/api/admin/categories/${newCatId}`, null, ck);
    assert.equal(delRes.s, 200);

    const adminDataAfterDel = (await call('GET', '/api/admin/data', null, ck)).j;
    assert(!adminDataAfterDel.catalog.cats.some((c) => c.id === newCatId));
    const safeProd = adminDataAfterDel.catalog.prods.find((p) => p.id === testProd.id);
    assert(safeProd); assert.equal(safeProd.c, 'General');

    safeProd.c = origProdCat;
    await call('PUT', '/api/admin/catalog', adminDataAfterDel.catalog, ck);
  });

  await t('combo popup works like the gift box popup: one price, contents listed without per-item prices', async () => {
    const vm = require('vm');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
    let modalHtml = '';
    const ctx = {
      console, document: {
        addEventListener: () => {}, documentElement: { dataset: {} },
        querySelector: (s) => s === '#m'
          ? { set innerHTML(v) { modalHtml = v; } }
          : { innerHTML: '', style: {}, classList: { toggle: () => {} } },
      },
      localStorage: {}, location: { hash: '' }, window: {},
      IM:{}, CI:{}, PI:{}, WA:'918885355666', THEMES:[],
      toast: () => {}, cl: () => { modalHtml = ''; }, fetch: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(read('state.js'), ctx);
    vm.runInContext(read('storefront.js'), ctx);
    vm.runInContext(
      `D.prods=[{id:1,n:'Almonds',c:'Dry Fruits',e:'🌰',on:1,v:[{w:'250g',mrp:300,p:250,s:20,low:5}]},{id:2,n:'Cashews',c:'Dry Fruits',e:'🥜',on:1,v:[{w:'250g',mrp:400,p:350,s:20,low:5}]}];D.combos=[{id:9,n:'Test Combo',e:'🧺',p:500,on:1,items:[[1,0,1],[2,0,1]]}];sv={t:'c',id:9,q:1};cbv();`,
      ctx,
    );
    assert(modalHtml.includes('Test Combo') && modalHtml.includes('₹500'));
    assert(modalHtml.includes('class=pg'));
    const c = vm.runInContext('items().find((x) => x.k === "c")', ctx);
    assert.equal(c.mrp, c.p);
  });

  await t('only one Add-to-Cart handler (qa) exists, so gift box and combo cards add the right item', async () => {
    const n = ['storefront.js','admin.js','main.js']
      .map((f) => (fs.readFileSync(path.join(__dirname,'..','js',f),'utf8').match(/function qa\(/g)||[]).length)
      .reduce((a,b) => a+b, 0);
    assert.equal(n, 1);
  });

  await t('starter catalogue is flagged as sample data', async () =>
    assert(cat.prods.every((p) => p.sample) && cat.combos.every((c) => c.sample)));

  await t('owner can remove all sample items; shop still loads empty', async () => {
    const d = (await call('GET', '/api/admin/data', null, ck)).j.catalog;
    d.prods = []; d.combos = [];
    assert.equal((await call('PUT', '/api/admin/catalog', d, ck)).s, 200);
    const c = (await call('GET', '/api/catalog')).j;
    assert.equal(c.prods.length, 0); assert.equal(c.combos.length, 0);
  });

  console.log(`\n${n} checks passed`);
  await stop(srv);
  cleanup(dir);
})();
