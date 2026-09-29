// test/test-token-parser.js — [SSD:] token parsing, incl. m.facebook.com line wraps.
// Run with: node test/test-token-parser.js

'use strict';

const tokenParser = require('../core/token-parser.js');

const SIG   = 'GY9xwtZyFZJayABOy_MTJ93awuHQk-btNWYkN2v7WF2wzaScWyrGwkiJeG4l_mVc_knibPaP8X3jeFZ9nIx-Dg';
const TOKEN = `[SSD:D3716480:fb:paul.perrin.9:7628ff91:${SIG}:2026-09-29T17:10Z]`;

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

console.log('\ntokenParser.parse');

{
  const r = tokenParser.parse(TOKEN);
  assert('full token parses',  r !== null);
  assert('hash8',              r && r.hash8 === 'D3716480');
  assert('identity',           r && r.identity === 'fb:paul.perrin.9');
  assert('content8',           r && r.content8 === '7628ff91');
  assert('signature',          r && r.signature === SIG);
  assert('timestamp',          r && r.timestamp === '2026-09-29T17:10Z');
}

{
  // As served by m.facebook.com on a 360px-wide portrait screen.
  const wrapped = `[SSD:D3716480:fb:paul.perrin.9:7628ff91:\n${SIG.slice(0, 30)}\n${SIG.slice(30, 66)}\n${SIG.slice(66)}:2026-09-29T17:10Z]`;
  const r = tokenParser.parse(wrapped);
  assert('line-wrapped token parses',        r !== null);
  assert('line-wrapped signature compacted', r && r.signature === SIG);
  assert('line-wrapped timestamp',           r && r.timestamp === '2026-09-29T17:10Z');
  assert('raw keeps page text (for readPostText)', r && r.raw === wrapped);
  tokenParser.PATTERN.lastIndex = 0;
  const m = tokenParser.PATTERN.exec(`This is a valid signed doc.\n\n${wrapped}`);
  assert('PATTERN spans the wraps', m !== null && m[0] === wrapped);
}

assert('rejects non-token', tokenParser.parse('[SSDKEY:D3716480:abc]') === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
