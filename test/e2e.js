// test/e2e.js — end-to-end test for ssd-tick-2
// Launches Chrome with the extension loaded, uses PWA mock mode to sign a post,
// then verifies the extension detects it on a local test page.
//
// Run from the ssd-tick-2 directory:
//   node test/e2e.js

const puppeteer  = require('../../ssd-tick/test/e2e/node_modules/puppeteer-core');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const readline   = require('readline');
const { spawn }  = require('child_process');

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, () => { rl.close(); resolve(); }));
}

const CHROME     = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_DIR    = path.resolve(__dirname, '..');
const PWA_URL    = 'http://localhost:8080/?mock';
const PWA_DIR    = path.resolve(__dirname, '..', '..', 'SignedSealedDelivered');
const TEST_PAGE  = 'ssd-test.html';
const DEBUG_PORT = 9223;

// Extension ID is derived from the extension directory path — stable on this machine.
// If you ever move the ssd-tick-2 directory, update this from the test's target list.
const EXT_ID = 'nkeimhogjdpnpccoofpliimaahmaaome';

const HOST_PERMS = [
  'http://localhost:8080/*',
  'http://127.0.0.1:8080/*',
  'https://www.facebook.com/*',
  'https://m.facebook.com/*',
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('Launching Chrome with ssd-tick-2 extension…');

  const userDataDir = path.join(os.tmpdir(), `ssd-chrome-${Date.now()}`);
  const defaultDir  = path.join(userDataDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });

  // Chrome 127+ requires developer mode ON and host permissions explicitly granted
  // before content scripts inject in a fresh profile. Pre-populate both so the test
  // is fully automated. The extension settings block uses the path-derived ID above.
  // If Chrome ignores this file (Secure Preferences mismatch), enable developer mode
  // manually in the Chrome window that opens — you only need to do this once per run.
  const prefs = {
    extensions: {
      developer_mode: true,
      settings: {
        [EXT_ID]: {
          location: 4,  // EXTERNAL_PREF — unpacked extension
          state:    1,  // ENABLED
          active_permissions:  { api: ['storage', 'windows'], explicit_host: HOST_PERMS, manifest_permissions: [] },
          granted_permissions: { api: ['storage', 'windows'], explicit_host: HOST_PERMS, manifest_permissions: [] },
        },
      },
    },
  };
  fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify(prefs), 'utf8');

  const extDirFwd  = EXT_DIR.replace(/\\/g, '/');
  const userDirFwd = userDataDir.replace(/\\/g, '/');

  const chromeProc = spawn(CHROME, [
    `--load-extension=${extDirFwd}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDirFwd}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: false, stdio: 'ignore' });

  chromeProc.on('error', err => { console.error('Chrome failed to start:', err); process.exit(1); });

  // Poll for Chrome debug port — loading an extension can take 6-8s on first launch
  let browser;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await sleep(1000);
    try {
      browser = await puppeteer.connect({
        browserURL: `http://localhost:${DEBUG_PORT}`,
        defaultViewport: null,
      });
      console.log(`  Connected after ${attempt}s`);
      break;
    } catch {
      process.stdout.write('.');
    }
  }
  if (!browser) {
    console.error('\nCould not connect to Chrome debug port after 12s — is Chrome already running?');
    chromeProc.kill();
    process.exit(1);
  }

  const targets = await browser.targets();
  console.log(`\nChrome targets (${targets.length}):`);
  for (const t of targets) console.log(`  [${t.type()}] ${t.url()}`);
  if (!targets.some(t => t.url().startsWith('chrome-extension://')))
    console.log('  ⚠ No extension targets — extension not loading');

  try {
    // ── Step 1: PWA mock setup ─────────────────────────────────────────────
    console.log('\n[1/4] Opening PWA in mock mode…');
    const pwaPage = await browser.newPage();
    await pwaPage.goto(PWA_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);

    console.log('      Clicking Setup Alice…');
    await pwaPage.click('button[onclick="test.setup(\'Alice\')"]');
    await pwaPage.waitForFunction(
      () => document.getElementById('mock-status')?.textContent?.includes('Ready'),
      { timeout: 10000 }
    );
    const status = await pwaPage.$eval('#mock-status', el => el.textContent);
    console.log(`      Status: ${status}`);

    // ── Step 2: Sign a post ────────────────────────────────────────────────
    console.log('\n[2/4] Signing a test post…');
    await pwaPage.evaluate(() => ui.showSection('socialSign'));
    await sleep(500);

    const testText = 'This post is signed with SSD — cryptographic proof of authorship. #SSD';
    await pwaPage.evaluate((text) => {
      const ta = document.getElementById('social-text');
      if (ta) { ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); }
      const id = document.getElementById('social-identity');
      if (id) { id.value = 'mock:alice'; id.dispatchEvent(new Event('input', { bubbles: true })); }
    }, testText);
    await sleep(300);

    await pwaPage.evaluate(() => app.previewSocialSign());
    await sleep(1000);
    await pwaPage.evaluate(() => app.confirmSocialSign());
    await sleep(2000);

    const signedText = await pwaPage.evaluate(() => {
      const out = document.getElementById('social-result-text');
      return out ? out.textContent.trim() : null;
    });

    if (!signedText || !signedText.includes('—SSD·')) {
      console.log('      PWA sign not captured — falling back to signed-post.txt');
      const fallback = fs.readFileSync(path.resolve(EXT_DIR, '..', 'signed-post.txt'), 'utf8');
      await testVerification(browser, fallback.trim());
    } else {
      console.log(`      Signed text captured (${signedText.length} chars)`);
      await testVerification(browser, signedText.trim());
    }

  } finally {
    console.log('\nDone. Browser will stay open for inspection — close it manually.');
  }
}

