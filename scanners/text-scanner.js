// scanners/text-scanner.js
// Scans the page for [SSD:...] tokens in text content.
// Each token text node is its own context — one badge per token.

const textScanner = {

  scan(callback, onKeyDeclaration) {
    if (document.body.textContent.indexOf('[SSD:') === -1) {
      console.debug('[SSD:scan] no [SSD: found in page text');
      return;
    }
    console.debug('[SSD:scan] [SSD: found in page, walking text nodes');

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
          return node.textContent.indexOf('[SSD:') !== -1
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        },
      }
    );

    // Each token text node is its own context (keyed by parent element).
    // Map<parentElement, Array<{ node, parsed, raw }>>
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
        } else {
          // 2-field key declaration: [SSD:{hash8}:{value}]
          // Split at first colon only — value may be a URL containing colons.
          const inner = match[0].slice(5, -1);
          const colonIdx = inner.indexOf(':');
          if (colonIdx > 0) {
            const h8 = inner.slice(0, colonIdx);
            const val = inner.slice(colonIdx + 1);
            if (h8 && val && onKeyDeclaration) onKeyDeclaration(h8, val, node);
          } else {
            matches.push({ raw: match[0], parsed: null });
          }
        }
      }
      if (!matches.length) continue;

      const context = node.parentElement || document.body;
      console.debug('[SSD:scan] text node context:', context.nodeName, 'matches:', matches.length);
      if (!byContext.has(context)) byContext.set(context, []);
      const bucket = byContext.get(context);
      for (const m of matches) {
        bucket.push({ node, parsed: m.parsed, raw: m.raw });
      }
    }

    console.debug('[SSD:scan] contexts found:', byContext.size);
    for (const [ctx, tokens] of byContext) {
      if (!tokens.length) continue;
      const chosen = tokens[tokens.length - 1];
      const key = chosen.node;
      if (this._isProcessed(key, chosen.raw)) {
        console.debug('[SSD:scan] already processed, skipping:', chosen.raw.slice(0, 40));
        continue;
      }
      const commit = () => this._markProcessed(key, chosen.raw);
      console.debug('[SSD:scan] firing callback for token:', chosen.raw.slice(0, 40));
      callback(chosen.node, chosen.parsed, commit);
    }
  },

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
