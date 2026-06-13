// core/keyring.js
// Local key storage, lookup and trust level. Backed by ext.storage.local
// under the "keystore" key — a flat object keyed by hash8. See the
// Keystore Schema section of the prompt for the full record shape.

const keyring = {

  _cache: {},
  _loaded: false,

  // Load the keystore into the in-memory cache. Also wires a storage.onChanged
  // listener once so the cache stays fresh when the toolbar popup edits keys.
  async load() {
    const data = await ext.storage.local.get('keystore');
    this._cache = data.keystore || {};
    if (!this._loaded) {
      this._loaded = true;
      ext.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.keystore) {
          this._cache = changes.keystore.newValue || {};
        }
      });
    }
    return this._cache;
  },

  // Synchronous lookup against the cache. Call load() once at startup first.
  get(hash8) {
    return this._cache[hash8] || null;
  },

  has(hash8) {
    return !!this._cache[hash8];
  },

  all() {
    return { ...this._cache };
  },

  // Import a key record into the keystore (used by service worker auto-fetch).
  // record must already contain a hash8. Returns the stored record.
  async put(record) {
    const data = await ext.storage.local.get('keystore');
    const ks = data.keystore || {};
    ks[record.hash8] = record;
    await ext.storage.local.set({ keystore: ks });
    this._cache = ks;
    return record;
  },

  async remove(hash8) {
    const data = await ext.storage.local.get('keystore');
    const ks = data.keystore || {};
    delete ks[hash8];
    await ext.storage.local.set({ keystore: ks });
    this._cache = ks;
  },

  // Human-readable trust level for a key record, used by the badge/popup.
  //   - own signing key (vault configured)      → "self"
  //   - directly imported contact               → "peer"
  //   - vouched-for via a contact's bundle       → "bundle"
  //   - auto-fetched from a profile/URL          → "unverified"
  //   - not in keyring                           → null
  trustLevel(hash8OrRecord) {
    const key = typeof hash8OrRecord === 'string'
      ? this.get(hash8OrRecord)
      : hash8OrRecord;
    if (!key) return null;
    if (key.vault) return 'self';
    switch (key.source) {
      case 'direct': return 'peer';
      case 'bundle': return 'bundle';
      case 'profile':
      case 'url': return 'unverified';
      default: return 'unverified';
    }
  },

  // Is the key past its declared expiry? Returns false when no expiry set.
  isExpired(key, atIso) {
    if (!key || !key.expires) return false;
    const now = atIso ? new Date(atIso) : new Date();
    return new Date(key.expires) < now;
  },

  // Is the key revoked? The schema has no explicit revoked flag yet; a
  // `revoked: true` field (or revoked_at timestamp) is honoured if present.
  isRevoked(key) {
    if (!key) return false;
    return key.revoked === true || !!key.revoked_at;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = keyring;