async function testVerification(browser, signedText) {
  console.log('\n[3/4] Building test page…');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>SSD Extension Test</title>
<style>
  body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; background: #f5f5f5; font-size: 15px; }
  h2   { color: #333; }
  .post {
    background: #fff; border-radius: 8px; padding: 20px;
    box-shadow: 0 1px 4px rgba(0,0,0,.15);
    white-space: pre-wrap; word-break: break-all;
    line-height: 1.5; position: relative;
  }
  p { color: #888; font-size: 13px; }
</style>
</head>
<body>
<h2>SSD Extension Test</h2>
<div class="post" role="article">${signedText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
<p>The extension should detect the token above and inject a badge.</p>
</body>
</html>`;

  const testPagePath = path.join(PWA_DIR, TEST_PAGE);
  fs.writeFileSync(testPagePath, html, 'utf8');
  console.log(`      Written: ${testPagePath}`);

  console.log('\n[4/4] Opening test page — watching for SSD badge…');
  const testPage = await browser.newPage();

  testPage.on('console', msg => {
    if (msg.text().includes('[SSD]') || msg.type() === 'error')
      console.log(`  [page:${msg.type()}] ${msg.text()}`);
  });
  testPage.on('pageerror', err => console.log(`  [page error] ${err.message}`));

  await testPage.goto(`http://localhost:8080/${TEST_PAGE}`, { waitUntil: 'networkidle0' });
  await sleep(4000);

  const result = await testPage.evaluate(() => {
    const el = document.querySelector('.ssd-indicator');
    return {
      found:       !!el,
      text:        el?.textContent?.trim() ?? null,
      state:       el?.dataset?.ssdState ?? null,
      styleSheets: document.styleSheets.length,
      tokenInPage: document.body.textContent.includes('—SSD·'),
    };
  });

  console.log(`\n  Stylesheets on page: ${result.styleSheets}`);
  console.log(`  Token in page text:  ${result.tokenInPage}`);

  if (!result.found) {
    console.log('\n  Content script did not inject. In the Chrome window that opened:');
    console.log('    1. Open a new tab → chrome://extensions');
    console.log('    2. Enable Developer mode (top-right toggle)');
    console.log('    3. Click "Load unpacked" → select the ssd-tick-2 folder:');
    console.log(`       ${EXT_DIR}`);
    console.log('    4. Come back here and press Enter — the test page will reload.');
    await waitForEnter('\n  Press Enter when ready… ');
    await testPage.reload({ waitUntil: 'networkidle0' });
    await sleep(4000);
    Object.assign(result, await testPage.evaluate(() => {
      const el = document.querySelector('.ssd-indicator');
      return {
        found:       !!el,
        text:        el?.textContent?.trim() ?? null,
        state:       el?.dataset?.ssdState ?? null,
        styleSheets: document.styleSheets.length,
        tokenInPage: document.body.textContent.includes('—SSD·'),
      };
    }));
  }

  if (result.found) {
    const isGreen = result.state === 'VALID';
    console.log(`\n${isGreen ? '✓' : '~'} Badge: "${result.text}" (state=${result.state})`);
    if (isGreen)
      console.log('  → Green tick — signature verified against known key.');
    else if (result.state === 'KEY_UNREACHABLE')
      console.log('  → Import a key card via the extension popup to see the green tick.');
    console.log('\n✓ PASS — extension scanning + badge injection confirmed');
  } else {
    console.log('\n✗ Badge still not found after reload — check the extension loaded correctly.');
    process.exit(1);
  }

  console.log('\nToken used:\n' + '─'.repeat(60));
  console.log(signedText);
  console.log('─'.repeat(60));
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
