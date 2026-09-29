// test/test-reflow.js — verifier matches m.facebook.com viewport-wrapped post text.
// Run with: node test/test-reflow.js

'use strict';

if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
globalThis.canon = require('../core/canon.js');
const verifier = require('../core/verifier.js');

// Signed long post (ssd-v92, 2026-09-29): content8 79ffd11d.
const SIGNED = 'Long post (from telegraph)\n\ndy Burnham will end the triple lock in 2030 to pay for free social care.\n\nThe Prime Minister announced that the policy would be replaced by a double lock,\nwith the state pension rising by inflation or a minimum of 2.5 per cent. The\nlink with annual earnings growth would be scrapped.\n\nHe pledged to tackle the issues politicians “usually avoid” in his first\nconference speech as Labour leader, which also covered electoral reform, social\ncare and relations with the EU.';
const C8 = '79ffd11d';

// Greedy wrap at `w` columns, like m.facebook.com on a narrow screen.
function viewportWrap(text, w) {
  return text.split('\n\n').map(p => {
    const words = p.replace(/\n/g, ' ').split(' ');
    const lines = []; let cur = '';
    for (const word of words) {
      if (cur && (cur + ' ' + word).length > w) { lines.push(cur); cur = word; }
      else cur = cur ? cur + ' ' + word : word;
    }
    if (cur) lines.push(cur);
    return lines.join('\n');
  }).join('\n\n');
}

let passed = 0, failed = 0;
function assert(label, ok) { if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}`); failed++; } }

(async () => {
  console.log('\n_canonWithGuesses');
  assert('signed text as-is matches', !!(await verifier._canonWithGuesses(SIGNED, C8)));
  for (const w of [46, 60, 33]) {
    assert(`viewport-wrapped at ${w} matches`, !!(await verifier._canonWithGuesses(viewportWrap(SIGNED, w), C8)));
  }
  const tampered = viewportWrap(SIGNED, 46).replace('2.5 per cent', '3 per cent');
  assert('changed word still fails', (await verifier._canonWithGuesses(tampered, C8)) === null);
  const hyph = 'A well-\nknown fact.';
  const r = await verifier._canonWithGuesses(hyph, (await canon.canonicalise('A well-known fact.')).contentHash.slice(0, 8));
  assert('break after hyphen joins without space', !!r);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
