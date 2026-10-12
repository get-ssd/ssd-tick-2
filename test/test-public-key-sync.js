// Real extension + real PWA/IndexedDB, using an isolated disposable browser.
// Build Chrome first. Run: node test/test-public-key-sync.js
// Add --firefox for a real Firefox bridge smoke check (build Firefox first).
// Optional BROWSER_PATH / TICK_EXTENSION_DIR.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash, generateKeyPairSync } = require('node:crypto');
const puppeteer = require('puppeteer-core');
const tickKeyring = require('../core/keyring');
const pwa = path.resolve(__dirname, '../../ssd.signed-sealed-delivered');
const firefox = process.argv.includes('--firefox');
const extension = process.env.TICK_EXTENSION_DIR || path.resolve(__dirname, firefox ? '../dist/ssd-tick-firefox.xpi' : '../dist/chrome');
let passed = 0;
const check = (label, fn) => { fn(); console.log(`PASS ${label}`); passed++; };
function key(name, extra = {}) {
  const bytes = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { name, hash8: createHash('sha256').update(bytes).digest('hex').slice(0, 8).toUpperCase(),
    public_key_b64: bytes.toString('base64'), ...extra };
}
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(pwa, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(pwa + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(bytes);
  });
});

(async () => {
  let browser;
  try {
    check('explicit unverified trust overrides direct-import provenance', () => assert.equal(tickKeyring.trustLevel({ source: 'direct', trust_type: 'unverified' }), 'unverified'));
    check('explicit peer trust and legacy discovery provenance are retained', () => {
      assert.equal(tickKeyring.trustLevel({ source: 'url', trust_type: 'peer' }), 'peer');
      assert.equal(tickKeyring.trustLevel({ source: 'profile' }), 'unverified');
      assert.equal(tickKeyring.isRevoked({ is_quarantined: true }), true);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    console.log(`Starting disposable ${firefox ? 'Firefox' : 'Chrome'}…`);
    const profile = fs.mkdtempSync(path.resolve(pwa, '../.scratch/tick-sync-browser-'));
    browser = await puppeteer.launch({ browser: firefox ? 'firefox' : 'chrome',
      executablePath: process.env.BROWSER_PATH || (firefox ? 'C:/Program Files/Mozilla Firefox/firefox.exe' : 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
      headless: true, pipe: !firefox, userDataDir: profile, enableExtensions: true, timeout: 60000,
      ...(firefox ? { extraPrefsFirefox: { 'xpinstall.signatures.required': false } } : { args: ['--disable-gpu'] }) });
    console.log('Loading built Tick extension…');
    const id = await browser.installExtension(extension);
    console.log('Opening Tick and SSD…');
    if (firefox) {
      const page = await browser.newPage();
      page.on('dialog', dialog => dialog.accept());
      await page.goto(origin + '/?mock');
      await page.waitForFunction('typeof tickSync !== "undefined" && typeof app !== "undefined"');
      await page.evaluate(async owner => { await db.put('my_keys', owner); await app.tab('keys'); }, key('O:Firefox test', { id: 'owner' }));
      await page.click('#keys-tick-sync');
      await page.waitForFunction('!document.getElementById("keys-tick-sync").disabled');
      const result = await page.$eval('#keys-tick-sync-result', node => node.textContent);
      check('Firefox extension and PWA exchange public keys', () => assert.match(result, /0 added to SSD, 1 added to Tick/));
      await page.click('#keys-tick-sync');
      await page.waitForFunction('!document.getElementById("keys-tick-sync").disabled');
      const repeated = await page.$eval('#keys-tick-sync-result', node => node.textContent);
      check('Firefox repeat is idempotent', () => assert.match(repeated, /0 added to SSD, 0 added to Tick/));
      console.log(`${passed} Firefox checks passed`);
      return;
    }
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    const storage = () => popup.evaluate(() => chrome.storage.local.get(['keystore', 'owner']));
    const setStorage = value => popup.evaluate(value => chrome.storage.local.set(value), value);
    const owner = key('O:Test user', { id: 'owner', private_key_enc: 'PRIVATE_SSD_MARKER' });
    const device = key('D:Test device', { id: 'device' });
    const ssdOnly = key('SSD contact', { id: 'ssd-contact', trust_type: 'peer' });
    const tickOnly = key('Tick discovery', { source: 'profile' });
    const revoked = key('SSD name', { id: 'revoked', trust_type: 'peer', is_revoked: true });
    const quarantine = key('Quarantined', { id: 'quarantine', trust_type: 'peer', is_quarantined: false });
    const asTick = (row, overrides = {}) => ({ hash8: row.hash8, name: row.name, public_key: row.public_key_b64, source: 'direct', ...overrides });
    await setStorage({ owner: null, keystore: {
      [tickOnly.hash8]: asTick(tickOnly, { source: 'profile', private_material: 'PRIVATE_TICK_MARKER' }),
      [revoked.hash8]: asTick(revoked, { name: 'Tick name', source: 'url' }),
      [quarantine.hash8]: asTick(quarantine, { is_quarantined: true }),
    } });
    let page = await browser.newPage();
    let accept = true;
    page.on('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
    await page.goto(origin + '/?mock');
    await page.waitForFunction('typeof tickSync !== "undefined" && typeof app !== "undefined"');
    await page.evaluate(async rows => {
      for (const row of rows.own) await db.put('my_keys', row);
      for (const row of rows.contacts) await db.put('contact_keys', row);
      window.syncMessages = [];
      window.addEventListener('message', event => {
        if (event.data?.channel === 'SSD_TICK_KEYS_V1') window.syncMessages.push(event.data);
      });
      await app.tab('keys');
    }, { own: [owner, device], contacts: [ssdOnly, revoked, quarantine] });
    const click = async () => {
      await page.click('#keys-tick-sync');
      await page.waitForFunction('!document.getElementById("keys-tick-sync").disabled');
      return page.$eval('#keys-tick-sync-result', node => node.textContent);
    };
    const first = await click();
    check('button merges real PWA and extension stores', () => assert.match(first, /1 added to SSD, 3 added to Tick/));
    const contacts = await page.evaluate(() => db.getAll('contact_keys'));
    const tick = await storage();
    check('Tick discovery stays unverified in SSD', () => assert.equal(contacts.find(k => k.hash8 === tickOnly.hash8).trust_type, 'unverified'));
    check('both sides retain their existing name and provenance', () => {
      assert.equal(contacts.find(k => k.hash8 === revoked.hash8).name, 'SSD name');
      assert.equal(tick.keystore[revoked.hash8].name, 'Tick name');
      assert.equal(tick.keystore[revoked.hash8].source, 'url');
    });
    check('revocation reaches Tick; quarantine reaches SSD', () => {
      assert.equal(tick.keystore[revoked.hash8].revoked, true);
      assert.equal(contacts.find(k => k.hash8 === quarantine.hash8).is_quarantined, true);
    });
    check('Tick is associated with the selected SSD owner', () => assert.equal(tick.owner.hash8, owner.hash8));
    const messages = await page.evaluate(() => JSON.stringify(window.syncMessages));
    check('private fields never enter either direction of the bridge', () => assert.doesNotMatch(messages, /PRIVATE_|private_key_enc|private_material/));
    const repeat = await click();
    check('second click adds no duplicate keys', () => assert.match(repeat, /0 added to SSD, 0 added to Tick/));
    accept = false;
    const beforeCancel = JSON.stringify(await storage());
    const contactsBeforeCancel = await page.evaluate(async () => JSON.stringify(await db.getAll('contact_keys')));
    const cancelled = await click();
    check('cancel reports cancellation without extension writes', () => {
      assert.match(cancelled, /cancelled/);
    });
    assert.equal(JSON.stringify(await storage()), beforeCancel);
    assert.equal(await page.evaluate(async () => JSON.stringify(await db.getAll('contact_keys'))), contactsBeforeCancel);
    accept = true;
    const other = key('O:Other owner');
    await setStorage({ owner: { hash8: other.hash8, name: other.name, public_key: other.public_key_b64 } });
    const refused = await click();
    check('wrong-owner response identifies the problem', () => assert.match(refused, /Tick belongs to O:Other owner/));
    await setStorage({ owner: tick.owner });
    const interruptedTick = key('New Tick discovery', { source: 'url' });
    const interruptedSSD = key('New SSD contact', { id: 'interrupted-ssd', trust_type: 'peer' });
    const preInterrupt = await storage();
    await setStorage({ keystore: { ...preInterrupt.keystore,
      [interruptedTick.hash8]: asTick(interruptedTick, { source: 'url' }) } });
    await page.evaluate(async row => {
      await db.put('contact_keys', row);
      tickSync._originalRequest = tickSync._request;
      tickSync._request = function(action, ...args) {
        if (action === 'merge') return Promise.reject(new Error('Simulated connection interruption.'));
        return this._originalRequest(action, ...args);
      };
    }, interruptedSSD);
    const interrupted = await click();
    check('interrupted second half clearly reports committed SSD additions', () => assert.match(interrupted, /SSD additions were kept/));
    assert.equal((await storage()).keystore[interruptedSSD.hash8], undefined);
    assert.equal(await page.evaluate(async hash => (await db.getAll('contact_keys')).filter(k => k.hash8 === hash).length, interruptedTick.hash8), 1);
    await page.evaluate(() => { tickSync._request = tickSync._originalRequest; delete tickSync._originalRequest; });
    const recovered = await click();
    check('retry completes interrupted sync without duplicate imports', () => assert.match(recovered, /0 added to SSD, 1 added to Tick/));
    const rollbackFirst = key('Would be added before conflict');
    const conflict = key('Conflicting stored public bytes');
    const intact = await storage();
    await setStorage({ keystore: { [rollbackFirst.hash8]: asTick(rollbackFirst), [conflict.hash8]: asTick(conflict), ...intact.keystore } });
    await page.evaluate(async row => db.put('contact_keys', row), {
      id: 'corrupt-collision', name: conflict.name, hash8: conflict.hash8, public_key_b64: other.public_key_b64,
    });
    const conflictCount = await page.evaluate(async () => (await db.getAll('contact_keys')).length);
    const conflictResult = await click();
    check('full-key mismatch aborts the entire SSD transaction', () => assert.match(conflictResult, /Conflicting public key/));
    assert.equal(await page.evaluate(async () => (await db.getAll('contact_keys')).length), conflictCount);
    assert.equal(await page.evaluate(async hash => (await db.getAll('contact_keys')).some(k => k.hash8 === hash), rollbackFirst.hash8), false);
    await page.evaluate(() => db.del('contact_keys', 'corrupt-collision'));
    await setStorage({ keystore: intact.keystore });
    const invalid = key('Bad fingerprint');
    const saved = await storage();
    await setStorage({ keystore: { ...saved.keystore, BADHASH8: asTick(invalid, { hash8: 'BADHASH8' }) } });
    const countBefore = await page.evaluate(async () => (await db.getAll('contact_keys')).length);
    const bad = await click();
    check('malformed fingerprint prevents imports', () => assert.match(bad, /fingerprint mismatch/));
    assert.equal(await page.evaluate(async () => (await db.getAll('contact_keys')).length), countBefore);
    await setStorage({ keystore: saved.keystore });
    // Opening another project on the same localhost origin must not expose keys.
    const unrelated = await browser.newPage();
    await unrelated.goto(origin + '/sign.html');
    const exposed = await unrelated.evaluate(() => new Promise(resolve => {
      window.addEventListener('message', event => {
        if (event.data?.channel === 'SSD_TICK_KEYS_V1' && event.data.direction === 'response') resolve(true);
      });
      window.postMessage({ channel: 'SSD_TICK_KEYS_V1', direction: 'request', id: 'test', action: 'hello' }, location.origin);
      setTimeout(() => resolve(false), 300);
    }));
    check('bridge ignores non-PWA paths', () => assert.equal(exposed, false));
    const advanced = await browser.newPage();
    advanced.on('dialog', dialog => dialog.accept());
    const errors = [];
    advanced.on('pageerror', error => errors.push(error.message));
    await advanced.goto(origin + '/advanced.html?mock');
    await advanced.waitForFunction('typeof tickSync !== "undefined" && typeof app !== "undefined"');
    check('advanced shell exposes the same button and helper', () => assert.equal(errors.length, 0));
    assert.equal(await advanced.$eval('#keys-tick-sync', node => node.textContent), 'Sync public keys with Tick');
    await advanced.evaluate(async owner => {
      await db.put('my_keys', owner);
      ui.showSection('keyring');
    }, owner);
    await advanced.click('#keys-tick-sync');
    await advanced.waitForFunction('!document.getElementById("keys-tick-sync").disabled');
    const advancedResult = await advanced.$eval('#keys-tick-sync-result', node => node.textContent);
    check('advanced button completes a sync and refreshes its keys', () => assert.match(advancedResult, /Synced:/));
    // A fresh incognito context has no extension access by default. Avoid
    // uninstalling a live extension with its background/popup targets attached.
    console.log('Checking SSD without Tick in a separate browser context…');
    const withoutTick = await browser.createBrowserContext();
    page = await withoutTick.newPage();
    await page.goto(origin + '/?mock');
    await page.waitForFunction('typeof tickSync !== "undefined"');
    await page.evaluate(async owner => { await db.put('my_keys', owner); await app.tab('keys'); }, owner);
    const absent = await click();
    check('missing Tick is reported with no imports', () => assert.match(absent, /Tick is not available/));
    assert.equal(await page.evaluate(async () => (await db.getAll('contact_keys')).length), 0);
    console.log(`${passed} checks passed`);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
