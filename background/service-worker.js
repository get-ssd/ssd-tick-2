// background/service-worker.js
// Key fetch, identity resolution, and an in-memory cache. The content script
// requests key resolution via chrome.runtime.sendMessage({ type: 'resolveKey', ... }).
//
// Identity hint formats (CANON-Spec §7):
//   fb:{profile-id}   → fetch from Facebook profile      (implemented)
//   url:{uri}         → fetch from explicit URI           (implemented)
//   tw:{handle}       → Twitter/X profile                 (stub)
//   li:{profile-id}   → LinkedIn profile                  (stub)
//   bsky:{handle}     → Bluesky profile                   (stub)
//   fp:{hash8}        → already in local keyring          (no fetch)
//
// Resolved keys are cached in chrome.storage.local under "keystore"
// { [hash8]: keyRecord }. Auto-fetched keys get source "profile" (from a
// social profile) or "url" (from a URL hint), with vouched_by null.

const KEY_CARD_PATHS = [
  '/.well-known/ssd-key.json',
  '/ssd-key.json',
];

// ── helpers ─────────────────────────────────────────────────────────────────

function b64ToBytes(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function verifyKeyCard(card) {
  // self_signed covers all other fields, keys sorted alphabetically, canonical JSON.
  const { self_signed, ...data } = card;
  const canonical = JSON.stringify(
    Object.fromEntries(Object.keys(data).sort().map(k => [k, data[k]]))
  );
  const pubKey = await crypto.subtle.importKey(
    'raw', b64ToBytes(card.public_key), { name: 'Ed25519' }, false, ['verify']
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' }, pubKey, b64ToBytes(self_signed),
    new TextEncoder().encode(canonical)
  );
}

async function fetchAndVerifyCard(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const card = await resp.json();

  const required = ['hash8', 'name', 'public_key', 'self_signed', 'signing_algorithm'];
  const missing = required.filter(f => !card[f]);
  if (missing.length) throw new Error(`Missing fields: ${missing.join(', ')}`);
  if (card.signing_algorithm !== 'Ed25519')
    throw new Error(`Unsupported algorithm: ${card.signing_algorithm}`);
  if (!await verifyKeyCard(card))
    throw new Error('Self-signature invalid — key card may be tampered');
  return card;
}

async function getKeystore() {
  const data = await chrome.storage.local.get('keystore');
  return data.keystore || {};
}

async function storeFetchedKey(card, source) {
  const ks = await getKeystore();
  // Don't clobber an existing record (could be a user-trusted "direct" key).
  if (ks[card.hash8]) return ks[card.hash8];
  ks[card.hash8] = {
    hash8:             card.hash8,
    name:              card.name,
    public_key:        card.public_key,
    signing_algorithm: card.signing_algorithm,
    issued:            card.issued || null,
    expires:           card.expires || null,
    self_signed:       card.self_signed,
    imported_at:       new Date().toISOString(),
    source,
    vouched_by:        null,
    bundle_name:       null,
    credibility:       null,
    vault:             null,
    token_default:     null,
  };
  await chrome.storage.local.set({ keystore: ks });
  return ks[card.hash8];
}

// ── identity resolution ──────────────────────────────────────────────────────

// Try a list of candidate URLs, returning the first card that verifies.
async function tryCards(urls) {
  for (const url of urls) {
    try {
      return await fetchAndVerifyCard(url);
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function resolveUrl(uri) {
  return tryCards([uri]);
}

// Resolve an identity hint to a verified key card + source label, or null.
async function resolveIdentity(identity) {
  const colon = identity.indexOf(':');
  if (colon === -1) return null;
  const prefix = identity.slice(0, colon);
  const rest = identity.slice(colon + 1);

  switch (prefix) {
    case 'fp':
      // Already-in-keyring hint; nothing to fetch.
      return null;
    case 'fb':
      // fb: hint is a human-readable signer label, not a fetchable URL.
      return null;
    case 'url': {
      const card = await resolveUrl(rest);
      return card ? { card, source: 'url' } : null;
    }
    case 'tw':
    case 'x':
      // TODO: Twitter/X profile key resolution. Not implemented in this prompt.
      return null;
    case 'li':
      // TODO: LinkedIn profile key resolution. Not implemented in this prompt.
      return null;
    case 'bsky':
      // TODO: Bluesky profile key resolution. Not implemented in this prompt.
      return null;
    default:
      return null;
  }
}

// ── message handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'analyserLog') {
    (async () => {
      try {
        await fetch(msg.collectorUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    msg.payload,
        });
      } catch { /* collector offline — ignore */ }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg && msg.type === 'resolveKey') {
    (async () => {
      try {
        // Already local?
        const ks = await getKeystore();
        if (ks[msg.hash8]) {
          sendResponse({ ok: true, key: ks[msg.hash8] });
          return;
        }
        const resolved = await resolveIdentity(msg.identity);
        if (!resolved) { sendResponse({ ok: false, reason: 'unresolved' }); return; }

        // Only accept a card whose hash8 matches the token's claim.
        if (resolved.card.hash8 !== msg.hash8) {
          sendResponse({ ok: false, reason: 'hash8-mismatch' });
          return;
        }
        const stored = await storeFetchedKey(resolved.card, resolved.source);
        sendResponse({ ok: true, key: stored });
      } catch (err) {
        sendResponse({ ok: false, reason: String(err && err.message || err) });
      }
    })();
    return true; // async response
  }

  return false;
});
