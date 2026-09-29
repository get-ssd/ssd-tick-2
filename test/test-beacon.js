// test/test-beacon.js — conformance test for [SSDKEY:] parse + self-check.
// Run with: node test/test-beacon.js
// Requires Node 18+ (globalThis.crypto available).

'use strict';

// Make WebCrypto available at globalThis.crypto for verifySelfConsistency.
const nodeCrypto = require('crypto');
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;
// atob is global from Node 16+; polyfill for earlier Node if needed.
if (!globalThis.atob) globalThis.atob = (b) => Buffer.from(b, 'base64').toString('binary');

const ts = require('../scanners/text-scanner.js');
const { parseKeyBeacon, SSDKEY_PATTERN, verifySelfConsistency } = ts;

// Reference vector (computed; valid)
// pubkey:  AiMocrwnWLA9MXfWMIOKphcqY9_WmcMYZOt77mw3ukU  (43-char base64url no-pad, 32 bytes)
// hash8:   8588FECC  (= hex(SHA-256(raw 32-byte pubkey))[0:8], uppercased)
const VALID_PUBKEY = 'AiMocrwnWLA9MXfWMIOKphcqY9_WmcMYZOt77mw3ukU';
const VALID_HASH8  = '8588FECC';
const VALID_BEACON = `[SSDKEY:${VALID_HASH8}:${VALID_PUBKEY}]`;

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

// ── parseKeyBeacon ────────────────────────────────────────────────────────────

console.log('\nparseKeyBeacon');

{
  const r = parseKeyBeacon(VALID_BEACON);
  assert('valid beacon parses',      r !== null);
  assert('hash8 correct',            r && r.hash8  === VALID_HASH8);
  assert('pubkey correct',           r && r.pubkey === VALID_PUBKEY);
}

{
  // m.facebook.com portrait: server-side wrap puts a newline inside the pubkey.
  const r = parseKeyBeacon(`[SSDKEY:${VALID_HASH8}:${VALID_PUBKEY.slice(0, 20)}\n${VALID_PUBKEY.slice(20)}]`);
  assert('line-wrapped beacon parses', r !== null && r.pubkey === VALID_PUBKEY);
  SSDKEY_PATTERN.lastIndex = 0;
  const m = SSDKEY_PATTERN.exec(`bio [SSDKEY:${VALID_HASH8}:${VALID_PUBKEY.slice(0, 8)}-\n${VALID_PUBKEY.slice(8)}] more`);
  assert('pattern spans the wrap', m !== null && m[0].includes('\n'));
}

assert('rejects wrong hash8 length',    parseKeyBeacon('[SSDKEY:ABCDE:' + VALID_PUBKEY + ']') === null);
assert('rejects lowercase hash8',       parseKeyBeacon('[SSDKEY:8588fecc:' + VALID_PUBKEY + ']') === null);
assert('rejects pubkey < 43 chars',     parseKeyBeacon('[SSDKEY:' + VALID_HASH8 + ':shortkey]') === null);
assert('rejects pubkey > 43 chars',     parseKeyBeacon('[SSDKEY:' + VALID_HASH8 + ':' + VALID_PUBKEY + 'X]') === null);
assert('rejects standard-base64 +',     parseKeyBeacon('[SSDKEY:' + VALID_HASH8 + ':' + VALID_PUBKEY.replace('_', '+') + ']') === null);
// Replace last char with '/' (VALID_PUBKEY has no '-', so replace a known char)
assert('rejects standard-base64 /',     parseKeyBeacon('[SSDKEY:' + VALID_HASH8 + ':' + VALID_PUBKEY.slice(0, 42) + '/]') === null);
assert('rejects padding =',             parseKeyBeacon('[SSDKEY:' + VALID_HASH8 + ':' + VALID_PUBKEY.slice(0, 42) + '=]') === null);
assert('[SSD:] content token not matched as beacon', parseKeyBeacon('[SSD:8588FECC:fb:j.smith:abcdef01:' + 'A'.repeat(86) + ':2026-06-20T12:00Z]') === null);
assert('null on non-beacon string', parseKeyBeacon('hello world') === null);

// X-profile paren form — X profiles cannot hold square brackets.
const VALID_PAREN_BEACON = `(SSDKEY:${VALID_HASH8}:${VALID_PUBKEY})`;
{
  const r = parseKeyBeacon(VALID_PAREN_BEACON);
  assert('paren beacon parses',        r !== null);
  assert('paren hash8 correct',        r && r.hash8  === VALID_HASH8);
  assert('paren pubkey correct',       r && r.pubkey === VALID_PUBKEY);
}
assert('rejects mixed delimiters [ )', parseKeyBeacon('[SSDKEY:' + VALID_HASH8 + ':' + VALID_PUBKEY + ')') === null);
assert('rejects mixed delimiters ( ]', parseKeyBeacon('(SSDKEY:' + VALID_HASH8 + ':' + VALID_PUBKEY + ']') === null);

// ── SSDKEY_PATTERN ────────────────────────────────────────────────────────────

console.log('\nSSDKEY_PATTERN');

{
  const text = `Before ${VALID_BEACON} after`;
  SSDKEY_PATTERN.lastIndex = 0;
  const m = SSDKEY_PATTERN.exec(text);
  assert('pattern matches valid beacon in text', m !== null && m[0] === VALID_BEACON);
}

{
  const text = 'No beacon here [SSD:8588FECC:fb:j.smith:abcdef01:AAAA:2026-06-20T12:00Z]';
  SSDKEY_PATTERN.lastIndex = 0;
  assert('[SSD:] token not matched by SSDKEY_PATTERN', SSDKEY_PATTERN.exec(text) === null);
}

{
  const text = `X bio with ${VALID_PAREN_BEACON} inside`;
  SSDKEY_PATTERN.lastIndex = 0;
  const m = SSDKEY_PATTERN.exec(text);
  assert('pattern matches paren beacon in text', m !== null && m[0] === VALID_PAREN_BEACON);
}

// ── verifySelfConsistency — answers the two brief ambiguities ─────────────────
// Ambiguity 1: hash input = raw decoded bytes (not base64url string)
// Ambiguity 2: case = computed hex uppercased before comparing; hash8 must be uppercase
// Both confirmed from source code and from the test vector below.

console.log('\nverifySelfConsistency');

async function runAsyncTests() {
  assert('valid vector passes self-check',
    await verifySelfConsistency(VALID_HASH8, VALID_PUBKEY));

  // Flip one hex digit in hash8 — self-check must reject
  const badHash8 = VALID_HASH8.slice(0, 7) + (VALID_HASH8[7] === 'C' ? 'D' : 'C');
  assert('flipped hash8 digit rejected',
    !(await verifySelfConsistency(badHash8, VALID_PUBKEY)));

  // Confirm hash is over raw bytes not the string:
  // SHA-256 of the *string* "AiMocrwnWLA9MXfWMIOKphcqY9_WmcMYZOt77mw3ukU" starts with 1c69996b
  // — the real check uses raw bytes, which gives 8588fecc (uppercased → 8588FECC).
  assert('hash over raw bytes not string (vector discriminates)',
    await verifySelfConsistency(VALID_HASH8, VALID_PUBKEY));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

runAsyncTests().catch(e => { console.error(e); process.exit(1); });
