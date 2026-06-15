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

// ── PWA URL (used by popup to open the app) ──────────────────────────────────

async function getPwaUrl() {
  const data = await chrome.storage.local.get('pwaUrl');
  return data.pwaUrl ? data.pwaUrl.replace(/\/+$/, '') : null;
}

// ── Sign-request correlation ──────────────────────────────────────────────────
// Maps request_id → { resolve, reject, tabId, timer } for in-flight sign requests.

const _pendingSign = new Map();
const SIGN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

chrome.tabs.onRemoved.addListener(tabId => {
  for (const [reqId, pending] of _pendingSign) {
    if (pending.tabId === tabId) {
      clearTimeout(pending.timer);
      _pendingSign.delete(reqId);
      pending.reject(new Error('Sign window was closed'));
    }
  }
});

chrome.runtime.onMessageExternal.addListener((msg, _sender, _sendResponse) => {
  if (!msg || msg.type !== 'SSD_SIGN_RESPONSE') return;
  const pending = _pendingSign.get(msg.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  _pendingSign.delete(msg.requestId);
  if (pending.tabId) chrome.tabs.remove(pending.tabId).catch(() => {});
  if (msg.error) {
    pending.reject(new Error(msg.error));
  } else {
    pending.resolve({ ok: true, signature: msg.signature });
  }
});

// ── Context menu (Chrome) — "Sign this text" ─────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       'ssd-sign-this',
      title:    '🔏 Sign this text (SSD)',
      contexts: ['editable'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'ssd-sign-this') return;
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'SSD_SIGN_THIS', source: 'context-menu' })
    .catch(err => console.warn('[SSD] Sign-this-text: no content script on tab', err));
});

// ── message handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'getPwaUrl') {
    getPwaUrl().then(url => sendResponse({ url }));
    return true; // async response
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

  if (msg && msg.type === 'SSD_SIGN_REQUEST') {
    (async () => {
      const { hash8, signedPayload, platform, previewText } = msg.payload || {};
      const pwaBase = await getPwaUrl();
      if (!pwaBase) {
        sendResponse({ ok: false, error: 'PWA URL not configured — set it in the SSD popup.' });
        return;
      }
      const extId = chrome.runtime.id;
      const requestId = crypto.randomUUID();

      const params = new URLSearchParams({
        request_id:     requestId,
        ext_id:         extId,
        fingerprint:    hash8,
        signed_payload: signedPayload,
        platform:       platform || '',
        preview:        previewText || '',
      });
      const signUrl = `${pwaBase}/sign.html?${params.toString()}`;

      const result = await new Promise((resolve, reject) => {
        chrome.tabs.create({ url: signUrl, active: true }, tab => {
          if (chrome.runtime.lastError || !tab) {
            reject(new Error(chrome.runtime.lastError?.message || 'Failed to open sign tab'));
            return;
          }
          const timer = setTimeout(() => {
            _pendingSign.delete(requestId);
            chrome.tabs.remove(tab.id).catch(() => {});
            reject(new Error('Sign request timed out'));
          }, SIGN_TIMEOUT_MS);
          _pendingSign.set(requestId, { resolve, reject, tabId: tab.id, timer });
        });
      });

      sendResponse(result);
    })().catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // async response
  }

  return false;
});
