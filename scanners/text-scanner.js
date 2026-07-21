// scanners/text-scanner.js
// Scans the page for [SSD:...] content tokens and [SSDKEY:...] key beacons.
// Each content-token text node is its own context — one badge per context.

// Parse a [SSDKEY:...] beacon string. Returns { hash8, pubkey } or null.
// Format: [SSDKEY:{8-char-uppercase-hex}:{43-char-base64url-no-pad}]
// X quirk: X profiles cannot hold square brackets, so on X profiles — and only
// there — the beacon is parenthesised: (SSDKEY:...). Both forms parse.
// SHA-256 self-consistency (hash8 == first 8 hex chars of SHA-256(pubkey_bytes))
// is NOT checked here — it requires async crypto and is done by the handler.
function parseKeyBeacon(raw) {
  const bracketed = raw.startsWith('[SSDKEY:') && raw.endsWith(']');
  const parenned  = raw.startsWith('(SSDKEY:') && raw.endsWith(')');
  if (!bracketed && !parenned) return null;
  const inner = raw.slice(8, -1);
  const colon = inner.indexOf(':');
  if (colon < 0) return null;
  const hash8  = inner.slice(0, colon);
  const pubkey = inner.slice(colon + 1);
  if (!/^[0-9A-F]{8}$/.test(hash8)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(pubkey)) return null;
  return { hash8, pubkey };
}

const SSDKEY_PATTERN = /\[SSDKEY:[^\]]+\]|\(SSDKEY:[^)]+\)/g;

// Fast gate: does this text contain either beacon form?
function hasBeacon(text) {
  return text.indexOf('[SSDKEY:') !== -1 || text.indexOf('(SSDKEY:') !== -1;
}

function b64ToBytes(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function verifySelfConsistency(hash8, pubkey) {
  const bytes = b64ToBytes(pubkey);
  const buf   = await crypto.subtle.digest('SHA-256', bytes);
  const hex   = Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8).toUpperCase() === hash8;
}

