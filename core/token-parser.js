// core/token-parser.js
// Parse and build SSD token strings. Handles both full and short (#) forms.
//
// Token grammar (PROTO-Spec v0.4 §5):
//   Full:  [SSD:{hash8}:{identity}:{content8}:{signature}:{timestamp}]
//   Short: [SSD:{hash8}:{identity}:{content8}:#{sig-hint}:{timestamp}]
//
// {hash8}    = 8-char hex key identifier
// {identity} = platform-prefixed key discovery hint (fb:name, x:name, url:…)
// {content8} = first 8 hex chars of SHA-256 content hash (fast pre-filter)
//
// Fields are joined with : (colon). Token is delimited by [ and ].

const tokenParser = {

  PATTERN: /\[SSD:[^\]]+\]/g,

  // Returns null if string is not a recognisable SSD content-sig token.
  // Accepts 5-field (hash8:identity:content8:sig:ts) and 4-field legacy
  // (hash8:identity:sig:ts — no content8 hint).
  //
  // Parsing strategy: anchor from the ends. Timestamp always has exactly one
  // internal colon (HH:MM), so the last two split-parts are always ts_start
  // and ts_end. Sig is base64url (no colons). content8 is 8 lowercase hex
  // chars. identity may contain colons (e.g. fb:j.smith). We try full format
  // first (checking parts[-4] against [0-9a-f]{8}), then legacy.
  parse(tokenString) {
    if (typeof tokenString !== 'string') return null;

    const trimmed = tokenString.trim();
    if (!trimmed.startsWith('[SSD:') || !trimmed.endsWith(']')) return null;

    const inner = trimmed.slice(5, -1);
    const parts = inner.split(':');
    const n = parts.length;

    // Need at least: hash8 + identity + sig + ts_start + ts_end = 5 parts
    if (n < 5) return null;

    const hash8     = parts[0];
    const timestamp = parts[n - 2] + ':' + parts[n - 1];

    // Try full format: parts[n-4] must be 8 lowercase hex chars (content8)
    if (n >= 6 && /^[0-9a-f]{8}$/.test(parts[n - 4])) {
      const content8  = parts[n - 4];
      const sigOrHint = parts[n - 3];
      const identity  = parts.slice(1, n - 4).join(':');
      if (!hash8 || !identity || !sigOrHint) return null;
      const isShort = sigOrHint.startsWith('#');
      return {
        hash8, identity, content8, isShort,
        signature: isShort ? null : sigOrHint,
        sigHint:   isShort ? sigOrHint.slice(1) : null,
        timestamp, raw: trimmed,
      };
    }

    // Legacy 4-field token — no content8 hint, signing payload is identical.
    {
      const sigOrHint = parts[n - 3];
      const identity  = parts.slice(1, n - 3).join(':');
      if (!hash8 || !identity || !sigOrHint) return null;
      const isShort = sigOrHint.startsWith('#');
      return {
        hash8, identity, content8: null, isShort,
        signature: isShort ? null : sigOrHint,
        sigHint:   isShort ? sigOrHint.slice(1) : null,
        timestamp, raw: trimmed,
      };
    }
  },

  buildFull(hash8, identity, content8, signature, timestamp) {
    return `[SSD:${hash8}:${identity}:${content8}:${signature}:${timestamp}]`;
  },

  buildShort(hash8, identity, content8, sigHint, timestamp) {
    const hint = sigHint.startsWith('#') ? sigHint : `#${sigHint}`;
    return `[SSD:${hash8}:${identity}:${content8}:${hint}:${timestamp}]`;
  },

  // Extract a sig hint from a full signature (first 16 chars).
  sigHint(fullSignature) {
    return fullSignature.substring(0, 16);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = tokenParser;
