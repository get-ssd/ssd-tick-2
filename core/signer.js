// core/signer.js
// Signing pipeline — the single entry point for building a signed token.
// All compose plugins call signer.sign(); no signing logic lives in platform
// files or ui files.
//
// Depends on: canon, tokenParser, keyring, vault (loaded before this in the
// manifest). The actual Ed25519 signature is produced by the PWA; keys never
// leave the PWA. The service worker opens the PWA for biometric confirmation
// and returns the signature once the user approves.

const signer = {

  // Full signing pipeline.
  //   rawText  — post body text (without any existing [SSD:…] token)
  //   hash8    — key identifier: which key to sign with
  //   platform — 'facebook', 'twitter', etc. (recorded in vault; no effect on sig)
  //
  // Returns { token, contentHash, fullSignature, canonicalText }.
  // Throws on failure (key missing, PWA cancellation, timeout, etc.).
  async sign(rawText, hash8, platform) {
    // 1. Canonicalise.
    const { canonicalText, contentHash } = await canon.canonicalise(rawText);

    // 2. Key settings.
    const key = keyring.get(hash8);
    if (!key) throw new Error(`Key not found: ${hash8}`);

    // identity tells verifiers where to look up this key (e.g. 'fb:alice.smith').
    // Falls back to 'fp:{hash8}' — requires verifier to already hold the key locally.
    const identity = key.identity || `fp:${hash8}`;
    const tokenDefault = key.token_default || 'auto';
    const vaultCfg = vault.getConfig(hash8);

    // 3. Determine token type.
    let tokenType;
    if (tokenDefault === 'full') {
      tokenType = 'full';
    } else if (tokenDefault === 'short') {
      if (!vaultCfg.url) throw new Error('Short token requires a vault — none configured for this key');
      tokenType = 'short';
    } else {
      // auto: short when a public vault is configured, full otherwise
      tokenType = (vaultCfg.url && vaultCfg.visibility === 'public') ? 'short' : 'full';
    }

    // 4. Build the signed payload string (CANON-Spec §5).
    // Timestamp at minute precision: "2026-06-01T14:17Z"
    const timestamp = new Date().toISOString().slice(0, 16) + 'Z';
    const payload = canon.buildPayload(hash8, identity, contentHash, timestamp);

    // 5. Request signature from service worker (which opens PWA for biometric confirmation).
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'SSD_SIGN_REQUEST',
        payload: { hash8, signedPayload: payload, platform, previewText: canonicalText },
      });
    } catch (err) {
      throw new Error(`Sign request failed: ${err.message || err}`);
    }
    if (!resp || !resp.ok) {
      throw new Error(resp && resp.error ? resp.error : 'Signing failed or was cancelled');
    }
    const fullSignature = resp.signature;

    // 6. Build token string.
    const content8 = contentHash.slice(0, 8);
    let token;
    if (tokenType === 'short') {
      token = tokenParser.buildShort(hash8, identity, content8, tokenParser.sigHint(fullSignature), timestamp);
    } else {
      token = tokenParser.buildFull(hash8, identity, content8, fullSignature, timestamp);
    }

    // 7. Vault submission — fire-and-forget; don't fail the sign if vault is down.
    if (vaultCfg.url) {
      vault.submit(hash8, identity, contentHash, canonicalText, fullSignature, timestamp, platform)
        .catch(() => {});
    }

    return { token, contentHash, fullSignature, canonicalText };
  },

  // Returns all keys that are eligible for signing (have a public_key and are
  // not revoked or expired). Used by the key picker in sign-button.js.
  signingKeys() {
    return Object.values(keyring.all()).filter(k =>
      k.public_key && !keyring.isRevoked(k) && !keyring.isExpired(k, null)
    );
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = signer;
