// ⚠ SUPERSEDED / NON-FUNCTIONAL — use test/mock-verify.js instead.
// This harness side-loads an unpacked extension into a throwaway profile via
// --load-extension, which current Chrome/Chromium ignore, so the extension never
// loads and no badges appear. Kept for reference only. See test/TESTING-MOCK.md.
//
// test/facebook-mock.js — drive ssd-tick-2 against the socialmedia-mock Facebook pages.
//
// Launches Chrome with the extension loaded, seeds Alice's + Bob's key cards
// into the keyring the way a user import would (Carol's is deliberately left
// out), then loads the mock feed and single-post pages and reports the badge
// verdict each post received against the verdict the fixture expects.
//
//   Alice (A485141D)  → VALID            (key known, text untouched)
//   Bob   (0D1CBB3A)  → MISMATCH         (key resolvable, text tampered)
//   Carol (BDF1B1DF)  → KEY_UNREACHABLE  (key never imported)
//
// Run from the ssd-tick-2 directory:
//   node test/facebook-mock.js            (headed, closes at end)
//   node test/facebook-mock.js --keep     (leave the browser open to inspect)
//
// Requires the socialmedia-mock server running on http://localhost:8080.

const puppeteer = require('./node_modules/puppeteer-core');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { spawn } = require('child_process');

const CHROME     = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_DIR    = path.resolve(__dirname, '..');            // load the repo root (matches manifest.json)
const BASE       = 'http://localhost:8080/social-mock';
const FEED_URL   = `${BASE}/facebook`;
const DEBUG_PORT = 9224;
const KEEP_OPEN  = process.argv.includes('--keep');

// Path-derived extension ID for EXT_DIR on this machine (from the existing e2e test).
// Verified against the live targets at runtime; used only as a fallback.
const EXT_ID_FALLBACK = 'nkeimhogjdpnpccoofpliimaahmaaome';

const HOST_PERMS = ['http://localhost:8080/*', 'http://127.0.0.1:8080/*'];

// Key cards to seed — mirrors what storeFetchedKey writes for an imported card.
// public_key values are the fixtures' pubB64 (base64url Ed25519 raw keys).
const SEED_KEYS = {
  A485141D: {
    hash8: 'A485141D', name: 'Alice Mockford',
    public_key: 'hvNIFTAstyZAn7rhCxZhRwDS_xIf34sGcSL7eNh2C0w',
    signing_algorithm: 'Ed25519', issued: '2026-07-21', expires: null,
    self_signed: null, imported_at: new Date().toISOString(),
    source: 'direct', vouched_by: null, bundle_name: null,
    credibility: null, vault: null, token_default: null,
  },
  '0D1CBB3A': {
    hash8: '0D1CBB3A', name: 'Bob Mocksmith',
    public_key: 'ph4B0RgRDcFqTCwZQ-e3kiptXjW7dCtsMay16o7z-Ww',
    signing_algorithm: 'Ed25519', issued: '2026-07-21', expires: null,
    self_signed: null, imported_at: new Date().toISOString(),
    source: 'direct', vouched_by: null, bundle_name: null,
    credibility: null, vault: null, token_default: null,
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launchChrome() {
  const userDataDir = path.join(os.tmpdir(), `ssd-fbmock-${Date.now()}`);
  const defaultDir  = path.join(userDataDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });

  const prefs = {
    extensions: {
      developer_mode: true,
      settings: {
        [EXT_ID_FALLBACK]: {
          location: 4, state: 1,
          active_permissions:  { api: ['storage'], explicit_host: HOST_PERMS, manifest_permissions: [] },
          granted_permissions: { api: ['storage'], explicit_host: HOST_PERMS, manifest_permissions: [] },
        },
      },
    },
  };
  fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify(prefs), 'utf8');

  const proc = spawn(CHROME, [
    `--load-extension=${EXT_DIR.replace(/\\/g, '/')}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir.replace(/\\/g, '/')}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { detached: false, stdio: 'ignore' });
  proc.on('error', err => { console.error('Chrome failed to start:', err); process.exit(1); });

  let browser;
  for (let i = 1; i <= 15; i++) {
    await sleep(1000);
    try {
      browser = await puppeteer.connect({ browserURL: `http://localhost:${DEBUG_PORT}`, defaultViewport: null });
      break;
    } catch { process.stdout.write('.'); }
  }
  if (!browser) { console.error('\nCould not connect to Chrome debug port.'); proc.kill(); process.exit(1); }
  return { browser, proc, userDataDir };
}

// Find our extension's service-worker target (identifies the extension by its
// own background path, not just any chrome-extension URL). Returns { id, target }.
async function findServiceWorker(browser) {
  for (let i = 0; i < 20; i++) {
    for (const t of browser.targets()) {
      const m = t.url().match(/^chrome-extension:\/\/([a-p]{32})\/background\/service-worker\.js$/);
      if (m && t.type() === 'service_worker') return { id: m[1], target: t };
    }
    await sleep(500);
  }
  return null;
}

