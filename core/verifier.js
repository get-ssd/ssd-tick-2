// core/verifier.js
// Signature verification against a public key. Produces a verification result
// object (see Verification States in the prompt / CANON-Spec §9).
//
// Depends on: tokenParser, canon, keyring, vault (loaded before this file by
// the manifest). Key resolution that needs a network fetch is delegated to the
// background service worker via chrome.runtime.sendMessage.

const verifier = {

  TRUNCATION_THRESHOLD: 20, // pre-token text under this many chars → TRUNCATED

  b64ToBytes(b64) {
    // Accept both standard base64 and base64url; tolerate missing padding.
    let s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
  },

  // Ask the service worker to resolve a key hint to a key record, fetching and
  // importing it if necessary. Returns the key record or null.
  async resolveKey(fingerprint, keyHint) {
    // Already local?
    const local = keyring.get(fingerprint);
    if (local) return local;

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'resolveKey',
        fingerprint,
        keyHint,
      });
      if (resp && resp.ok && resp.key) {
        // Refresh cache so subsequent lookups are synchronous.
        await keyring.load();
        return keyring.get(fingerprint) || resp.key;
      }
    } catch {
      // service worker unreachable
    }
    return null;
  },

  // Main verification entry point.
  //   tokenString — the raw —SSD·…— token text
  //   rawPostText — the full text of the post (including the token); canon
  //                 splits off the token itself.
  async verify(tokenString, rawPostText) {
    const parsed = tokenParser.parse(tokenString);
    if (!parsed) {
      return this._result('INVALID', null);
    }

    const base = {
      fingerprint: parsed.fingerprint,
      keyHint: parsed.keyHint,
      signerName: null,
      trustLevel: null,
      timestamp: parsed.timestamp,
      isShort: parsed.isShort,
      vaultUsed: false,
    };

    // TRUNCATED check: pre-token content too short to hash reliably.
    const tokenIdx = rawPostText.lastIndexOf('—SSD·');
    const preToken = (tokenIdx !== -1 ? rawPostText.slice(0, tokenIdx) : rawPostText).trim();
    console.debug('[SSD:verify] preToken length:', preToken.length, 'threshold:', this.TRUNCATION_THRESHOLD);
    if (preToken.length < this.TRUNCATION_THRESHOLD) {
      console.debug('[SSD:verify] → TRUNCATED');
      return { ...base, state: 'TRUNCATED' };
    }

    // Canonicalise → content hash.
    const { canonicalText, contentHash } = await canon.canonicalise(rawPostText);
    console.debug('[SSD:verify] contentHash:', contentHash);
    console.debug('[SSD:verify] canonicalText:', canonicalText.slice(0, 120).replace(/\n/g, '↵'));

    // Resolve the signer's key.
    const key = await this.resolveKey(parsed.fingerprint, parsed.keyHint);
    console.debug('[SSD:verify] key resolved:', key ? key.fingerprint : null);
    if (!key) {
      console.debug('[SSD:verify] → KEY_UNREACHABLE');
      return { ...base, state: 'KEY_UNREACHABLE' };
    }

    const known = keyring.has(parsed.fingerprint);
    base.signerName = key.name ? key.name.replace(/^[OD]:/, '') : null;
    base.trustLevel = keyring.trustLevel(key);

    // Revocation / expiry take precedence — surfaced even if the sig verifies.
    if (keyring.isRevoked(key)) {
      return { ...base, state: 'REVOKED' };
    }

    // Resolve the signature. Short token → fetch full sig from vault.
    let signature = parsed.signature;
    if (parsed.isShort) {
      base.vaultUsed = true;
      signature = await vault.fetchSig(parsed.fingerprint, parsed.sigHint, parsed.timestamp);
      if (!signature) {
        return { ...base, state: 'VAULT_UNREACHABLE' };
      }
    }

    // Build the signed payload and verify the Ed25519 signature.
    const payload = canon.buildPayload(
      parsed.fingerprint, parsed.keyHint, contentHash, parsed.timestamp
    );
    console.debug('[SSD:verify] payload:', payload);

    let valid = false;
    try {
      const pubKey = await crypto.subtle.importKey(
        'raw', this.b64ToBytes(key.public_key), { name: 'Ed25519' }, false, ['verify']
      );
      valid = await crypto.subtle.verify(
        { name: 'Ed25519' }, pubKey,
        this.b64ToBytes(signature),
        new TextEncoder().encode(payload)
      );
    } catch (err) {
      console.debug('[SSD:verify] crypto.subtle.verify threw:', err);
      valid = false;
    }
    console.debug('[SSD:verify] valid:', valid);

    if (valid) {
      if (keyring.isExpired(key, parsed.timestamp)) {
        return { ...base, state: 'EXPIRED' };
      }
      return { ...base, state: known ? 'VALID' : 'VALID_UNKNOWN' };
    }

    // Signature did not verify against the computed content hash.
    //
    // Distinguish MISMATCH (content changed after signing) from INVALID
    // (signature is simply bad / wrong key). We probe the signed payload with a
    // sentinel content hash: if the signature verifies against a payload whose
    // only difference is the content hash, the key & timestamp & hint are right
    // and only the content diverged → MISMATCH. There is no way to recover the
    // original hash locally, so we use the vault discovery query when available
    // to confirm; otherwise we classify a verifying-key/non-verifying-hash as
    // MISMATCH and a non-resolvable signature as INVALID.
    const mismatch = await this._isContentMismatch(key, parsed, signature);
    return { ...base, state: mismatch ? 'MISMATCH' : 'INVALID' };
  },

  // Decide MISMATCH vs INVALID. A MISMATCH means the signature is well-formed
  // and verifies against the signer's key for SOME content hash — i.e. the key,
  // key-hint and timestamp are consistent and only the post text changed.
  //
  // Strategy: query the vault (if configured) for the canonical text the signer
  // actually signed. If we get it back and its hash makes the signature verify,
  // the post was modified → MISMATCH. If the vault is unavailable we fall back
  // to: a structurally valid signature (correct length, decodes) with a key we
  // could resolve is treated as MISMATCH; anything else is INVALID.
  async _isContentMismatch(key, parsed, signature) {
    // Try vault discovery to confirm against the originally signed text.
    try {
      const sigHint = parsed.isShort ? parsed.sigHint : tokenParser.sigHint(signature);
      const discovered = await vault.query(parsed.fingerprint, sigHint);
      if (discovered && discovered.canonical_text != null) {
        const orig = await canon.canonicalise(discovered.canonical_text);
        const payload = canon.buildPayload(
          parsed.fingerprint, parsed.keyHint, orig.contentHash,
          discovered.timestamp || parsed.timestamp
        );
        const pubKey = await crypto.subtle.importKey(
          'raw', this.b64ToBytes(key.public_key), { name: 'Ed25519' }, false, ['verify']
        );
        const ok = await crypto.subtle.verify(
          { name: 'Ed25519' }, pubKey,
          this.b64ToBytes(signature),
          new TextEncoder().encode(payload)
        );
        // Signature verifies against the signer's own canonical text but not
        // against the displayed text → the displayed text was modified.
        return ok;
      }
    } catch {
      // fall through to heuristic
    }

    // Heuristic fallback: a 64-byte (decoded) Ed25519 signature that we could
    // not verify against a resolvable key is most plausibly a content change
    // rather than a forged signature, so surface the stronger warning.
    try {
      const sigBytes = this.b64ToBytes(signature);
      return sigBytes.length === 64;
    } catch {
      return false;
    }
  },

  _result(state, fingerprint) {
    return {
      state,
      fingerprint,
      keyHint: null,
      signerName: null,
      trustLevel: null,
      timestamp: null,
      isShort: false,
      vaultUsed: false,
    };
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = verifier;
