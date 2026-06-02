// core/token-parser.js
// Parse and build SSD token strings. Handles both full and short (#) forms.
//
// Token grammar (CANON-Spec §6):
//   Full:  —SSD·{fingerprint}·{key-hint}·{hash8}·{signature}·{timestamp}—
//   Short: —SSD·{fingerprint}·{key-hint}·{hash8}·#{sig-hint}·{timestamp}—
//
// {hash8} = first 8 hex chars of the SHA-256 content hash. Allows cheap
// pre-screening of candidate texts before running the full Ed25519 check.
//
// Fields are joined with · (U+00B7 MIDDLE DOT). The token is delimited by an
// em dash (— U+2014) at each end. The leading delimiter is "—SSD·".

const tokenParser = {

  PATTERN: /—SSD·[^—]+—/g,

  // Returns null if string is not a valid 5-field SSD token.
  parse(tokenString) {
    if (typeof tokenString !== 'string') return null;

    const trimmed = tokenString.trim();
    if (!trimmed.startsWith('—SSD·') || !trimmed.endsWith('—')) return null;

    const inner = trimmed.slice(5, -1);
    const parts = inner.split('·');

    // Expect exactly: fingerprint · keyHint · hash8 · sig-or-hint · timestamp
    if (parts.length !== 5) return null;

    const [fingerprint, keyHint, hash8, sigOrHint, timestamp] = parts;
    if (!fingerprint || !keyHint || !hash8 || !sigOrHint || !timestamp) return null;

    const isShort = sigOrHint.startsWith('#');

    return {
      fingerprint,
      keyHint,
      hash8,
      isShort,
      signature: isShort ? null : sigOrHint,
      sigHint:   isShort ? sigOrHint.slice(1) : null,
      timestamp,
      raw: trimmed,
    };
  },

  buildFull(fingerprint, keyHint, hash8, signature, timestamp) {
    return `—SSD·${fingerprint}·${keyHint}·${hash8}·${signature}·${timestamp}—`;
  },

  buildShort(fingerprint, keyHint, hash8, sigHint, timestamp) {
    const hint = sigHint.startsWith('#') ? sigHint : `#${sigHint}`;
    return `—SSD·${fingerprint}·${keyHint}·${hash8}·${hint}·${timestamp}—`;
  },

  // Extract a sig hint from a full signature (first 16 chars).
  sigHint(fullSignature) {
    return fullSignature.substring(0, 16);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = tokenParser;
