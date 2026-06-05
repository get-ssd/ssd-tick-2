// core/token-parser.js
// Parse and build SSD token strings. Handles both full and short (#) forms.
//
// Token grammar (CANON-Spec §6):
//   Full:  —SSD·{hash8}·{identity}·{content8}·{signature}·{timestamp}—
//   Short: —SSD·{hash8}·{identity}·{content8}·#{sig-hint}·{timestamp}—
//
// {hash8}    = 8-char hex key identifier (visual prompt to the signing key)
// {identity} = platform-prefixed key discovery hint (fb:name, x:name, url:…)
// {content8} = first 8 hex chars of SHA-256 content hash (fast pre-filter
//              before running the full Ed25519 check)
//
// Fields are joined with · (U+00B7 MIDDLE DOT). The token is delimited by an
// em dash (— U+2014) at each end. The leading delimiter is "—SSD·".

const tokenParser = {

  PATTERN: /—SSD·[^—]+—/g,

  // Returns null if string is not a recognisable SSD content-sig token.
  // Accepts 5-field (current: hash8·identity·content8·sig·ts) and 4-field
  // (legacy: hash8·identity·sig·ts — no content8 hint). Both use the same
  // signing payload so verification works for both.
  parse(tokenString) {
    if (typeof tokenString !== 'string') return null;

    const trimmed = tokenString.trim();
    if (!trimmed.startsWith('—SSD·') || !trimmed.endsWith('—')) return null;

    const inner = trimmed.slice(5, -1);
    const parts = inner.split('·');

    if (parts.length === 5) {
      const [hash8, identity, content8, sigOrHint, timestamp] = parts;
      if (!hash8 || !identity || !content8 || !sigOrHint || !timestamp) return null;
      const isShort = sigOrHint.startsWith('#');
      return {
        hash8, identity, content8, isShort,
        signature: isShort ? null : sigOrHint,
        sigHint:   isShort ? sigOrHint.slice(1) : null,
        timestamp, raw: trimmed,
      };
    }

    // Legacy 4-field token — no content8 hint, but signing payload is identical.
    if (parts.length === 4) {
      const [hash8, identity, sigOrHint, timestamp] = parts;
      if (!hash8 || !identity || !sigOrHint || !timestamp) return null;
      const isShort = sigOrHint.startsWith('#');
      return {
        hash8, identity, content8: null, isShort,
        signature: isShort ? null : sigOrHint,
        sigHint:   isShort ? sigOrHint.slice(1) : null,
        timestamp, raw: trimmed,
      };
    }

    return null;
  },

  buildFull(hash8, identity, content8, signature, timestamp) {
    return `—SSD·${hash8}·${identity}·${content8}·${signature}·${timestamp}—`;
  },

  buildShort(hash8, identity, content8, sigHint, timestamp) {
    const hint = sigHint.startsWith('#') ? sigHint : `#${sigHint}`;
    return `—SSD·${hash8}·${identity}·${content8}·${hint}·${timestamp}—`;
  },

  // Extract a sig hint from a full signature (first 16 chars).
  sigHint(fullSignature) {
    return fullSignature.substring(0, 16);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = tokenParser;
