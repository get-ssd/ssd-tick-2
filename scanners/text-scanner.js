// scanners/text-scanner.js
// Scans the page for —SSD· tokens in text content. For each post context the
// LAST token is the post's own token; earlier occurrences are quoted/embedded
// tokens from other posts and are skipped.
//
// "Post context" = the nearest [role="article"] ancestor of a text node, or
// document.body when no article ancestor exists.

const textScanner = {

  // Scan the DOM for tokens. For each selected (last-in-context) token, call
  // callback(textNode, parsedToken).
  scan(callback) {
    // Quick bail: if the page has no token at all, do nothing (avoids walking
    // the whole DOM on token-free pages → no console noise, cheap).
    if (document.body.textContent.indexOf('—SSD·') === -1) return;

    // Collect every text node that contains at least one token.
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentNode;
          if (p) {
            const tag = p.nodeName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
                tag === 'TEXTAREA' || tag === 'INPUT') {
              return NodeFilter.FILTER_REJECT;
            }
          }
          return node.textContent.indexOf('—SSD·') !== -1
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        },
      }
    );

    // Group token-bearing text nodes by their post context.
    // Map<contextElement, Array<{ node, parsed, raw }>>
    const byContext = new Map();

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      const pattern = tokenParser.PATTERN;
      pattern.lastIndex = 0;
      let match;
      const matches = [];
      while ((match = pattern.exec(text)) !== null) {
        const parsed = tokenParser.parse(match[0]);
        if (parsed) matches.push({ raw: match[0], parsed });
      }
      if (!matches.length) continue;

      const context = this._contextOf(node);
      if (!byContext.has(context)) byContext.set(context, []);
      const bucket = byContext.get(context);
      for (const m of matches) {
        bucket.push({ node, parsed: m.parsed, raw: m.raw });
      }
    }

    // For each context, the post's own token is the LAST one. Skip the rest.
    for (const [, tokens] of byContext) {
      if (!tokens.length) continue;
      const chosen = tokens[tokens.length - 1];
      // Guard against re-processing the same text node + token.
      const key = chosen.node;
      if (this._isProcessed(key, chosen.raw)) continue;
      this._markProcessed(key, chosen.raw);
      callback(chosen.node, chosen.parsed);
    }
  },

  // Find the post context for a node: nearest [role="article"] ancestor, else
  // document.body.
  _contextOf(node) {
    let el = node.parentElement;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute('role') === 'article') return el;
      el = el.parentElement;
    }
    return document.body;
  },

  // Track processed (textNode, rawToken) pairs to avoid duplicate callbacks
  // across repeated scans. Text nodes can't hold data-* attributes, so we use a
  // WeakMap keyed by the node holding the set of raw tokens already emitted.
  _processed: new WeakMap(),

  _isProcessed(node, raw) {
    const set = this._processed.get(node);
    return !!set && set.has(raw);
  },

  _markProcessed(node, raw) {
    let set = this._processed.get(node);
    if (!set) { set = new Set(); this._processed.set(node, set); }
    set.add(raw);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = textScanner;
