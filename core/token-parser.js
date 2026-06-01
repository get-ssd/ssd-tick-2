// core/token-parser.js
// Parse and build SSD token strings. Handles both full and short (#) forms.
//
// Token grammar (CANON-Spec §6):
//   Full:  —SSD·{fingerprint}·{key-hint}·{signature}·{timestamp}—
//   Short: —SSD·{fingerprint}·{key-hint}·#{sig-hint}·{timestamp}—
//
// Fields are joined with · (U+00B7 MIDDLE DOT). The token is delimited by an
// em dash (— U+2014) at each end. The leading delimiter is "—SSD·".

const tokenParser = {

  // Matches a single SSD token (full or short). Used by scanners to locate
  // tokens in free text. The inner part is everything between the leading
  // "—SSD·" and the trailing "—".
  PATTERN: /—SSD·[^—]+—/g,

  // Returns null if string is not a valid SSD token.
  parse(tokenString) {
    if (typeof tokenString !== 'string') return null;

    const trimmed = tokenString.trim();
    // Must start with —SSD· and end with —
    if (!trimmed.startsWith('—SSD·') || !trimmed.endsWith('—')) return null;

    // Strip "—SSD·" (5 chars) at the front and "—" (1 char) at the back.
    const inner = trimmed.slice(5, -1);
    const parts = inner.split('·');

    // Expect exactly: fingerprint, key-hint, sig-or-hint, timestamp
    if (parts.length !== 4) return null;

    const [fingerprint, keyHint, sigOrHint, timestamp] = parts;
    if (!fingerprint || !keyHint || !sigOrHint || !timestamp) return null;

    const isShort = sigOrHint.startsWith('#');

    return {
      fingerprint,
      keyHint,
      isShort,
      signature: isShort ? null : sigOrHint,
      sigHint:   isShort ? sigOrHint.slice(1) : null,
      timestamp,
      raw: trimmed,
    };
  },

  // Build a full token string from fields.
  buildFull(fingerprint, keyHint, signature, timestamp) {
    return `—SSD·${fingerprint}·${keyHint}·${signature}·${timestamp}—`;
  },

  // Build a short token string from fields. sigHint is the bare hint (no #);
  // this adds the # prefix.
  buildShort(fingerprint, keyHint, sigHint, timestamp) {
    const hint = sigHint.startsWith('#') ? sigHint : `#${sigHint}`;
    return `—SSD·${fingerprint}·${keyHint}·${hint}·${timestamp}—`;
  },

  // Extract a sig hint from a full signature (first 16 chars).
  sigHint(fullSignature) {
    return fullSignature.substring(0, 16);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = tokenParser;
