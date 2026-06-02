// scanners/text-scanner.js
// Scans the page for —SSD· tokens in text content. For each post context the
// LAST token is the post's own token; earlier occurrences are quoted/embedded
// tokens from other posts and are skipped.
//
// "Post context" = the nearest [role="article"] ancestor of a text node, or
// document.body when no article ancestor exists.

const textScanner = {

  // Scan the DOM for tokens. For each selected (last-in-context) 4-field
  // content-signature token, call callback(textNode, parsedToken).
  // For 3-field key-declaration tokens (—SSD·fp·value—), call
  // onKeyDeclaration(fingerprint, value) if provided.
  scan(callback, onKeyDeclaration) {
    // Quick bail: if the page has no token at all, do nothing (avoids walking
    // the whole DOM on token-free pages → no console noise, cheap).
    if (document.body.textContent.indexOf('—SSD·') === -1) {
      console.debug('[SSD:scan] no —SSD· found in page text');
      return;
    }
    console.debug('[SSD:scan] —SSD· found in page, walking text nodes');

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
        console.debug('[SSD:scan] PATTERN matched raw:', match[0]);
        const parsed = tokenParser.parse(match[0]);
        console.debug('[SSD:scan] tokenParser.parse result:', parsed);
        if (parsed) {
          matches.push({ raw: match[0], parsed });
        } else if (onKeyDeclaration) {
          // 3-field key declaration: —SSD·{fingerprint}·{value}—
          const inner = match[0].slice(5, -1);
          const parts = inner.split('·');
          if (parts.length === 2 && parts[0] && parts[1]) {
            onKeyDeclaration(parts[0], parts[1], node);
          }
        }
      }
      if (!matches.length) continue;

      const context = this._contextOf(node);
      if (!byContext.has(context)) byContext.set(context, []);
      const bucket = byContext.get(context);
      for (const m of matches) {
        bucket.push({ node, parsed: m.parsed, raw: m.raw });
      }
    }

    console.debug('[SSD:scan] contexts found:', byContext.size);
    // For each context, the post's own token is the LAST one. Skip the rest.
    for (const [ctx, tokens] of byContext) {
      if (!tokens.length) continue;
      const chosen = tokens[tokens.length - 1];
      // Guard against re-processing the same text node + token.
      const key = chosen.node;
      if (this._isProcessed(key, chosen.raw)) {
        console.debug('[SSD:scan] already processed, skipping:', chosen.raw.slice(0, 40));
        continue;
      }
      // Pass a commit function — caller must invoke it once the result is
      // final (non-TRUNCATED). This avoids locking out a token that was
      // scanned before the post text was fully loaded.
      const commit = () => this._markProcessed(key, chosen.raw);
      console.debug('[SSD:scan] firing callback for token:', chosen.raw.slice(0, 40), 'context:', ctx.nodeName, ctx.getAttribute && ctx.getAttribute('role'));
      callback(chosen.node, chosen.parsed, commit);
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
