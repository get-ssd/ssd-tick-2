// Run: node test/test-reddit-whitespace.js [optional saved Reddit HTML path]
// Exercises the real Reddit extraction in a browser and real Ed25519 verification.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const puppeteer = require('puppeteer-core');
const { webcrypto } = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.canon = require('../core/canon');
globalThis.tokenParser = require('../core/token-parser');
const verifier = require('../core/verifier');
const source = fs.readFileSync(path.join(__dirname, '../platforms/reddit.js'), 'utf8');
const extraction = source.slice(source.indexOf('  const BLOCK_TAGS'), source.indexOf('  // [SSDKEY:'));
let checks = 0;
function check(label, test) { test(); checks++; console.log(`PASS ${label}`); }

(async () => {
  const executablePath = process.env.BROWSER_PATH || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
  const browser = await puppeteer.launch({ executablePath, headless: true, timeout: 15000,
    args: ['--disable-gpu'], userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tick-reddit-test-')) });
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', request => request.abort());
    async function extract(html) {
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      return page.evaluate(extraction => {
        const read = new Function(extraction + '\nreturn readPostTexts;')();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.parentElement.closest('script,style,noscript')) continue;
          const token = node.textContent.match(/\[SSD:[^\]]+\]/)?.[0];
          if (token) return { token, ...read(node, token) };
        }
        throw new Error('No content token found');
      }, extraction);
    }
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/reddit-double-space.html'), 'utf8');
    const original = await extract(fixture);
    const parsed = tokenParser.parse(original.token);
    check('rendered candidate keeps existing space collapse', () => assert(original.rawPostText.includes('find and use them')));
    check('alternative preserves double spaces and removes renderer indentation', () => {
      assert(original.candidates[0].includes('find and  use them'));
      assert(!original.candidates[0].includes('\n      '));
    });
    const oldRecovery = await verifier._canonWithGuesses(original.rawPostText, parsed.content8);
    check('old recovery fails for the regression', () => assert.equal(oldRecovery, null));
    const recovered = await verifier._canonWithGuesses(original.rawPostText, parsed.content8, original.candidates);
    check('recovered text matches the actual token hash', () => assert.equal(recovered.contentHash,
      'cc071131e40b6d01aca3005a85332d59872aebd9444cd781825ffab9ac82da21'));
    const normalHash = (await canon.canonicalise(original.rawPostText)).contentHash;
    const normal = await verifier._canonWithGuesses(original.rawPostText, normalHash.slice(0,8), original.candidates);
    check('ordinary rendered interpretation stays first', () => assert.equal(normal.contentHash, normalHash));
    const legacy = await verifier._canonWithGuesses(original.rawPostText, null, original.candidates);
    check('legacy token without content8 keeps its existing interpretation', () => assert.equal(legacy.contentHash, normalHash));

    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
    const hash8 = '1234ABCD', identity = 'rd:test', timestamp = '2026-10-07T12:00Z';
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey,
      new TextEncoder().encode(canon.buildPayload(hash8, identity, recovered.contentHash, timestamp)))).toString('base64url');
    const token = tokenParser.buildFull(hash8, identity, parsed.content8, signature, timestamp);
    globalThis.keyring = { get: () => ({ hash8, public_key: publicKey, name: 'Test signer' }),
      has: () => true, trustLevel: () => 'peer', isRevoked: () => false, isExpired: () => false };
    globalThis.vault = { query: async () => ({ canonical_text: recovered.canonicalText, timestamp }) };
    const signed = await extract(fixture.replace(original.token, token));
    const verified = await verifier.verify(signed.token, signed.rawPostText, signed.candidates);
    check('recovered candidate passes full Ed25519 verification', () => assert.equal(verified.state, 'VALID'));
    const tampered = await extract(fixture.replace(original.token, token).replace('who uses PGP today', 'who uses GPG today'));
    const changed = await verifier.verify(tampered.token, tampered.rawPostText, tampered.candidates);
    check('changed word is rejected', () => assert.equal(changed.state, 'MISMATCH'));
    const changedHash = (await canon.canonicalise(tampered.candidates[0])).contentHash.slice(0,8);
    const falseHint = tokenParser.buildFull(hash8, identity, changedHash, signature, timestamp);
    const hinted = await verifier.verify(falseHint, tampered.rawPostText, tampered.candidates);
    check('matching hash hint alone cannot bypass full signature verification', () => assert.equal(hinted.state, 'MISMATCH'));

    const inline = await extract(`<div><p>Whitespace stays across inline nodes: find and <em> use</em>  them.</p><p>${token}</p></div>`);
    check('spaces survive inline element boundaries', () => assert.equal(inline.candidates[0],
      'Whitespace stays across inline nodes: find and  use  them.'));
    const pre = await extract(`<div><pre>Code keeps  spaces\n\tand tabs exactly.</pre><p>${token}</p></div>`);
    check('preformatted code remains verbatim', () => assert.equal(pre.candidates[0], 'Code keeps  spaces\n\tand tabs exactly.'));
    if (process.argv[2]) {
      const saved = await extract(fs.readFileSync(process.argv[2], 'utf8'));
      const savedParsed = tokenParser.parse(saved.token);
      const savedResult = await verifier._canonWithGuesses(saved.rawPostText, savedParsed.content8, saved.candidates);
      check('full user-saved page recovers the signed content hash', () => assert.equal(savedResult.contentHash, recovered.contentHash));
    }
    console.log(`${checks} checks passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
