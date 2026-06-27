// popup/popup.js — toolbar popup: the key manager.
// This does NOT show verification state — that is the in-page badge/popup. It
// lists stored keys with provenance and credibility, imports key cards (with
// self-signature verification), and deletes keys.
//
// Keystore layout in ext.storage.local: { keystore: { [hash8]: keyRecord } }

const ext = globalThis.browser ?? globalThis.chrome;

async function getKeystore() {
  const data = await ext.storage.local.get('keystore');
  return data.keystore || {};
}

async function saveKeystore(ks) {
  await ext.storage.local.set({ keystore: ks });
}

function b64ToBytes(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function _sha256hex(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _hash8(pubB64) {
  return (await _sha256hex(b64ToBytes(pubB64))).slice(0, 8).toUpperCase();
}

// Minimal ZIP reader — handles STORE (method 0) and DEFLATE (method 8).
async function _unzipSSD(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4b && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
      eocd = i; break;
    }
  }
  if (eocd === -1) throw new Error('Not a valid .ssd archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const cdCount  = view.getUint16(eocd + 8, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const files = {};
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('Bad central directory');
    const method   = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const fnLen    = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const cmtLen   = view.getUint16(pos + 32, true);
    const localOff = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + fnLen));
    pos += 46 + fnLen + extraLen + cmtLen;
    const lhFnLen    = view.getUint16(localOff + 26, true);
    const lhExtraLen = view.getUint16(localOff + 28, true);
    const dataStart  = localOff + 30 + lhFnLen + lhExtraLen;
    const comp = bytes.slice(dataStart, dataStart + compSize);
    if (method === 0) {
      files[name] = comp;
    } else if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const w = ds.writable.getWriter(); const r = ds.readable.getReader();
      w.write(comp); w.close();
      const chunks = [];
      for (;;) { const {done, value} = await r.read(); if (done) break; chunks.push(value); }
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
      files[name] = out;
    } else {
      throw new Error(`Unsupported ZIP method ${method}`);
    }
  }
  return files;
}

