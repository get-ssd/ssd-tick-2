// core/platforms.js
// Platform registry. Platform modules call platforms.register() so the rest of
// the extension can turn a key hint into a profile URL and a link label without
// knowing platform-specific URL schemes.
//
// Built-in fallbacks handle url: and bare https:// hints which are always
// directly linkable regardless of which platform files are loaded.

const platforms = {
  _map: {},

  // Register hint-prefix handling for a platform.
  //   prefix         — the part before ':', e.g. 'fb'
  //   opts.profileUrl(handle) → full URL string
  //   opts.label     — string shown as the clickable link text
  register(prefix, opts) {
    this._map[prefix] = opts;
  },

  // Derive a clickable URL from a key hint, or null if not resolvable.
  hintUrl(keyHint) {
    if (!keyHint) return null;
    const colon = keyHint.indexOf(':');
    if (colon === -1) return null;
    const prefix = keyHint.slice(0, colon);
    const rest   = keyHint.slice(colon + 1);
    if (this._map[prefix]) return this._map[prefix].profileUrl(rest);
    if (prefix === 'url')                          return rest;
    if (prefix === 'https' || prefix === 'http')   return keyHint;
    return null;
  },

  // Human-readable label for the link action, or null.
  hintLabel(keyHint) {
    if (!keyHint) return null;
    const colon = keyHint.indexOf(':');
    if (colon === -1) return null;
    const prefix = keyHint.slice(0, colon);
    if (this._map[prefix]) return this._map[prefix].label;
    if (prefix === 'url' || prefix === 'https' || prefix === 'http') return 'Fetch key from URL';
    return null;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = platforms;
