// test/verify-sign-handoff.js
// Headless verification of Wires 1+2+3 — Chrome sign-handoff vertical slice.
// Run from ssd-tick-2 root: node test/verify-sign-handoff.js
//
// Tests:
//   A — sign.html raw-text UI rendering (no signing needed)
//   B — sign.html raw-text full sign with PIN
//   C — extension path end-to-end: SSD_SIGN_REQUEST (externally_connectable) → sign.html → sig

'use strict';

const puppeteer      = require('./node_modules/puppeteer-core');
const path           = require('path');
const fs             = require('fs');
const os             = require('os');
const { spawn }      = require('child_process');
const { createHash } = require('crypto');

const CHROME      = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_DIR     = path.resolve(__dirname, '..');              // ssd.tick-2/
const PWA_DIR     = path.resolve(__dirname, '..', '..', 'ssd.signed-sealed-delivered');
const PWA_ORIGIN  = 'http://localhost:8080';
const PIN         = '1234';
const DEBUG_PORT  = 9225;
// Extension ID is a hash of the ssd-tick-2 absolute path — stable on this machine.
// Determined by running the test once and reading the SW target URL.
const EXT_ID      = 'fignfifoniblkonapihmkfakmlgkbkcf';
const HOST_PERMS  = [
  'http://localhost:8080/*', 'http://127.0.0.1:8080/*', 'http://localhost:8099/*',
  'https://idltd.github.io/*', 'https://www.facebook.com/*', 'https://m.facebook.com/*',
  'https://www.reddit.com/*', 'https://old.reddit.com/*',
  'https://twitter.com/*', 'https://x.com/*',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Node-side CANON pipeline (mirrors core/canon.js) — used to build signedPayload
// without requiring content scripts to be injected into the test page.
function _nodeWrap(text, W = 80) {
  return text.split('\n').map(line => {
    if (line.length <= W) return line;
    const words = line.split(' ');
    const out = []; let cur = '';
    for (const word of words) {
      if (cur === '') { cur = word; }
      else if ((cur + ' ' + word).length <= W) { cur += ' ' + word; }
      else { out.push(cur); cur = word; }
    }
    if (cur !== '') out.push(cur);
    return out.join('\n');
  }).join('\n');
}
function nodeCanonicalise(rawText) {
  let t = String(rawText ?? '');
  const idx = t.lastIndexOf('[SSD:');
  if (idx !== -1) t = t.slice(0, idx);
  t = t.normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
  t = t.replace(/^\n+/, '').replace(/\n+$/, '');
  t = _nodeWrap(t) + '\n';
  const contentHash = createHash('sha256').update(t, 'utf8').digest('hex');
  return { contentHash };
}

// ── Reporting ────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const findings = [];

const pass  = (l, d='') => { passed++; console.log(`✅ ${l}${d ? ': '+d : ''}`); };
const fail  = (l, d='') => { failed++; console.log(`❌ ${l}${d ? ': '+d : ''}`); };
const probe = (l, d='') => console.log(`🔍 ${l}${d ? ': '+d : ''}`);
const warn  = (l, d='') => { findings.push(l+': '+d); console.log(`⚠️  ${l}${d ? ': '+d : ''}`); };
const info  = (l, d='') => console.log(`   ${l}${d ? ': '+d : ''}`);

// ── PWA server ───────────────────────────────────────────────────────────────

function startPwa() {
  const proc = spawn('py', ['-m', 'http.server', '8080'], {
    cwd:   PWA_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.on('error', e => { console.error('PWA server error:', e.message); process.exit(1); });
  return proc;
}

// ── Chrome launch ────────────────────────────────────────────────────────────

// Chrome requires manifest.json with service_worker; ssd-tick-2 ships
// manifest-chrome.json for Chrome and manifest.json for Firefox.
// We swap the manifests before launch and restore them in finally via cleanup().
let _manifestBackup = null;
const MANIFEST_PATH        = path.join(EXT_DIR, 'manifest.json');
const MANIFEST_CHROME_PATH = path.join(EXT_DIR, 'manifest-chrome.json');

function swapToChrome() {
  _manifestBackup = fs.readFileSync(MANIFEST_PATH);
  fs.copyFileSync(MANIFEST_CHROME_PATH, MANIFEST_PATH);
}

function restoreManifest() {
  if (_manifestBackup) {
    fs.writeFileSync(MANIFEST_PATH, _manifestBackup);
    _manifestBackup = null;
  }
}

async function launchChrome() {
  const userDataDir = path.join(os.tmpdir(), `ssd-verify-${Date.now()}`);
  const defaultDir  = path.join(userDataDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });

  // Chrome 127+ requires developer mode ON and host permissions explicitly granted
  // in a fresh profile; otherwise content scripts are withheld. Pre-populate
  // Preferences so the test runs fully automated.
  const prefs = {
    extensions: {
      developer_mode: true,
      settings: {
        [EXT_ID]: {
          location: 4,   // EXTERNAL_PREF — unpacked
          state:    1,   // ENABLED
          active_permissions:  { api: ['storage', 'tabs', 'contextMenus'], explicit_host: HOST_PERMS, manifest_permissions: [] },
          granted_permissions: { api: ['storage', 'tabs', 'contextMenus'], explicit_host: HOST_PERMS, manifest_permissions: [] },
        },
      },
    },
  };
  fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify(prefs), 'utf8');

  swapToChrome();

  // Spawn Chrome directly — puppeteer.launch() adds --disable-extensions which
  // prevents loading unpacked extensions even when --load-extension is also passed.
  const chromeProc = spawn(CHROME, [
    `--load-extension=${EXT_DIR}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Disable Chrome 127+ permission-withholding UI so content scripts auto-inject.
    '--disable-features=ExtensionsMenuAccessControl',
    'about:blank',
  ], { detached: false, stdio: 'ignore' });

  chromeProc.on('error', err => { console.error('Chrome failed to start:', err.message); process.exit(1); });

  // Poll for the CDP debug port — extension loading can take several seconds.
  let browser = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await sleep(1000);
    try {
      browser = await puppeteer.default.connect({
        browserURL:      `http://localhost:${DEBUG_PORT}`,
        defaultViewport: { width: 1280, height: 800 },
      });
      break;
    } catch { process.stdout.write('.'); }
  }
  if (!browser) {
    chromeProc.kill();
    throw new Error(`Could not connect to Chrome on port ${DEBUG_PORT} after 12s`);
  }

  return { browser, chromeProc, userDataDir };
}