// Seed the keystore through the service-worker context — chrome.storage.local
// is available there, and it needs no page navigation (unlike the popup).
async function seedKeys(swTarget) {
  const worker = await swTarget.worker();
  return worker.evaluate(async (keys) => {
    await chrome.storage.local.set({ keystore: keys });
    const back = await chrome.storage.local.get('keystore');
    return Object.keys(back.keystore || {});
  }, SEED_KEYS);
}

// Wait until every article has a badge and none are still SCANNING (or timeout).
async function waitForBadges(page, expectedCount, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => {
      const badges = [...document.querySelectorAll('.ssd-indicator')];
      return {
        total: badges.length,
        scanning: badges.filter(b => b.dataset.ssdState === 'SCANNING').length,
      };
    });
    if (s.total >= expectedCount && s.scanning === 0) return true;
    await sleep(300);
  }
  return false;
}

// Collect { id, expect, actual, label } for each post card on the current page.
async function collectPosts(page) {
  return page.evaluate(() => {
    const norm = t => (t || '').trim().split(/[\s(]/)[0];  // "KEY_UNREACHABLE (until…)" → "KEY_UNREACHABLE"
    return [...document.querySelectorAll('.fb-post')].map(card => {
      const idLink = card.querySelector('a[href*="/posts/"]') || card.querySelector('a[href*="/facebook/"]');
      const idM = idLink && idLink.getAttribute('href').match(/\/posts\/([^/]+)/);
      const badge = card.querySelector('.ssd-indicator');
      return {
        id:     idM ? idM[1] : (card.querySelector('.fb-author')?.textContent || '?'),
        expect: norm(card.querySelector('.fb-expect')?.textContent),
        actual: badge ? (badge.dataset.ssdState || null) : 'NO_BADGE',
        label:  badge ? (badge.querySelector('.ssd-indicator-label')?.textContent || '') : '',
      };
    });
  });
}

function report(title, rows) {
  console.log(`\n${title}`);
  console.log('  ' + 'post'.padEnd(6) + 'expected'.padEnd(18) + 'actual'.padEnd(18) + 'label');
  console.log('  ' + '─'.repeat(70));
  let pass = 0;
  for (const r of rows) {
    const ok = r.expect === r.actual;
    if (ok) pass++;
    console.log('  ' + (ok ? '✓ ' : '✗ ') + String(r.id).padEnd(4) +
      r.expect.padEnd(18) + String(r.actual).padEnd(18) + r.label);
  }
  console.log(`  → ${pass}/${rows.length} matched`);
  return pass === rows.length;
}

(async () => {
  // Sanity: server up?
  try {
    const res = await fetch(FEED_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`Mock server not reachable at ${FEED_URL} — start socialmedia-mock (00-startup.bat). ${e.message}`);
    process.exit(1);
  }

  console.log('Launching Chrome with ssd-tick-2…');
  const { browser, proc } = await launchChrome();
  const sw = await findServiceWorker(browser);
  if (!sw) { console.error('Could not find the extension service worker — did it load?'); proc.kill(); process.exit(1); }
  console.log(`  Extension ID: ${sw.id}${sw.id === EXT_ID_FALLBACK ? '' : ' (differs from fallback)'}`);

  console.log('Seeding Alice + Bob key cards (Carol left out)…');
  const seeded = await seedKeys(sw.target);
  console.log(`  Keystore now holds: ${seeded.join(', ')}`);

  let allPass = true;

  // ── Feed ────────────────────────────────────────────────────────────────
  const feed = await browser.newPage();
  feed.on('pageerror', err => console.log(`  [feed page error] ${err.message}`));
  await feed.goto(FEED_URL, { waitUntil: 'networkidle0' });
  const feedCount = await feed.evaluate(() => document.querySelectorAll('.fb-post').length);
  const settled = await waitForBadges(feed, feedCount);
  if (!settled) console.log('  ⚠ badges did not fully settle before timeout — reporting current state');
  allPass = report(`Feed (${FEED_URL}) — ${feedCount} posts`, await collectPosts(feed)) && allPass;

  // ── Single-post pages ───────────────────────────────────────────────────
  const singleRows = [];
  for (const id of ['p1', 'p2', 'p3', 'p4']) {
    const pg = await browser.newPage();
    await pg.goto(`${BASE}/facebook/posts/${id}`, { waitUntil: 'networkidle0' });
    await waitForBadges(pg, 1);
    const rows = await collectPosts(pg);
    if (rows[0]) singleRows.push({ ...rows[0], id });
    await pg.close();
  }
  allPass = report('Single-post pages', singleRows) && allPass;

  console.log('\n' + (allPass ? '✓ PASS — every badge matched its expected verdict'
                              : '✗ FAIL — see mismatches above'));

  if (KEEP_OPEN) {
    console.log('\n--keep set: leaving the browser open. Close it manually when done.');
  } else {
    await browser.disconnect();
    proc.kill();
  }
  process.exit(allPass ? 0 : 1);
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
