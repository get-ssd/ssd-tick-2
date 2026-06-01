// popup/popup.js — toolbar popup: the key manager.
// This does NOT show verification state — that is the in-page badge/popup. It
// lists stored keys with provenance and credibility, imports key cards (with
// self-signature verification), and deletes keys.
//
// Keystore layout in chrome.storage.local: { keystore: { [fingerprint]: keyRecord } }

async function getKeystore() {
  const data = await chrome.storage.local.get('keystore');
  return data.keystore || {};
}

async function saveKeystore(ks) {
  await chrome.storage.local.set({ keystore: ks });
}

function b64ToBytes(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

// Validate the key-card self-signature — identical scheme to the existing
// ssd-tick popup.js: self_signed covers all other fields, keys sorted
// alphabetically, canonical JSON, Ed25519 over the UTF-8 bytes.
async function verifyKeyCard(card) {
  const { self_signed, ...data } = card;
  const sortedKeys = Object.keys(data).sort();
  const canonical = JSON.stringify(
    Object.fromEntries(sortedKeys.map(k => [k, data[k]]))
  );
  const dataBytes = new TextEncoder().encode(canonical);
  const pubKey = await crypto.subtle.importKey(
    'raw', b64ToBytes(card.public_key), { name: 'Ed25519' }, false, ['verify']
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' }, pubKey, b64ToBytes(self_signed), dataBytes
  );
}

async function importKeyCard(json) {
  let card;
  try { card = JSON.parse(json); }
  catch { throw new Error('Not valid JSON.'); }

  const required = ['fingerprint', 'name', 'public_key', 'self_signed', 'signing_algorithm'];
  const missing = required.filter(f => !card[f]);
  if (missing.length) throw new Error(`Missing fields: ${missing.join(', ')}.`);

  if (card.signing_algorithm !== 'Ed25519')
    throw new Error(`Unsupported algorithm: ${card.signing_algorithm}.`);

  const valid = await verifyKeyCard(card);
  if (!valid) throw new Error('Self-signature invalid — key card may be tampered.');

  const ks = await getKeystore();
  const existing = ks[card.fingerprint];
  if (existing && existing.public_key !== card.public_key)
    throw new Error(
      `Fingerprint ${card.fingerprint} already exists with a different public key. ` +
      `Delete the existing entry first if you trust the new key.`
    );
  if (existing && existing.public_key === card.public_key)
    throw new Error(`${card.fingerprint} is already in your keystore.`);

  ks[card.fingerprint] = {
    fingerprint:       card.fingerprint,
    name:              card.name,
    public_key:        card.public_key,
    signing_algorithm: card.signing_algorithm,
    issued:            card.issued || null,
    expires:           card.expires || null,
    self_signed:       card.self_signed,
    imported_at:       new Date().toISOString(),
    source:            'direct',
    vouched_by:        null,
    bundle_name:       null,
    credibility:       null,
    vault:             card.vault || null,
    token_default:     card.vault ? (card.token_default || 'auto') : null,
  };

  await saveKeystore(ks);
  return card.fingerprint;
}

async function deleteKey(fingerprint) {
  const ks = await getKeystore();
  delete ks[fingerprint];
  await saveKeystore(ks);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Display name: strip O:/D: prefixes, append " · Owner" / " · Device".
function displayName(name) {
  if (!name) return 'Unknown';
  if (name.startsWith('O:')) return name.slice(2) + ' · Owner';
  if (name.startsWith('D:')) return name.slice(2) + ' · Device';
  return name;
}

// Provenance line derived from source / vouched_by / bundle_name.
function provenance(key, ks) {
  switch (key.source) {
    case 'direct':  return 'Imported directly';
    case 'profile': return 'Fetched from profile';
    case 'url':     return 'Fetched from token URL';
    case 'bundle': {
      const voucher = key.vouched_by && ks[key.vouched_by];
      const name = voucher ? displayName(voucher.name).replace(/ · (Owner|Device)$/, '') : null;
      return name ? `From ${name}'s list` : (key.bundle_name || 'From a shared list');
    }
    default: return 'Imported';
  }
}

function renderKeys(ks) {
  const list = document.getElementById('key-list');
  const countEl = document.getElementById('key-count');
  const entries = Object.values(ks);

  countEl.textContent = `${entries.length} key${entries.length !== 1 ? 's' : ''}`;

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty">No keys stored. Paste a key card below.</div>';
    return;
  }

  list.innerHTML = entries.map(k => `
    <div class="key-card">
      <div class="key-info">
        <div class="key-name">${esc(displayName(k.name))}</div>
        <div class="key-meta"><span class="fp">${esc(k.fingerprint)}</span> · ${esc(provenance(k, ks))}</div>
        ${k.credibility === 'debuffed' ? `<div class="key-debuff">↓ Debuffed</div>` : ''}
      </div>
      <button class="delete-btn" data-fp="${esc(k.fingerprint)}" title="Remove this key">&times;</button>
    </div>
  `).join('');

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await deleteKey(btn.dataset.fp);
      renderKeys(await getKeystore());
    });
  });
}

function showMessage(text, isError) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = isError ? 'error' : 'success';
}

document.addEventListener('DOMContentLoaded', async () => {
  renderKeys(await getKeystore());

  document.getElementById('import-btn').addEventListener('click', async () => {
    const json = document.getElementById('key-input').value.trim();
    if (!json) { showMessage('Paste a key card first.', true); return; }
    try {
      const fp = await importKeyCard(json);
      document.getElementById('key-input').value = '';
      showMessage(`Imported ${fp}`, false);
      renderKeys(await getKeystore());
    } catch (e) {
      showMessage(e.message, true);
    }
  });
});
