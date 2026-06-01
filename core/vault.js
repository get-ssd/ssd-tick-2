// core/vault.js
// Vault interaction (CANON-Spec §12).
//
// The vault stores full signatures and canonical text for short tokens. It is
// NOT trusted for verification — it only supplies the full signature; the
// signature is always verified locally against the signer's public key.
//
// Vault config is read from the signer's key record in the keyring
// (record.vault = { url, visibility, auth_token }). A key with no vault
// configured cannot use short tokens.

const vault = {

  // Get vault config for a given key fingerprint.
  // Returns { url, visibility, token } or { url:null, visibility:null, token:null }.
  getConfig(fingerprint) {
    const key = (typeof keyring !== 'undefined') ? keyring.get(fingerprint) : null;
    const v = key && key.vault ? key.vault : null;
    if (!v || !v.url) return { url: null, visibility: null, token: null };
    return {
      url: v.url.replace(/\/+$/, ''),
      visibility: v.visibility || null,
      token: v.auth_token || null,
    };
  },

  _headers(token) {
    const h = { 'Accept': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  },

  // Fetch the full signature for a short token.
  //   GET {url}/vault/sig?fp=...&hint=...&ts=...
  //   → { full_signature: "..." }
  // Returns the full signature string, or null if unreachable / not found.
  async fetchSig(fingerprint, sigHint, timestamp) {
    const cfg = this.getConfig(fingerprint);
    if (!cfg.url) return null;
    const q = new URLSearchParams({ fp: fingerprint, hint: sigHint, ts: timestamp });
    try {
      const resp = await fetch(`${cfg.url}/vault/sig?${q}`, { headers: this._headers(cfg.token) });
      if (!resp.ok) return null;
      const body = await resp.json();
      return body.full_signature || null;
    } catch {
      return null;
    }
  },

  // Submit a signing event to the vault (CANON-Spec §12 "At signing time").
  // POST {url}/vault/submit. Returns true on success, false otherwise.
  async submit(fingerprint, keyHint, contentHash, canonicalText, fullSignature, timestamp, platform) {
    const cfg = this.getConfig(fingerprint);
    if (!cfg.url) return false;
    const payload = {
      fingerprint,
      key_hint: keyHint,
      content_hash: contentHash,
      canonical_text: canonicalText,
      full_signature: fullSignature,
      timestamp,
      platform,
    };
    try {
      const resp = await fetch(`${cfg.url}/vault/submit`, {
        method: 'POST',
        headers: { ...this._headers(cfg.token), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return resp.ok;
    } catch {
      return false;
    }
  },

  // Discovery query: fetch canonical text by fingerprint + sig hint.
  //   GET {url}/vault/query?fp=...&sig=...
  //   → { canonical_text, timestamp, platform }
  // Returns the parsed object, or null on failure.
  async query(fingerprint, sigHint) {
    const cfg = this.getConfig(fingerprint);
    if (!cfg.url) return null;
    const q = new URLSearchParams({ fp: fingerprint, sig: sigHint });
    try {
      const resp = await fetch(`${cfg.url}/vault/query?${q}`, { headers: this._headers(cfg.token) });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = vault;
