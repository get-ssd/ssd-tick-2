// analyser/searcher.js
// Strategy B — suffix search for the SSD analyser. Lifted from
// spikes/generic-extraction/ with the diagnosed cache-key fix:
//   Cache stores { depth, variantId } ONLY (not suffixCount).
//   On a cache hit, all suffixCounts at that depth × variantId are swept.
//   Rationale: suffixCount can shift under platform re-render / virtualisation
//   while depth and variantId remain stable across re-renders of the same post.
//
// Uses the real core/canon.js global (not an inlined copy).
// Depends on: canon, CFG (loaded before this by manifest).

const analyserSearcher = {

  VARIANTS: [
    { id: 'raw',             fn: t => t },
    { id: 'trim',            fn: t => t.trim() },
    { id: 'collapse-blanks', fn: t => t.replace(/\n{2,}/g, '\n') },
    { id: 'trim+collapse',   fn: t => t.trim().replace(/\n{2,}/g, '\n') },
  ],

  // ── cache (localStorage, per hostname) ──────────────────────────────────────

  _cacheKey() { return 'ssd-analyser-cache:' + location.hostname; },

  loadCache() {
    try {
      const raw = localStorage.getItem(this._cacheKey());
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  saveCache(depth, variantId) {
    try { localStorage.setItem(this._cacheKey(), JSON.stringify({ depth, variantId })); } catch {}
  },

  bustCache() {
    try { localStorage.removeItem(this._cacheKey()); } catch {}
  },

  // ── candidate builder ────────────────────────────────────────────────────────

  buildCandidates(tokenNode, tokenRaw) {
    const candidates = [];
    let el = (tokenNode.nodeType === Node.TEXT_NODE) ? tokenNode.parentElement : tokenNode;
    let depth = 0;
    while (el && el !== document.body && depth <= CFG.maxAncestorDepth) {
      const fullText = el.innerText || '';
      const idx = fullText.lastIndexOf(tokenRaw);
      if (idx > 0) {
        const pre = fullText.slice(0, idx);
        const paras = pre.split(/\n\n+/);
        const cap = Math.min(paras.length, CFG.maxSuffixBlocks);
        for (let n = 1; n <= cap; n++) {
          candidates.push({ depth, suffixCount: n, text: paras.slice(-n).join('\n\n') });
        }
        candidates.push({ depth, suffixCount: -1, text: pre });
      }
      el = el.parentElement;
      depth++;
    }
    return candidates;
  },

  // ── search ───────────────────────────────────────────────────────────────────

  async run(tokenNode, tokenRaw, targetContent8) {
    const attempts  = [];
    let   cacheUsed = false;
    let   winner    = null;

    const candidates = this.buildCandidates(tokenNode, tokenRaw);
    if (!candidates.length) {
      return { outcome: 'SELECTOR_EMPTY', cacheUsed, winner, attempts };
    }

    const cached = this.loadCache();

    // Cache hit path: sweep all suffixCounts at cached depth × variantId.
    if (cached) {
      const v       = this.VARIANTS.find(x => x.id === cached.variantId);
      const atDepth = candidates.filter(c => c.depth === cached.depth);
      if (v && atDepth.length) {
        cacheUsed = true;
        for (const c of atDepth) {
          const a = await this._attempt(c, v, targetContent8);
          attempts.push({ ...a, cacheProbe: true });
          if (a.c8Match) {
            winner = { depth: c.depth, suffixCount: c.suffixCount, variantId: v.id };
            return { outcome: 'RECOVERED', cacheUsed, winner, attempts };
          }
        }
        // All suffixCounts at cached depth × variantId failed → cache stale.
      }
    }

    // Full search — skip anything already attempted in the cache probe.
    const triedKeys = new Set(attempts.map(a => `${a.depth}:${a.suffixCount}:${a.variantId}`));
    for (const c of candidates) {
      for (const v of this.VARIANTS) {
        if (triedKeys.has(`${c.depth}:${c.suffixCount}:${v.id}`)) continue;
        const a = await this._attempt(c, v, targetContent8);
        attempts.push(a);
        if (a.c8Match) {
          winner = { depth: c.depth, suffixCount: c.suffixCount, variantId: v.id };
          this.saveCache(c.depth, v.id);
          return {
            outcome: cacheUsed ? 'CACHE_STALE' : 'RECOVERED',
            cacheUsed, winner, attempts,
          };
        }
      }
    }

    return { outcome: 'SEARCH_EXHAUSTED', cacheUsed, winner: null, attempts };
  },

  async _attempt(candidate, variant, targetContent8) {
    const raw = variant.fn(candidate.text);
    const { canonicalText, contentHash } = await canon.canonicalise(raw);
    const computedContent8 = contentHash.slice(0, 8);
    return {
      depth:           candidate.depth,
      suffixCount:     candidate.suffixCount,
      variantId:       variant.id,
      canonJson:       JSON.stringify(canonicalText),
      byteLen:         new TextEncoder().encode(canonicalText).length,
      contentHash,
      computedContent8,
      targetContent8,
      c8Match:         computedContent8 === targetContent8,
    };
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = analyserSearcher;
