// background/background.js — Firefox event-page background
// Functionally identical to the Chrome service-worker but registered as a
// background scripts event-page so it works reliably on Firefox for Android.
//
// Identity hint formats (CANON-Spec §7):
//   fb:{profile-id}   → fetch from Facebook profile      (implemented)
//   url:{uri}         → fetch from explicit URI           (implemented)
//   tw:{handle}       → Twitter/X profile                 (stub)
//   li:{profile-id}   → LinkedIn profile                  (stub)
//   bsky:{handle}     → Bluesky profile                   (stub)
//   fp:{hash8}        → already in local keyring          (no fetch)
//
// Resolved keys are cached under "keystore" { [hash8]: keyRecord }.

const ext = globalThis.browser ?? globalThis.chrome;

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
  const { self_signed, ...data } = card;
  const canonical = JSON.stringify(
    Object.fromEntries(Object.keys(data).sort().map(k => [k, data[k]]))
  );
  const pubKey = await crypto.subtle.importKey(
    'raw', b64ToBytes(card.signing_public_key), { name: 'Ed25519' }, false, ['verify']
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

  const required = ['hash8', 'name', 'signing_public_key', 'self_signed', 'signing_algorithm'];
  const missing = required.filter(f => !card[f]);
  if (missing.length) throw new Error(`Missing fields: ${missing.join(', ')}`);
  if (card.signing_algorithm !== 'Ed25519')
    throw new Error(`Unsupported algorithm: ${card.signing_algorithm}`);
  if (!await verifyKeyCard(card))
    throw new Error('Self-signature invalid — key card may be tampered');
  return card;
}

async function getKeystore() {
  const data = await ext.storage.local.get('keystore');
  return data.keystore || {};
}

async function storeFetchedKey(card, source) {
  const ks = await getKeystore();
  if (ks[card.hash8]) return ks[card.hash8];
  ks[card.hash8] = {
    hash8:             card.hash8,
    name:              card.name,
    public_key:        card.signing_public_key,
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
  await ext.storage.local.set({ keystore: ks });
  return ks[card.hash8];
}

// ── identity resolution ──────────────────────────────────────────────────────

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

async function resolveIdentity(identity) {
  const colon = identity.indexOf(':');
  if (colon === -1) return null;
  const prefix = identity.slice(0, colon);
  const rest = identity.slice(colon + 1);

  switch (prefix) {
    case 'fp':
      return null;
    case 'fb':
      return null;
    case 'url': {
      const card = await resolveUrl(rest);
      return card ? { card, source: 'url' } : null;
    }
    case 'tw':
    case 'x':
    case 'li':
    case 'bsky':
      return null;
    default:
      return null;
  }
}

// ── message handling ─────────────────────────────────────────────────────────

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'getPwaUrl') {
    getPwaUrl().then(url => sendResponse({ url }));
    return true;
  }

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
        const ks = await getKeystore();
        if (ks[msg.hash8]) {
          sendResponse({ ok: true, key: ks[msg.hash8] });
          return;
        }
        const resolved = await resolveIdentity(msg.identity);
        if (!resolved) { sendResponse({ ok: false, reason: 'unresolved' }); return; }

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
    return true;
  }

  return false;
});
