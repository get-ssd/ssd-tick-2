// test/mock-verify.js — drive the REAL installed tick2 against socialmedia-mock.
//
// Attaches to a real browser profile where tick2 (id oikj…) is installed and
// loads from dist/chrome. The target browser MUST be closed first (single-
// instance lock + debug port). Launching it fresh loads the current dist/chrome,
// so rebuild dist before running if the extension changed.
//
//   node test/mock-verify.js                 # Brave (default)
//   node test/mock-verify.js --browser=chromium
//   node test/mock-verify.js --close         # auto-close the browser at the end
//
// Seeds Alice + Bob key cards NON-destructively (adds only if absent), then
// loads every mock platform and reports each post's badge vs its expected
// verdict. Carol is never seeded → she must read KEY_UNREACHABLE.

const puppeteer = require('./node_modules/puppeteer-core');
const path      = require('path');
const os        = require('os');
const { spawn } = require('child_process');

const EXT_ID = 'oikjghlmjiapoliomcdnkfbkkfcoellh';   // same id in Brave & Chromium (same dist/chrome path)
const PORT   = 9500;
const BASE   = 'http://localhost:10117/social-mock';
const KEEP_OPEN = !process.argv.includes('--close');

const BROWSERS = {
  brave: {
    exe: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    userData: path.join(os.homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'),
  },
  chromium: {
    exe: 'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    userData: path.join(os.homedir(), 'AppData', 'Local', 'Chromium', 'User Data'),
  },
};
const WHICH = (process.argv.find(a => a.startsWith('--browser=')) || '--browser=brave').split('=')[1];

// Telegram/WhatsApp render one signer per channel/chat, so each needs several URLs.
const PLATFORMS = [
  { name: 'Facebook', expect: '.fb-expect', container: '.fb-post',              urls: [`${BASE}/facebook`] },
  { name: 'X',        expect: '.x-expect',  container: '.x-cell',               urls: [`${BASE}/x`] },
  { name: 'Reddit',   expect: '.rd-expect', container: '.rd-post',              urls: [`${BASE}/reddit`] },
  { name: 'Telegram', expect: '.tg-expect', container: '.tgme_widget_message',
    urls: [`${BASE}/telegram/alice_mock`, `${BASE}/telegram/bob_mock`, `${BASE}/telegram/carol_mock`] },
  { name: 'WhatsApp', expect: '.wa-expect', container: '.message-in',
    urls: [`${BASE}/whatsapp/15550000001`, `${BASE}/whatsapp/15550000002`, `${BASE}/whatsapp/15550000003`] },
];

const SEED = {
  A485141D: { hash8: 'A485141D', name: 'Alice Mockford', public_key: 'hvNIFTAstyZAn7rhCxZhRwDS_xIf34sGcSL7eNh2C0w',
              signing_algorithm: 'Ed25519', issued: '2026-07-21', expires: null, self_signed: null,
              imported_at: new Date().toISOString(), source: 'direct', vouched_by: null, bundle_name: null,
              credibility: null, vault: null, token_default: null },
  '0D1CBB3A': { hash8: '0D1CBB3A', name: 'Bob Mocksmith', public_key: 'ph4B0RgRDcFqTCwZQ-e3kiptXjW7dCtsMay16o7z-Ww',
              signing_algorithm: 'Ed25519', issued: '2026-07-21', expires: null, self_signed: null,
              imported_at: new Date().toISOString(), source: 'direct', vouched_by: null, bundle_name: null,
              credibility: null, vault: null, token_default: null },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connectBrowser(cfg) {
  const proc = spawn(cfg.exe, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${cfg.userData}`,
    '--restore-last-session=false', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { detached: false, stdio: 'ignore' });
  proc.on('error', err => { console.error('Browser failed to start:', err); process.exit(1); });
  for (let i = 1; i <= 20; i++) {
    await sleep(1000);
    try { return { browser: await puppeteer.connect({ browserURL: `http://localhost:${PORT}`, defaultViewport: null }), proc }; }
    catch { process.stdout.write('.'); }
  }
  console.error(`\nCould not connect — is ${WHICH} already running? Close it and retry.`);
  proc.kill(); process.exit(1);
}

async function seedKeys(browser) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/popup/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const res = await page.evaluate(async (seed) => {
    const cur = (await chrome.storage.local.get('keystore')).keystore || {};
    const added = [];
    for (const [h, rec] of Object.entries(seed)) { if (!cur[h]) { cur[h] = rec; added.push(h); } }
    await chrome.storage.local.set({ keystore: cur });
    return { added, present: Object.keys(cur), carolPresent: !!cur.BDF1B1DF };
  }, SEED);
  await page.close();
  return res;
}

async function waitForBadges(page, expected, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.ssd-indicator')];
      return { total: b.length, scanning: b.filter(x => x.dataset.ssdState === 'SCANNING').length };
    });
    if (s.total >= expected && s.scanning === 0) return true;
    await sleep(300);
  }
  return false;
}

