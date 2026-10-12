// Local, user-approved public-key exchange with SSD. No runtime/background
// messages or private key material. Protocol: SSD_TICK_KEYS_V1 (see README).
(() => {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
  const channel = 'SSD_TICK_KEYS_V1';
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const pathOK = local
    ? ['/', '/index.html', '/advanced.html'].includes(location.pathname)
    : location.pathname === '/SignedSealedDelivered' || location.pathname.startsWith('/SignedSealedDelivered/');
  if (window !== window.top || !pathOK) return;
  let pending = null;
  let busy = false;

  // Deliberate allowlist: never spread stored rows into a page message.
  async function publicRecord(row) {
    const input = row.public_key_b64 ?? row.public_key;
    if (typeof input !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(input)) throw new Error('Invalid public key.');
    const text = input.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(text.padEnd(Math.ceil(text.length / 4) * 4, '=')), c => c.charCodeAt(0));
    if (bytes.length !== 32) throw new Error('Only Ed25519 public keys can be synced.');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('').slice(0, 8).toUpperCase();
    if (row.hash8 !== hash) throw new Error('Public key fingerprint mismatch.');
    const out = { hash8: hash, public_key_b64: btoa(String.fromCharCode(...bytes)),
      name: typeof row.name === 'string' ? row.name : hash,
      source: ['direct', 'bundle', 'profile', 'url'].includes(row.source) ? row.source : 'unknown',
      trust_type: typeof row.trust_type === 'string' ? row.trust_type : row.source === 'direct' ? 'peer' : 'unverified',
      is_revoked: !!(row.is_revoked || row.revoked || row.revoked_at),
      is_quarantined: row.is_quarantined === true };
    for (const field of ['identity', 'issued', 'expires', 'revoked_at', 'quarantine_reason', 'vouched_by', 'bundle_name']) {
      if (typeof row[field] === 'string') out[field] = row[field];
    }
    return out;
  }

  function differences(a, b) {
    return a.name !== b.name || a.source !== b.source || a.trust_type !== b.trust_type;
  }

  window.addEventListener('message', async event => {
    const request = event.data;
    if (event.source !== window || event.origin !== location.origin ||
        request?.channel !== channel || request.direction !== 'request' || typeof request.id !== 'string') return;
    const reply = payload => window.postMessage({ channel, direction: 'response', id: request.id, ...payload }, location.origin);
    if (request.action === 'hello') { reply({ ok: true }); return; }
    if (!['read', 'merge'].includes(request.action)) return;
    if (busy) { reply({ ok: false, error: 'A key sync is already in progress. Try again.' }); return; }
    busy = true;
    try {
      const owner = await publicRecord(request.owner);
      const stored = await api.storage.local.get(['owner', 'keystore']);
      if (stored.owner && (stored.owner.hash8 !== owner.hash8 ||
          (await publicRecord({ ...stored.owner, public_key: stored.owner.public_key })).public_key_b64 !== owner.public_key_b64)) {
        throw new Error(`Tick belongs to ${stored.owner.name || stored.owner.hash8} (${stored.owner.hash8}). Open SSD with that identity; nothing was synced.`);
      }
      if (request.action === 'read') {
        pending = null;
        if (!window.confirm(`Sync public keys between Tick and SSD for ${owner.name} (${owner.hash8})?\n\nExisting names and trust choices are kept. Private keys are never transferred.`)) {
          reply({ ok: false, error: 'Key sync cancelled.' }); return;
        }
        const records = await Promise.all(Object.values(stored.keystore || {}).map(publicRecord));
        const token = crypto.randomUUID();
        pending = { token, owner, expires: Date.now() + 120000 };
        reply({ ok: true, records, token });
      } else {
        const session = pending;
        pending = null;
        if (!session || session.token !== request.token || session.expires < Date.now() ||
            session.owner.public_key_b64 !== owner.public_key_b64) throw new Error('Sync expired. Click Sync again.');
        if (!Array.isArray(request.records) || request.records.length > 10000) throw new Error('Invalid public-key collection.');
        const records = await Promise.all(request.records.map(publicRecord));
        const keystore = stored.keystore || {};
        let added = 0, updated = 0, kept = 0;
        for (const incoming of records) {
          const existing = keystore[incoming.hash8];
          if (existing) {
            const normalized = await publicRecord(existing);
            if (normalized.public_key_b64 !== incoming.public_key_b64) throw new Error(`Conflicting public key ${incoming.hash8}; nothing was written to Tick.`);
            if (differences(normalized, incoming)) kept++;
            if ((incoming.is_revoked && !normalized.is_revoked) || (incoming.is_quarantined && !normalized.is_quarantined)) {
              keystore[incoming.hash8] = { ...existing, revoked: normalized.is_revoked || incoming.is_revoked,
                is_quarantined: normalized.is_quarantined || incoming.is_quarantined };
              updated++;
            }
          } else {
            const { public_key_b64, is_revoked, ...metadata } = incoming;
            keystore[incoming.hash8] = { ...metadata, public_key: public_key_b64, revoked: is_revoked,
              signing_algorithm: 'Ed25519', imported_at: new Date().toISOString() };
            added++;
          }
        }
        // A single storage write, after the entire collection has been checked.
        await api.storage.local.set({ keystore, owner: { hash8: owner.hash8, name: owner.name, public_key: owner.public_key_b64 } });
        reply({ ok: true, added, updated, kept });
      }
    } catch (error) { reply({ ok: false, error: error.message }); }
    finally { busy = false; }
  });
})();