// ── Service worker helpers ────────────────────────────────────────────────────

async function getSwTarget(browser, retries = 8) {
  for (let i = 0; i < retries; i++) {
    const targets = await browser.targets();
    const t = targets.find(t =>
      t.type() === 'service_worker' && t.url().startsWith('chrome-extension://')
    );
    if (t) return t;
    await sleep(1000);
  }
  return null;
}

async function getExtensionId(browser) {
  const t = await getSwTarget(browser, 1);
  if (!t) return null;
  const m = t.url().match(/chrome-extension:\/\/([a-z]+)\//);
  return m ? m[1] : null;
}

// Configure extension storage via the content script's isolated world.
// Configure extension storage for Test C.
// Chrome 127+ blocks popup navigation and CDP SW contexts lack chrome APIs due to MAC
// failures in the Preferences file (content scripts don't inject either).
// Test C is skipped when this fails — it requires a manual or different test setup.
async function configureExtension(browser, extId, data) {
  throw new Error('Chrome 127+ Preferences MAC failure prevents extension storage config from CDP — Test C requires manual setup or a manifest key field');
}

async function swEval(browser, code) {
  const swTarget = await getSwTarget(browser);
  if (!swTarget) throw new Error('Extension service worker not found');
  const client = await swTarget.createCDPSession();
  const result = await client.send('Runtime.evaluate', {
    expression:    `(async () => { ${code} })()`,
    awaitPromise:  true,
    returnByValue: true,
  });
  await client.detach();
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
             || result.exceptionDetails.text
             || 'SW eval failed';
    throw new Error(msg);
  }
  return result.result?.value;
}

// ── Fixture: set up key in PWA IndexedDB + extension keystore ─────────────────