async function collect(page, expectSel, containerSel) {
  return page.evaluate(({ expectSel, containerSel }) => {
    const norm = t => (t || '').trim().split(/[\s(]/)[0];
    return [...document.querySelectorAll(expectSel)].map(exp => {
      const c = exp.closest(containerSel);
      const badge = c && c.querySelector('.ssd-indicator');
      return { expect: norm(exp.textContent),
               actual: badge ? (badge.dataset.ssdState || 'NO_STATE') : 'NO_BADGE',
               label:  badge ? (badge.querySelector('.ssd-indicator-label')?.textContent || '') : '' };
    });
  }, { expectSel, containerSel });
}

async function checkPlatform(browser, plat) {
  const rows = [];
  for (const url of plat.urls) {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
      const count = await page.evaluate(sel => document.querySelectorAll(sel).length, plat.expect);
      await waitForBadges(page, count);
      rows.push(...await collect(page, plat.expect, plat.container));
    } catch (e) { rows.push({ expect: '?', actual: 'PAGE_ERR', label: e.message.slice(0, 40) }); }
    await page.close();
  }
  console.log(`\n${plat.name}`);
  console.log('  ' + '#'.padEnd(3) + 'expected'.padEnd(18) + 'actual'.padEnd(18) + 'label');
  console.log('  ' + '─'.repeat(66));
  let pass = 0;
  rows.forEach((r, i) => {
    const ok = r.expect === r.actual; if (ok) pass++;
    console.log('  ' + (ok ? '✓ ' : '✗ ') + String(i + 1).padEnd(1) + '  ' + r.expect.padEnd(18) + String(r.actual).padEnd(18) + r.label);
  });
  console.log(`  → ${pass}/${rows.length} matched`);
  return rows.length > 0 && pass === rows.length;
}

(async () => {
  const cfg = BROWSERS[WHICH];
  if (!cfg) { console.error(`Unknown browser '${WHICH}'. Use brave or chromium.`); process.exit(1); }
  try { const r = await fetch(`${BASE}/facebook`); if (!r.ok) throw new Error(`HTTP ${r.status}`); }
  catch (e) { console.error(`Mock server not reachable — start it first. ${e.message}`); process.exit(1); }

  console.log(`Launching ${WHICH} (real profile) with debug port…`);
  const { browser, proc } = await connectBrowser(cfg);
  const seen = browser.targets().some(t => t.url().includes(`${EXT_ID}/`));
  console.log(seen ? `  tick2 present (${EXT_ID})` : `  ⚠ tick2 target not seen yet — proceeding (content scripts still inject)`);

  console.log('Seeding Alice + Bob (non-destructive)…');
  const seed = await seedKeys(browser);
  console.log(`  added: [${seed.added.join(', ') || 'none — already present'}]  keystore: [${seed.present.join(', ')}]`);
  if (seed.carolPresent) console.log('  ⚠ Carol is in the keyring — her posts will read VALID, not KEY_UNREACHABLE');

  let all = true;
  for (const plat of PLATFORMS) all = await checkPlatform(browser, plat) && all;

  console.log('\n' + (all ? `✓ PASS (${WHICH}) — every badge matched its expected verdict`
                          : `✗ FAIL / partial (${WHICH}) — see rows above`));

  if (KEEP_OPEN) { console.log(`\nLeaving ${WHICH} open for inspection. Close it normally (pass --close to auto-close).`); await browser.disconnect(); }
  else { await browser.disconnect(); proc.kill(); }
  process.exit(all ? 0 : 1);
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