// Unpack and self-verify a keyring-share .ssd, return parsed content.
async function importPublicShare(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const files = await _unzipSSD(bytes);
  for (const f of ['manifest.json', 'signature.json', 'source.json'])
    if (!files[f]) throw new Error(`Missing ${f} in archive`);

  const dec = new TextDecoder();
  const manifestRaw  = files['manifest.json'];
  const signatureRaw = files['signature.json'];
  const sourceRaw    = files['source.json'];
  const manifest  = JSON.parse(dec.decode(manifestRaw));
  const signature = JSON.parse(dec.decode(signatureRaw));
  const content   = JSON.parse(dec.decode(sourceRaw));

  if (content.type !== 'keyring-share') throw new Error('Not a public key share');

  // Content hash
  const sourceHash = 'sha256:' + await _sha256hex(sourceRaw);
  if (sourceHash !== manifest.files?.['source.json']) throw new Error('Content hash mismatch — file may be tampered');

  // Manifest hash
  const manifestHash = 'sha256:' + await _sha256hex(manifestRaw);
  if (manifestHash !== signature.manifest_hash) throw new Error('Manifest hash mismatch');

  // Self-signed: signer must be the embedded O: key
  if (signature.signer_hash8 !== await _hash8(content.signing_pub_b64))
    throw new Error('Share is not self-signed — re-export from a current SSD version');

  // Ed25519 verify
  const pubKey = await crypto.subtle.importKey('raw', b64ToBytes(content.signing_pub_b64), {name: 'Ed25519'}, false, ['verify']);
  const valid = await crypto.subtle.verify({name: 'Ed25519'}, pubKey, b64ToBytes(signature.signature), manifestRaw);
  if (!valid) throw new Error('Signature invalid');

  return content;
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

  const required = ['hash8', 'name', 'public_key', 'self_signed', 'signing_algorithm'];
  const missing = required.filter(f => !card[f]);
  if (missing.length) throw new Error(`Missing fields: ${missing.join(', ')}.`);

  if (card.signing_algorithm !== 'Ed25519')
    throw new Error(`Unsupported algorithm: ${card.signing_algorithm}.`);

  const valid = await verifyKeyCard(card);
  if (!valid) throw new Error('Self-signature invalid — key card may be tampered.');

  const ks = await getKeystore();
  const existing = ks[card.hash8];
  if (existing && existing.public_key !== card.public_key)
    throw new Error(
      `Key ${card.hash8} already exists with a different public key. ` +
      `Delete the existing entry first if you trust the new key.`
    );
  if (existing && existing.public_key === card.public_key)
    throw new Error(`${card.hash8} is already in your keystore.`);

  ks[card.hash8] = {
    hash8:             card.hash8,
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
  return card.hash8;
}

async function deleteKey(hash8) {
  const ks = await getKeystore();
  delete ks[hash8];
  await saveKeystore(ks);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PLATFORM_LABELS = { fb: 'Facebook', rd: 'Reddit' };

// Display name: strip O:/D: prefixes, append role and platform.
function displayName(key) {
  const name = typeof key === 'string' ? key : (key.name || '');
  if (!name) return 'Unknown';
  let label = name;
  let suffix = '';
  if (label.startsWith('O:')) { label = label.slice(2); suffix = ' · Owner'; }
  else if (label.startsWith('D:')) { label = label.slice(2); suffix = ' · Device'; }
  if (key.identity) {
    const colon = key.identity.indexOf(':');
    const platform = colon !== -1 && PLATFORM_LABELS[key.identity.slice(0, colon)];
    if (platform) suffix += (suffix ? ', ' : ' · ') + platform;
  }
  return label + suffix;
}

// Provenance line derived from source / vouched_by / bundle_name / identity.
function provenance(key, ks) {
  switch (key.source) {
    case 'direct':  return key.identity ? `Imported · ${key.identity}` : 'Imported directly';
    case 'profile': return key.identity ? `Profile · ${key.identity}` : 'Fetched from profile';
    case 'url':     return key.identity ? `URL · ${key.identity}` : 'Fetched from token URL';
    case 'bundle': {
      const voucher = key.vouched_by && ks[key.vouched_by];
      const name = voucher ? displayName(voucher).replace(/ · (Owner|Device(, \w+)?)$/, '') : null;
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
        <div class="key-name">${esc(displayName(k))}</div>
        <div class="key-meta"><span class="fp">${esc(k.hash8)}</span> · ${esc(provenance(k, ks))}</div>
        ${k.credibility === 'debuffed' ? `<div class="key-debuff">↓ Debuffed</div>` : ''}
      </div>
      <button class="delete-btn" data-hash8="${esc(k.hash8)}" title="Remove this key">&times;</button>
    </div>
  `).join('');

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await deleteKey(btn.dataset.hash8);
      renderKeys(await getKeystore());
    });
  });
}

function showMessage(text, isError) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = isError ? 'error' : 'success';
}

async function savePwaUrl(raw) {
  const msgEl = document.getElementById('pwa-message');
  raw = (raw || '').trim().replace(/\/+$/, '');
  if (raw && !raw.startsWith('http')) {
    msgEl.textContent = 'URL must start with https:// or http://';
    msgEl.style.color = 'var(--danger)';
    return;
  }
  await ext.storage.local.set({ pwaUrl: raw });
  msgEl.textContent = raw ? 'Saved.' : 'Cleared.';
  msgEl.style.color = 'var(--text-muted)';
  setTimeout(() => { msgEl.textContent = ''; }, 2000);
}

document.addEventListener('DOMContentLoaded', async () => {
  renderKeys(await getKeystore());

  // Populate the URL input from storage on open.
  const stored = await ext.storage.local.get('pwaUrl');
  const urlInput = document.getElementById('pwa-url-input');
  if (urlInput && stored.pwaUrl) urlInput.value = stored.pwaUrl;

  // Open SSD button — always visible; if no URL saved, scroll to the setting.
  document.getElementById('open-pwa-btn').addEventListener('click', async () => {
    const data = await ext.storage.local.get('pwaUrl');
    if (data.pwaUrl) {
      ext.tabs.create({ url: data.pwaUrl });
    } else {
      const section = document.getElementById('pwa-section');
      if (section) {
        section.scrollIntoView({ behavior: 'smooth' });
        section.style.outline = '1px solid var(--primary)';
        setTimeout(() => { section.style.outline = ''; }, 1500);
      }
    }
  });

  // Save on button click or on blur (auto-save when user leaves the field).
  document.getElementById('pwa-url-save').addEventListener('click', () => {
    savePwaUrl(document.getElementById('pwa-url-input').value);
  });
  document.getElementById('pwa-url-input').addEventListener('blur', function() {
    savePwaUrl(this.value);
  });
  document.getElementById('pwa-url-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') savePwaUrl(this.value);
  });

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

  document.getElementById('share-file-input').addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;
    this.value = '';
    try {
      const content = await importPublicShare(await file.arrayBuffer());
      const ks = await getKeystore();
      let added = 0, skipped = 0;
      const now = new Date().toISOString();

      const mergeKey = (hash8, pubB64, name) => {
        if (ks[hash8]) { skipped++; return; }
        ks[hash8] = {
          hash8, name: name || hash8,
          public_key: pubB64,
          signing_algorithm: 'Ed25519',
          issued: null, expires: null, self_signed: null,
          imported_at: now, source: 'direct',
          vouched_by: null, bundle_name: null,
          credibility: null, vault: null, token_default: null,
        };
        added++;
      };

      mergeKey(content.hash8, content.signing_pub_b64, content.key_name);
      for (const c of (content.contacts ?? [])) {
        if (c.hash8 && c.public_key_b64) mergeKey(c.hash8, c.public_key_b64, c.name ?? c.hash8);
      }

      await saveKeystore(ks);
      showMessage(`Share imported: ${added} new, ${skipped} already known`, false);
      renderKeys(ks);
    } catch (e) {
      showMessage(e.message, true);
    }
  });
});