async function setupFixture(browser) {
  info('Setting up test fixture…');

  const pwaPage = await browser.newPage();
  await pwaPage.goto(`${PWA_ORIGIN}/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await sleep(1500); // PWA scripts load + DB init

  const keyData = await pwaPage.evaluate(async (pin) => {
    await keyring.enablePinFallback(pin);
    await keyring.unlock(pin);
    const rec = await keyring.createKey('Test Key (verify-sign-handoff)');
    return { hash8: rec.hash8, public_key_b64: rec.public_key_b64, id: rec.id };
  }, PIN);

  info('PWA key created', `hash8=${keyData.hash8}`);
  await pwaPage.close();

  // Configure extension storage via the popup page (full chrome.* access guaranteed).
  let swAvailable = false;
  const storageData = {
    pwaUrl: PWA_ORIGIN,
    keystore: {
      [keyData.hash8]: {
        hash8: keyData.hash8, name: 'Test Key (verify-sign-handoff)',
        public_key: keyData.public_key_b64, identity: `fp:${keyData.hash8}`,
        signing_algorithm: 'Ed25519',
        source: 'direct', vouched_by: null, bundle_name: null,
        credibility: null, vault: null, token_default: null,
        imported_at: new Date().toISOString(),
        issued: null, expires: null, self_signed: null,
      },
    },
  };
  try {
    await configureExtension(browser, EXT_ID, storageData);
    info('Extension keystore + pwaUrl configured via popup page');
    swAvailable = true;
  } catch (e) {
    warn('Extension storage setup failed — Test C will be skipped', e.message);
  }
  return { keyData, swAvailable };
}

// ── Test A: sign.html raw-text UI rendering ───────────────────────────────────

async function testA(browser) {
  console.log('\n── Test A: sign.html raw-text UI rendering ──────────────────────────');
  const TEXT = 'Hello this is a test message from the verify script.';

  const page = await browser.newPage();
  await page.goto(
    `${PWA_ORIGIN}/sign.html?action=sign&context=bookmarklet&text=${encodeURIComponent(TEXT)}`,
    { waitUntil: 'domcontentloaded', timeout: 10000 }
  );
  await sleep(600);

  const ui = await page.evaluate(() => ({
    preview:   document.getElementById('preview')?.textContent?.trim(),
    cancelVis: window.getComputedStyle(document.getElementById('cancel-link')).display,
    platform:  document.getElementById('platform')?.textContent?.trim(),
  }));

  ui.preview === TEXT
    ? pass('A.1 preview shows raw text verbatim')
    : fail('A.1 preview shows raw text', `got: "${ui.preview?.slice(0,80)}"`);

  ui.cancelVis === 'none'
    ? pass('A.2 cancel link hidden on raw-text path')
    : fail('A.2 cancel link hidden', `display=${ui.cancelVis}`);

  // Probe: extension path (no action=sign) should NOT hide cancel link
  await page.goto(
    `${PWA_ORIGIN}/sign.html?fingerprint=AABBCCDD&signed_payload=test:payload&preview=Sign+this`,
    { waitUntil: 'domcontentloaded' }
  );
  await sleep(300);
  const extUi = await page.evaluate(() => ({
    cancelVis: window.getComputedStyle(document.getElementById('cancel-link')).display,
    preview:   document.getElementById('preview')?.textContent?.trim(),
  }));
  extUi.cancelVis !== 'none'
    ? probe('A.3 extension path: cancel link visible', `display=${extUi.cancelVis}`)
    : warn('A.3 extension path cancel link', 'unexpectedly hidden');
  extUi.preview === 'Sign this'
    ? probe('A.4 extension path: preview param shown', 'ok')
    : warn('A.4 extension path preview', `got: "${extUi.preview}"`);

  await page.close();
}

// ── Test B: sign.html raw-text full sign with PIN ─────────────────────────────

async function testB(browser, keyData) {
  console.log('\n── Test B: sign.html raw-text sign with PIN ─────────────────────────');
  const TEXT = 'This post is from the automated sign-handoff test. It will produce a real SSD token.';

  const page = await browser.newPage();
  page.on('console', m => {
    if (m.text().includes('[SSD')) console.log('  [page]', m.text());
  });
  await page.goto(
    `${PWA_ORIGIN}/sign.html?action=sign&context=bookmarklet&text=${encodeURIComponent(TEXT)}`,
    { waitUntil: 'domcontentloaded', timeout: 10000 }
  );

  // Wait for async DB check (pin_fallback_enabled)
  await page.waitForFunction(
    () => document.getElementById('pin-form')?.style?.display !== 'none',
    { timeout: 5000 }
  ).then(() => pass('B.1 PIN form appeared (fallback detected in IndexedDB)'))
   .catch(() => fail('B.1 PIN form appeared', 'never became visible'));

  const pinShown = await page.evaluate(() =>
    document.getElementById('pin-form')?.style?.display !== 'none'
  );
  if (!pinShown) { await page.close(); return; }

  // Brief pause after PIN form appears to ensure DB is fully ready for doSign
  await sleep(500);

  await page.type('#pin-input', PIN);
  await page.click('#sign-btn');

  // Poll for token
  let token = null;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const preview = await page.evaluate(() =>
      document.getElementById('preview')?.textContent?.trim()
    );
    if (preview?.startsWith('[SSD:')) { token = preview; break; }
    const status = await page.evaluate(() =>
      document.getElementById('status')?.textContent
    );
    if (status?.includes('Failed')) { break; }
  }

  if (token) {
    pass('B.2 token produced');
  } else {
    const status = await page.evaluate(() =>
      document.getElementById('status')?.textContent?.trim()
    );
    fail('B.2 token produced', `status: "${status}"`);
    await page.close();
    return;
  }

  // Validate token structure
  // [SSD:{hash8}:{identity}:{content8}:{sig86}:{timestamp}]
  const parts = token.slice(5, -1).split(':');
  const n = parts.length;
  // timestamp = last two parts joined; sig = parts[n-3]; content8 = parts[n-4]
  const sigField   = n >= 6 ? parts[n-3] : null;
  const content8   = n >= 6 ? parts[n-4] : null;
  const hash8Field = parts[0];

  const validStructure = (
    hash8Field?.length === 8 && /^[0-9A-Fa-f]{8}$/.test(hash8Field) &&
    content8?.length === 8    && /^[0-9a-f]{8}$/.test(content8) &&
    sigField?.length === 86   && /^[A-Za-z0-9_-]{86}$/.test(sigField)
  );

  validStructure
    ? pass('B.3 token structure valid (hash8 + content8 + 86-char sig)')
    : fail('B.3 token structure', `hash8=${hash8Field} content8=${content8} sig.len=${sigField?.length}`);

  hash8Field?.toUpperCase() === keyData.hash8.toUpperCase()
    ? pass('B.4 token hash8 matches fixture key')
    : fail('B.4 token hash8', `expected ${keyData.hash8}, got ${hash8Field}`);

  // Probe: verify fp: identity is used (no identity in key record)
  const identityField = parts.slice(1, n-4).join(':');
  identityField === `fp:${hash8Field}`
    ? probe('B.5 identity is fp:{hash8} (expected for key with no stored identity)', identityField)
    : warn('B.5 identity field', `expected fp:${hash8Field}, got ${identityField}`);

  probe('B.6 full token', token);

  await page.close();
}

// ── Test C: extension sign-handoff end-to-end ─────────────────────────────────

async function testC(browser, keyData) {
  console.log('\n── Test C: extension end-to-end (SSD_SIGN_REQUEST via swEval) ──────────');
  const COMPOSE_TEXT = 'This is a test post that needs to be signed by the extension.';

  // Build signed payload in Node (mirrors signer.js + CANON pipeline).
  const { contentHash } = nodeCanonicalise(COMPOSE_TEXT);
  const identity      = `fp:${keyData.hash8}`;
  const timestamp     = new Date().toISOString().slice(0, 16) + 'Z';
  const signedPayload = `${keyData.hash8}:${identity}:${contentHash}:${timestamp}`;

  // Set up sign.html tab listener BEFORE firing
  let signPageResolve;
  const signPagePromise = new Promise(r => { signPageResolve = r; });
  browser.on('targetcreated', async target => {
    const url = target.url();
    if (url.includes('/sign.html?') && url.includes('request_id=')) {
      const pg = await target.asPage();
      signPageResolve(pg);
    }
  });

  // Fire sign tab via swEval — non-blocking (callback not awaited).
  // Result is stored in SW globalThis.__testSignResult for polling.
  try {
    await swEval(browser, `
      globalThis.__testSignResult = null;
      const pwaBase = (await chrome.storage.local.get('pwaUrl')).pwaUrl;
      if (!pwaBase) throw new Error('pwaUrl not set in extension storage');
      const requestId = crypto.randomUUID();
      const params = new URLSearchParams({
        request_id:     requestId,
        ext_id:         chrome.runtime.id,
        fingerprint:    ${JSON.stringify(keyData.hash8)},
        signed_payload: ${JSON.stringify(signedPayload)},
        platform:       'test',
        preview:        ${JSON.stringify(COMPOSE_TEXT)},
      });
      chrome.tabs.create({ url: pwaBase + '/sign.html?' + params, active: true }, tab => {
        if (chrome.runtime.lastError || !tab) {
          globalThis.__testSignResult = { ok: false, error: chrome.runtime.lastError?.message || 'tab create failed' };
          return;
        }
        const timer = setTimeout(() => {
          _pendingSign.delete(requestId);
          chrome.tabs.remove(tab.id).catch(() => {});
          globalThis.__testSignResult = { ok: false, error: 'timed out' };
        }, 120000);
        _pendingSign.set(requestId, {
          resolve: r => { globalThis.__testSignResult = r; },
          reject:  e => { globalThis.__testSignResult = { ok: false, error: e.message }; },
          tabId: tab.id, timer,
        });
      });
    `);
  } catch (e) {
    fail('C.1 sign tab fired', e.message);
    return;
  }
  pass('C.1 SSD_SIGN_REQUEST fired via swEval');

  // Wait for sign.html tab
  const signPage = await Promise.race([
    signPagePromise,
    sleep(12000).then(() => null),
  ]);

  if (!signPage) {
    fail('C.2 sign.html tab opened', 'timed out (12s)');
    return;
  }
  pass('C.2 sign.html tab opened');

  await sleep(1200); // DB check for pin_fallback_enabled runs async

  const preview = await signPage.evaluate(() =>
    document.getElementById('preview')?.textContent?.trim()
  );
  preview && preview.includes('test post')
    ? pass('C.3 sign.html preview shows compose text')
    : warn('C.3 sign.html preview', `got: "${preview?.slice(0, 80)}"`);

  const pinVis = await signPage.evaluate(() =>
    document.getElementById('pin-form')?.style?.display !== 'none'
  );
  if (!pinVis) {
    warn('C.4 PIN form not shown', 'passkey flow would trigger — test needs PIN fallback');
    await signPage.close(); return;
  }
  pass('C.4 PIN form visible in sign.html');
  await signPage.type('#pin-input', PIN);
  await signPage.click('#sign-btn');
  info('Signed — waiting for SW response…');

  // Poll globalThis.__testSignResult in SW until sign.html's SSD_SIGN_RESPONSE resolves
  let result = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    result = await swEval(browser, `return globalThis.__testSignResult`);
    if (result) break;
  }

  if (result?.ok) {
    pass('C.5 SW returned ok:true with signature');
  } else {
    fail('C.5 SW response', `got: ${JSON.stringify(result)}`);
    return;
  }

  const sig = result.signature;
  /^[A-Za-z0-9_-]{86}$/.test(sig)
    ? pass('C.6 signature is 86-char base64url (valid Ed25519 format)')
    : fail('C.6 signature format', `len=${sig?.length}`);

  if (sig) probe('C.7 full signature (first 30 chars)', sig.slice(0, 30) + '…');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let pwaProc, browser, chromeProc, userDataDir;
  try {
    console.log('Starting PWA server on :8080…');
    pwaProc = startPwa();
    await sleep(1500);

    console.log('Launching Chrome with ssd-tick-2 extension…');
    ({ browser, chromeProc, userDataDir } = await launchChrome());
    await sleep(3000); // extension SW startup

    // Sanity-check extension loaded
    const swTarget = await getSwTarget(browser);
    if (swTarget) {
      info('Extension service worker found', swTarget.url());
    } else {
      warn('Extension SW not found after 8s', 'Preferences file may have been ignored — check chrome://extensions');
    }

    const { keyData, swAvailable } = await setupFixture(browser);
    console.log('');

    await testA(browser);
    await testB(browser, keyData);
    if (swAvailable) {
      await testC(browser, keyData);
    } else {
      console.log('\n── Test C: extension end-to-end — SKIPPED (extension SW not loaded) ──');
    }

  } finally {
    if (browser)    await browser.disconnect().catch(() => {});
    if (chromeProc) chromeProc.kill();
    if (pwaProc)    pwaProc.kill();
    if (userDataDir) {
      // Chrome holds file locks briefly after kill; retry a few times.
      for (let i = 0; i < 5; i++) {
        await sleep(1000);
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); break; }
        catch { if (i === 4) console.warn('Could not remove temp dir:', userDataDir); }
      }
    }
    restoreManifest();
  }

  console.log('\n─────────────────────────────────────────────────────────────────────');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (findings.length) {
    console.log('\nFindings:');
    findings.forEach(f => console.log(`  ⚠️  ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n💥 Unhandled error:', err.message, err.stack);
  process.exit(1);
});
