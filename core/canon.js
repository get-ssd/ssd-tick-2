// core/canon.js
// Canonicalisation algorithm CANON-1 .. CANON-9 (CANON-Spec-v0_1.md §4).
//
// This is the shared contract between signer (PWA compose plugin) and verifier
// (this extension). Both must produce identical output from the same input.
//
// Two invariants must hold (CANON-Spec §1):
//   1. Idempotency:
//        contentHash(canonicalise(canonicalise(t))) === contentHash(canonicalise(t))
//   2. Render-canonicalise commutativity (BOTH directions, CANON-Spec §1):
//        contentHash(canonicalise(render_1_0(t))) === contentHash(canonicalise(t))
//        render_1_0(canonicalise(t)) === canonicalise(t)
//
//      The second equation forces canonical text to already be word-wrapped at
//      80 chars — otherwise render_1_0 (which wraps at 80) would not be a no-op
//      on it. So canonicalisation reaches the SAME fixed point as ssd-render-1.0
//      by performing the identical 80-char word-wrap as its final text step
//      (CANON-7a, below). Then:
//        - render_1_0(canonicalise(t)) == canonicalise(t)  — already wrapped, no-op.
//        - canonicalise(render_1_0(t)) == canonicalise(t)  — both apply the same
//          idempotent wrap; wrap(wrap(t)) == wrap(t).
//      The wrap is idempotent, which also keeps the whole algorithm idempotent.
//      The CANON-2..9 normalisation steps below match CANON-Spec exactly; the
//      wrap is the deliberate addition the render invariant requires.

const canon = {

  // ssd-render-1.0 word-wrap: greedy word-wrap each line at 80 columns by
  // inserting \n. Idempotent — re-wrapping already-wrapped text is a no-op
  // because every produced line is <= 80 chars. A single word longer than 80
  // chars is left intact on its own line (never split mid-word).
  WRAP_WIDTH: 80,
  wrap(text) {
    const W = this.WRAP_WIDTH;
    return text.split('\n').map(line => {
      if (line.length <= W) return line;
      const words = line.split(' ');
      const out = [];
      let cur = '';
      for (const word of words) {
        if (cur === '') {
          cur = word;
        } else if ((cur + ' ' + word).length <= W) {
          cur += ' ' + word;
        } else {
          out.push(cur);
          cur = word;
        }
      }
      if (cur !== '') out.push(cur);
      return out.join('\n');
    }).join('\n');
  },

  // Apply the full canonicalisation algorithm to raw post text.
  // Returns { canonicalText, contentHash } where contentHash is lowercase hex.
  async canonicalise(rawText) {
    let text = typeof rawText === 'string' ? rawText : String(rawText ?? '');

    // CANON-1: split at the LAST occurrence of "[SSD:", take everything before.
    //   A post quoting another signed post has two [SSD: occurrences; the
    //   author's own token is always appended last. Splitting at the LAST gives
    //   the correct signed content. If no token is present the whole text is
    //   signed content.
    const lastTokenIdx = text.lastIndexOf('[SSD:');
    if (lastTokenIdx !== -1) {
      text = text.slice(0, lastTokenIdx);
    }

    // CANON-2: NFC unicode normalisation (normalise composed forms).
    text = text.normalize('NFC');

    // CANON-3: normalise all line endings to LF. \r\n → \n, lone \r → \n.
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // CANON-4: strip trailing whitespace (spaces, tabs) from each line.
    text = text.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n');

    // CANON-5: strip leading blank lines.
    text = text.replace(/^\n+/, '');

    // CANON-6: strip trailing blank lines (collapse any run of trailing \n).
    text = text.replace(/\n+$/, '');

    // CANON-7a: word-wrap at 80 chars (ssd-render-1.0 fixed point). This makes
    // render and canonicalise null operations on each other. Idempotent.
    text = this.wrap(text);

    // CANON-7: ensure a single trailing LF.
    text = text + '\n';

    // CANON-8: encode as UTF-8 bytes.
    const bytes = new TextEncoder().encode(text);

    // CANON-9: SHA-256 → lowercase hex.
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const contentHash = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return { canonicalText: text, contentHash };
  },

  // Build the signed payload string (PROTO-Spec v0.4 §5):
  //   {hash8}:{identity}:{content-hash}:{timestamp}
  buildPayload(hash8, identity, contentHash, timestamp) {
    return `${hash8}:${identity}:${contentHash}:${timestamp}`;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = canon;
