// test/verify-sign-handoff.js
// Headless verification of Wires 1+2+3 — Chrome sign-handoff vertical slice.
// Run from ssd-tick-2 root: node test/verify-sign-handoff.js
//
// Tests:
//   A — sign.html raw-text UI rendering (no signing needed)
//   B — sign.html raw-text full sign with PIN
//   C — extension path end-to-end: SSD_SIGN_THIS → SSD_SIGN_REQUEST → sign.html → token

'use strict';

const puppeteer  = require('./node_modules/puppeteer-core');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { spawn }  = require('child_process');

const CHROME     = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_DIR    = path.resolve(__dirname, '..');              // ssd-tick-2/
const PWA_DIR    = path.resolve(__dirname, '..', '..', 'SignedSealedDelivered');
const PWA_ORIGIN = 'http://localhost:8080';
const PIN        = '1234';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });

  swapToChrome();

  const browser = await puppeteer.default.launch({
    executablePath:  CHROME,
    headless:        false,   // extensions require non-headless or --headless=new
    userDataDir,
    args: [
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  return { browser, userDataDir, tempExtDir: null };
}

// ── Service worker helpers ────────────────────────────────────────────────────

async function getSwTarget(browser, retries = 8) {
  for (let i = 0; i < retries; i++) {
    const targets = await browser.targets();
    if (i === 0) {
      console.log('   [debug] all targets:', targets.map(t => `${t.type()}|${t.url()}`));
    }
    const t = targets.find(t =>
      t.type() === 'service_worker' && t.url().startsWith('chrome-extension://')
    );
    if (t) return t;
    await sleep(1000);
  }
  return null;
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

  // Open the PWA main page so db/keyring globals are available
  const pwaPage = await browser.newPage();
  await pwaPage.goto(`${PWA_ORIGIN}/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await sleep(1500); // scripts load + DB init

  const keyData = await pwaPage.evaluate(async (pin) => {
    await keyring.enablePinFallback(pin);
    await keyring.unlock(pin);
    const rec = await keyring.createKey('Test Key (verify-sign-handoff)');
    return { hash8: rec.hash8, public_key_b64: rec.public_key_b64, id: rec.id };
  }, PIN);

  info('PWA key created', `hash8=${keyData.hash8}`);
  await pwaPage.close();

  // Store public key in extension keystore + pwaUrl (only needed for Test C).
  // If the extension SW isn't available, skip this gracefully — Tests A and B proceed fine.
  let swAvailable = false;
  try {
    await swEval(browser, `
      const data  = await new Promise(r => chrome.storage.local.get('keystore', r));
      const ks    = data.keystore || {};
      const h     = ${JSON.stringify(keyData.hash8)};
      ks[h] = {
        hash8: h, name: 'Test Key (verify-sign-handoff)',
        public_key: ${JSON.stringify(keyData.public_key_b64)},
        identity:   'fp:' + h,
        signing_algorithm: 'Ed25519',
        source: 'direct', vouched_by: null, bundle_name: null,
        credibility: null, vault: null, token_default: null,
        imported_at: new Date().toISOString(),
        issued: null, expires: null, self_signed: null,
      };
      await new Promise(r => chrome.storage.local.set({ keystore: ks, pwaUrl: ${JSON.stringify(PWA_ORIGIN)} }, r));
    `);
    info('Extension keystore + pwaUrl configured');
    swAvailable = true;
  } catch (e) {
    warn('Extension SW not reachable — Test C will be skipped', e.message);
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
  console.log('\n── Test C: extension end-to-end (SSD_SIGN_THIS → token) ─────────────');
  const COMPOSE_TEXT = 'This is a test post that needs to be signed by the extension.';

  // Write minimal test page with textarea
  const testHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>SSD Sign Test</title></head>
<body><textarea id="compose" style="width:600px;height:80px">${COMPOSE_TEXT}</textarea></body>
</html>`;
  const testPagePath = path.join(PWA_DIR, 'sign-test-page.html');
  fs.writeFileSync(testPagePath, testHtml, 'utf8');

  const testPage = await browser.newPage();
  testPage.on('console', m => {
    const txt = m.text();
    if (txt.includes('[SSD') || m.type() === 'error') console.log('  [page]', txt);
  });

  await testPage.goto(`${PWA_ORIGIN}/sign-test-page.html`,
    { waitUntil: 'networkidle0', timeout: 15000 });
  await sleep(2500); // content scripts inject at document_idle — give them time

  // Verify content scripts loaded
  const hasSigner = await testPage.evaluate(() => typeof signer !== 'undefined');
  hasSigner
    ? pass('C.1 content scripts injected (signer global present)')
    : fail('C.1 content scripts not injected — extension may not have loaded on this host');

  if (!hasSigner) { await testPage.close(); fs.unlinkSync(testPagePath); return; }

  // Reload the keyring cache in content script (storage may not have fired onChanged yet)
  const keyInRing = await testPage.evaluate(async (h) => {
    await keyring.load();
    return !!keyring.get(h);
  }, keyData.hash8);
  keyInRing
    ? pass('C.2 extension keyring has fixture key')
    : fail('C.2 extension keyring missing key', 'storage may not have propagated to content script');

  if (!keyInRing) { await testPage.close(); fs.unlinkSync(testPagePath); return; }

  // Focus the textarea (sign-this-text.js uses activeElement)
  await testPage.focus('#compose');

  // Set up listener for sign.html tab BEFORE triggering the flow
  let signPageResolve;
  const signPagePromise = new Promise(r => { signPageResolve = r; });
  browser.on('targetcreated', async target => {
    const url = target.url();
    if (url.includes('/sign.html?') && url.includes('request_id=')) {
      const pg = await target.asPage();
      signPageResolve(pg);
    }
  });

  // Trigger SSD_SIGN_THIS from the extension SW → content script
  info('Sending SSD_SIGN_THIS via service worker…');
  try {
    await swEval(browser, `
      const tabs = await new Promise(r => chrome.tabs.query({}, r));
      const tab  = tabs.find(t => t.url && t.url.includes('sign-test-page'));
      if (!tab) throw new Error('sign-test-page tab not found; tabs: ' + tabs.map(t=>t.url).join(', '));
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { type: 'SSD_SIGN_THIS', source: 'test' }, resp => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(resp);
        });
      });
    `);
    info('SSD_SIGN_THIS delivered to content script');
  } catch (e) {
    fail('C.3 SSD_SIGN_THIS delivery', e.message);
    await testPage.close(); fs.unlinkSync(testPagePath); return;
  }

  // Wait for sign.html tab
  const signPage = await Promise.race([
    signPagePromise,
    sleep(12000).then(() => null),
  ]);

  if (!signPage) {
    fail('C.3 sign.html tab opened', 'timed out (12s) — SSD_SIGN_REQUEST may not have been sent or pwaUrl not set');
    await testPage.close(); fs.unlinkSync(testPagePath); return;
  }
  pass('C.3 sign.html tab opened');

  await sleep(1200); // DB check for pin_fallback_enabled runs async

  // Check preview
  const preview = await signPage.evaluate(() =>
    document.getElementById('preview')?.textContent?.trim()
  );
  if (preview && preview.includes('test post that needs to be signed')) {
    pass('C.4 sign.html preview shows compose text');
  } else {
    warn('C.4 sign.html preview', `got: "${preview?.slice(0,80)}"`);
  }

  // Enter PIN if form is visible
  const pinVis = await signPage.evaluate(() =>
    document.getElementById('pin-form')?.style?.display !== 'none'
  );
  if (pinVis) {
    pass('C.5 PIN form visible in sign.html');
    await signPage.type('#pin-input', PIN);
  } else {
    warn('C.5 PIN form not shown in sign.html', 'passkey flow would trigger — test needs PIN fallback');
    await testPage.close(); await signPage.close(); fs.unlinkSync(testPagePath); return;
  }

  await signPage.click('#sign-btn');
  info('Signed in sign.html — waiting for token in compose field…');

  // Poll compose textarea for [SSD:...] token (SW closes sign tab; token appends async)
  let token = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const val = await testPage.evaluate(() => document.getElementById('compose')?.value);
      const m = val?.match(/\[SSD:[^\]]+\]/);
      if (m) { token = m[0]; break; }
    } catch { break; } // test page may have navigated away if something failed
  }

  if (token) {
    pass('C.6 SSD token appended to compose textarea', token.slice(0,60)+'…');
  } else {
    const composeVal = await testPage.evaluate(() =>
      document.getElementById('compose')?.value
    ).catch(() => '(page gone)');
    fail('C.6 SSD token appended', `textarea: "${composeVal?.slice(0,100)}"`);
  }

  // Probe: verify the token's hash8 matches our fixture key
  if (token) {
    const tokenHash8 = token.match(/\[SSD:([0-9A-Fa-f]{8}):/)?.[1]?.toUpperCase();
    tokenHash8 === keyData.hash8.toUpperCase()
      ? probe('C.7 token hash8 matches fixture key', tokenHash8)
      : warn('C.7 token hash8', `expected ${keyData.hash8}, got ${tokenHash8}`);
  }

  await testPage.close();
  fs.unlinkSync(testPagePath);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let pwaProc, browser, userDataDir, tempExtDir;
  try {
    console.log('Starting PWA server on :8080…');
    pwaProc = startPwa();
    await sleep(1500);

    console.log('Launching Chrome with ssd-tick-2 extension…');
    ({ browser, userDataDir, tempExtDir } = await launchChrome());
    await sleep(3000); // extension SW startup

    // Sanity-check extension loaded
    const swTarget = await getSwTarget(browser);
    if (swTarget) {
      info('Extension service worker found', swTarget.url());
    } else {
      warn('Extension SW not found after 8s', 'check extension manifest_version and Chrome version');
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
    if (browser)     await browser.close().catch(() => {});
    if (pwaProc)     pwaProc.kill();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
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
