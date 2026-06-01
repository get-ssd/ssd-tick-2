// test/e2e.js — end-to-end test for ssd-tick-2
// Launches Chrome directly with the extension, uses PWA mock mode to sign a post,
// then verifies the extension detects it on a local test page.
//
// Run from the ssd-tick-2 directory:
//   node test/e2e.js

const puppeteer    = require('../../ssd-tick/test/e2e/node_modules/puppeteer-core');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const { spawn }    = require('child_process');

const CHROME      = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_DIR     = path.resolve(__dirname, '..');
const PWA_URL     = 'http://localhost:8080/?mock';
const PWA_DIR     = path.resolve(__dirname, '..', '..', 'SignedSealedDelivered');
const TEST_PAGE   = 'ssd-test.html';
const DEBUG_PORT  = 9223;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('Launching Chrome with ssd-tick-2 extension…');

  // Launch Chrome directly — puppeteer.launch() can pick wrong binary.
  // Using spawn + remote-debugging-port + puppeteer.connect() guarantees we
  // get the real Chrome with the extension loaded.
  const userDataDir = path.join(os.tmpdir(), `ssd-chrome-${Date.now()}`);
  // Forward slashes — Chrome on Windows can choke on backslashes in flags.
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

  // Wait for Chrome to open the debug port.
  await sleep(3000);

  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: `http://localhost:${DEBUG_PORT}`,
      defaultViewport: null,
    });
  } catch (err) {
    console.error('Could not connect to Chrome debug port:', err.message);
    chromeProc.kill();
    process.exit(1);
  }

  // Diagnose: list ALL Chrome targets.
  const targets = await browser.targets();
  console.log(`\nAll Chrome targets (${targets.length}):`);
  for (const t of targets) console.log(`  [${t.type()}] ${t.url()}`);
  const extTargets = targets.filter(t => t.url().startsWith('chrome-extension://'));
  if (extTargets.length === 0) console.log('  ⚠ No extension targets at all — extension not loading');

  try {
    // ── Step 1: PWA mock setup ─────────────────────────────────────────────
    console.log('\n[1/4] Opening PWA in mock mode…');
    const pwaPage = await browser.newPage();
    await pwaPage.goto(PWA_URL, { waitUntil: 'networkidle0' });
    await sleep(1000);

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
<div class="post" role="article">${signedText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
<p>The extension should detect the token above and inject a badge.</p>
</body>
</html>`;

  const testPagePath = path.join(PWA_DIR, TEST_PAGE);
  fs.writeFileSync(testPagePath, html, 'utf8');
  console.log(`      Written: ${testPagePath}`);

  console.log('\n[4/4] Opening test page — watching for SSD badge…');
  const testPage = await browser.newPage();

  testPage.on('console', msg => {
    if (msg.text().includes('SSD') || msg.type() === 'error')
      console.log(`  [page:${msg.type()}] ${msg.text()}`);
  });
  testPage.on('pageerror', err => console.log(`  [page error] ${err.message}`));

  await testPage.goto(`http://localhost:8080/${TEST_PAGE}`, { waitUntil: 'networkidle0' });
  await sleep(4000);

  const result = await testPage.evaluate(() => {
    const el = document.querySelector('.ssd-indicator');
    // Check for extension CSS by looking for a style element or link injected by Chrome.
    // Can't read cssRules cross-origin, so just count stylesheets and check for any ssd class.
    const styleSheetCount = document.styleSheets.length;
    const hasSsdClass = document.body.innerHTML.includes('ssd-indicator') ||
                        document.body.innerHTML.includes('ssd-sign');
    return {
      found: !!el,
      text: el?.textContent?.trim() ?? null,
      styleSheetCount,
      hasSsdClass,
      tokenInPage: document.body.textContent.includes('—SSD·'),
    };
  });

  console.log(`\n  Stylesheets on page: ${result.styleSheetCount}`);
  console.log(`  Token in page text:  ${result.tokenInPage}`);
  console.log(`  SSD class in DOM:    ${result.hasSsdClass}`);
  if (result.found) {
    console.log(`\n✓ PASS — badge injected: "${result.text}"`);
  } else {
    console.log('\n✗ Badge not found');
    if (!result.hasCss) console.log('  → Content script not running on this page');
  }

  console.log('\nToken used:\n' + '─'.repeat(60));
  console.log(signedText);
  console.log('─'.repeat(60));
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