const textScanner = {

  // Walk the page DOM for [SSD:] content tokens and [SSDKEY:] key beacons.
  //
  // callback(textNode, parsedToken | null, commit) — called once per context
  //   element; parsedToken is null for unrecognised [SSD:] matches.
  //
  // onKeyBeacon(hash8, pubkey, textNode) — called immediately for each valid
  //   [SSDKEY:] beacon; platform handler does its own dedup by DOM inspection.
  scan(callback, onKeyBeacon) {
    const bodyText  = document.body.textContent;
    const hasSSD    = bodyText.indexOf('[SSD:') !== -1;
    const hasSSDKEY = hasBeacon(bodyText);
    if (!hasSSD && !hasSSDKEY) {
      console.debug('[SSD:scan] no tokens found in page text');
      return;
    }
    console.debug('[SSD:scan] tokens found in page, walking text nodes');

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentNode;
          if (p) {
            const tag = p.nodeName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
                tag === 'TEXTAREA' || tag === 'INPUT') {
              return NodeFilter.FILTER_REJECT;
            }
          }
          const t = node.textContent;
          return (t.indexOf('[SSD:') !== -1 || hasBeacon(t))
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        },
      }
    );

    // Content tokens: grouped by parent context element — one badge per context.
    const byContext = new Map();

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;

      // [SSDKEY:] beacons — parse and fire immediately; no context-grouping.
      if (onKeyBeacon && hasBeacon(text)) {
        SSDKEY_PATTERN.lastIndex = 0;
        let m;
        while ((m = SSDKEY_PATTERN.exec(text)) !== null) {
          console.debug('[SSD:scan] SSDKEY matched:', m[0].slice(0, 60));
          const parsed = parseKeyBeacon(m[0]);
          if (parsed) onKeyBeacon(parsed.hash8, parsed.pubkey, node);
        }
      }

      // [SSD:] content tokens — group by context element.
      if (text.indexOf('[SSD:') !== -1) {
        const pattern = tokenParser.PATTERN;
        pattern.lastIndex = 0;
        let match;
        const matches = [];
        while ((match = pattern.exec(text)) !== null) {
          console.debug('[SSD:scan] PATTERN matched raw:', match[0]);
          const parsed = tokenParser.parse(match[0]);
          console.debug('[SSD:scan] tokenParser.parse result:', parsed);
          matches.push({ raw: match[0], parsed: parsed || null });
        }
        if (!matches.length) continue;

        const context = node.parentElement || document.body;
        console.debug('[SSD:scan] text node context:', context.nodeName, 'matches:', matches.length);
        if (!byContext.has(context)) byContext.set(context, []);
        const bucket = byContext.get(context);
        for (const m of matches) {
          bucket.push({ node, parsed: m.parsed, raw: m.raw });
        }
      }
    }

    console.debug('[SSD:scan] contexts found:', byContext.size);
    for (const [ctx, tokens] of byContext) {
      if (!tokens.length) continue;
      const chosen = tokens[tokens.length - 1];
      const key = chosen.node;
      if (this._isProcessed(key, chosen.raw)) {
        console.debug('[SSD:scan] already processed, skipping:', chosen.raw.slice(0, 40));
        continue;
      }
      const commit = () => this._markProcessed(key, chosen.raw);
      console.debug('[SSD:scan] firing callback for token:', chosen.raw.slice(0, 40));
      callback(chosen.node, chosen.parsed, commit);
    }
  },

  _processed: new WeakMap(),

  _isProcessed(node, raw) {
    const set = this._processed.get(node);
    return !!set && set.has(raw);
  },

  _markProcessed(node, raw) {
    let set = this._processed.get(node);
    if (!set) { set = new Set(); this._processed.set(node, set); }
    set.add(raw);
  },

  // Factory: returns a handleKeyBeacon(hash8, pubkey, anchorNode) function for
  // a specific platform bootstrap.
  //
  // nameResolver(hash8) → { name, identity }
  //   Called at import time; reads current page context. hash8 is passed as a
  //   fallback for the name field when no page-derived name is available.
  //
  // onImported()
  //   Called after a successful key import to trigger a re-scan.
  makeBeaconHandler(nameResolver, onImported) {

    async function storeBeaconKey(hash8, pubkey) {
      const { name, identity } = nameResolver(hash8);
      await keyring.put({
        hash8, name, identity, public_key: pubkey,
        signing_algorithm: 'Ed25519',
        issued: null, expires: null, self_signed: null,
        imported_at: new Date().toISOString(),
        source:      'profile',
        vouched_by: null, bundle_name: null, credibility: null, vault: null, token_default: null,
      });
    }

    // Walk up from anchorNode to find the first ancestor not clipped by
    // overflow:hidden — mobile Facebook collapses the bio section with a
    // height-constrained overflow:hidden container, which hides any button
    // appended inside it in portrait orientation. We inject just outside that
    // boundary so the button is always visible regardless of viewport width.
    // Bounded to 8 levels to keep getComputedStyle calls cheap.
    function findInsertParent(node) {
      let el = node.parentElement || node.parentNode;
      for (let i = 0; i < 8 && el && el !== document.body; i++, el = el.parentElement) {
        const s = window.getComputedStyle(el);
        if (s.overflow !== 'hidden' && s.overflowY !== 'hidden') return el;
      }
      return node.parentElement || node.parentNode || document.body;
    }

    return function handleKeyBeacon(hash8, pubkey, anchorNode) {
      // Document-level dedup: allows re-injection if the host page removes the
      // button (e.g. React re-render), while still preventing duplicates when
      // the button is already present.
      if (document.querySelector('.ssd-key-beacon[data-hash8="' + hash8 + '"]')) return;
      const parent = findInsertParent(anchorNode);
      if (!parent) return;

      const existing = keyring.get(hash8);
      const isSame   = existing && existing.public_key === pubkey;
      const isDiff   = existing && existing.public_key !== pubkey;

      const btn = document.createElement('button');
      btn.className     = 'ssd-key-beacon ssd-indicator';
      btn.dataset.hash8 = hash8;

      // Known, same key — informational only; no action needed.
      if (isSame) {
        btn.dataset.ssdState = 'KEY_BEACON_KNOWN';
        btn.textContent = `🔑 Key known (${hash8})`;
        btn.disabled    = true;
        btn.title       = `SSD key ${hash8} is already in your keyring`;
        parent.appendChild(btn);
        return;
      }

      // Key conflict — user must remove existing key manually before adding.
      if (isDiff) {
        btn.dataset.ssdState = 'KEY_BEACON_DIFFERENT';
        btn.textContent = `🔑 Key conflict — remove existing first (${hash8})`;
        btn.title       = `SSD — a different key for ${hash8} is already in your keyring. Remove it via the popup before adding this one.`;
        btn.disabled    = true;
        parent.appendChild(btn);
        return;
      }

      btn.dataset.ssdState = 'KEY_BEACON_NEW';
      btn.textContent = `🔑 Add key (${hash8})`;
      btn.title       = `SSD key beacon — click to add signer ${hash8} to your keyring`;

      btn.addEventListener('touchstart', (e) => { e.stopPropagation(); e.preventDefault(); }, { passive: false });
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.disabled    = true;
        btn.textContent = 'Verifying…';

        // Step 5 of §5.7 parse algorithm: verify hash8 == SHA-256(pubkey_bytes)[0..8].
        let ok;
        try {
          ok = await verifySelfConsistency(hash8, pubkey);
        } catch (err) {
          btn.textContent = '✗ Error';
          btn.disabled    = false;
          console.error('[SSD] beacon crypto error', err);
          return;
        }
        if (!ok) {
          btn.textContent      = '✗ Invalid beacon';
          btn.dataset.ssdState = 'KEY_BEACON_INVALID';
          console.warn('[SSD] SSDKEY rejected — hash8/pubkey mismatch:', hash8);
          return;
        }

        try {
          await storeBeaconKey(hash8, pubkey);
          btn.dataset.ssdState = 'KEY_BEACON_DONE';
          btn.textContent      = '✓ Key added';
          onImported();
        } catch (err) {
          btn.textContent      = '✗ Failed';
          btn.dataset.ssdState = 'KEY_BEACON_FAIL';
          btn.disabled         = true;
          console.error('[SSD] beacon import failed', err);
        }
      });

      parent.appendChild(btn);
    };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = textScanner;
  module.exports.parseKeyBeacon       = parseKeyBeacon;
  module.exports.SSDKEY_PATTERN       = SSDKEY_PATTERN;
  module.exports.verifySelfConsistency = verifySelfConsistency;
}
