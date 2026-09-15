// platforms/reddit.js
// Reddit platform module. Implements the platform interface contract
// (verification side only). See PLAT-Reddit-v0_1.
//
// The platform module does NOT parse post structure or extract text. It only:
//   1. observe()         — tells the core scanners when to re-run
//   2. injectIndicator() — places a badge near where a sig was found
//   3. cleanup()         — disconnects observers

platforms.register('rd', {
  profileUrl:     handle => `https://www.reddit.com/user/${encodeURIComponent(handle)}`,
  label:          'Visit their Reddit profile to import key',
  nameFromHandle: handle => `u/${handle}`,
});

const reddit = {
  id: 'reddit',
  name: 'Reddit',
  // localhost/127.0.0.1: the socialmedia-mock server's Reddit pages — the
  // manifest only injects this file on /social-mock/reddit* paths there.
  hostnames: ['www.reddit.com', 'old.reddit.com', 'localhost', '127.0.0.1'],

  _observer: null,
  _debounceTimer: null,
  _origPushState: null,
  _popstateHandler: null,

  observe(onNewContent) {
    onNewContent();

    this._observer = new MutationObserver(() => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => onNewContent(), 150);
    });
    this._observer.observe(document.body, { childList: true, subtree: true });

    this._origPushState = history.pushState.bind(history);
    const self = this;
    history.pushState = function (...args) {
      self._origPushState(...args);
      onNewContent();
    };
    this._popstateHandler = () => onNewContent();
    window.addEventListener('popstate', this._popstateHandler);
  },

  injectIndicator(anchorNode, badgeElement) {
    const container = anchorNode.parentElement || anchorNode.parentNode;
    if (!container) { console.debug('[SSD:inject] no container'); return null; }
    const existing = container.querySelector && container.querySelector('.ssd-indicator');
    if (existing) { console.debug('[SSD:inject] returning existing badge'); return existing; }
    container.appendChild(badgeElement);
    console.debug('[SSD:inject] badge injected into', container.nodeName);
    return badgeElement;
  },

  cleanup() {
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    clearTimeout(this._debounceTimer);
    if (this._origPushState) { history.pushState = this._origPushState; this._origPushState = null; }
    if (this._popstateHandler) {
      window.removeEventListener('popstate', this._popstateHandler);
      this._popstateHandler = null;
    }
  },
};

// ── Content-script bootstrap ───────────────────────────────────────────────────

(function bootstrapReddit() {
  if (!reddit.hostnames.includes(location.hostname)) return;

  // Standard HTML block elements used by Reddit's markdown renderer.
  // Reddit renders post/comment markdown to <p>, <ul>/<li>, <blockquote>, <pre>,
  // <h1>–<h6>, <table>, etc. — the same set as Facebook's block structure.
  const BLOCK_TAGS = new Set([
    'ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DD','DIV','DL','DT',
    'FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM',
    'H1','H2','H3','H4','H5','H6',
    'HEADER','HGROUP','LI','MAIN','NAV','OL','P',
    'PRE','SECTION','SUMMARY','TABLE','TD','TH','TR','UL',
  ]);

  // Recovers the text as rendered, not as it sits in the HTML source. Live
  // Reddit indents its markup (`<p>\n      text\n    </p>`), so text nodes are
  // collapsed the way CSS `white-space: normal` does: whitespace runs become a
  // single space, dropped at line starts and before block breaks. <pre> is
  // kept verbatim.
  function extractText(el, inPre = false) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (inPre) { out += node.nodeValue; continue; }
        let t = node.nodeValue.replace(/[ \t\n\r\f]+/g, ' ');
        if (out === '' || out.endsWith('\n') || out.endsWith(' ')) t = t.replace(/^ /, '');
        out += t;
      } else if (node.nodeName === 'BR') {
        if (!inPre) out = out.replace(/ +$/, '');
        out += '\n';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
        const pre = inPre || tag === 'PRE';
        let inner = extractText(node, pre);
        if (BLOCK_TAGS.has(tag) && !pre) inner = inner.replace(/ +$/, '');
        if (BLOCK_TAGS.has(tag) && inner !== '') {
          if (!inPre) out = out.replace(/ +$/, '');
          if (out.length > 0 && !out.endsWith('\n')) out += '\n';
          if (!out.endsWith('\n\n')) out += '\n';
          out += inner;
          if (!out.endsWith('\n')) out += '\n';
          if (!out.endsWith('\n\n')) out += '\n';
        } else {
          if (!pre && (out === '' || out.endsWith('\n') || out.endsWith(' '))) inner = inner.replace(/^ /, '');
          out += inner;
        }
      }
    }
    return out;
  }

  function readPostText(textNode, tokenRaw) {
    let el = textNode.parentElement;
    while (el && el !== document.body) {
      const full = extractText(el);
      const idx = full.lastIndexOf(tokenRaw);
      if (idx >= 10) {
        const pre = full.slice(0, idx).trim();
        console.debug('[SSD:readPost]', el.nodeName, 'pre-token:', pre.length,
          '»', pre.slice(0, 60).replace(/\n/g, '↵'));
        return pre;
      }
      el = el.parentElement;
    }
    console.debug('[SSD:readPost] no container found');
    return '';
  }

  // [SSDKEY:] beacon handler — three import states per SPEC-PROTO §5.7.
  const handleKeyBeacon = textScanner.makeBeaconHandler(
    (hash8) => {
      // Real Reddit serves profiles at /user/<h> or /u/<h>; the socialmedia-mock
      // serves them at /social-mock/reddit/user/<h> — match the /user|u/ segment
      // wherever it appears in the path.
      const pathMatch   = location.pathname.match(/(?:^|\/)(?:user|u)\/([-\w]+)/i);
      const urlHandle   = pathMatch ? pathMatch[1] : null;
      const identity    = urlHandle ? `rd:${urlHandle}` : null;
      const title       = document.title;
      const uSlash      = title.match(/\bu\/([-\w]+)/i);
      const overviewFor = title.match(/overview\s+for\s+([-\w]+)/i);
      const titleName   = uSlash ? `u/${uSlash[1]}` : overviewFor ? `u/${overviewFor[1]}` : '';
      const h1Name      = document.querySelector('h1')?.innerText?.trim() || '';
      const name = titleName || h1Name || hash8;
      return { name, identity };
    },
    () => onNewContent()
  );

  let scanning = false;
  async function onNewContent() {
    if (scanning) return;
    scanning = true;
    try {
      const jobs = [];
      textScanner.scan(
        (textNode, parsedToken, commit) => {
          const rawPostText = parsedToken ? readPostText(textNode, parsedToken.raw) : '';
          jobs.push({ textNode, parsedToken, commit, rawPostText });
        },
        handleKeyBeacon
      );
      console.debug('[SSD:reddit] scan complete, jobs:', jobs.length);
      for (const { textNode, parsedToken, commit, rawPostText } of jobs) {
        const scanningEl = badge.create({
          state: 'SCANNING',
          hash8:    parsedToken ? parsedToken.hash8    : null,
          identity: parsedToken ? parsedToken.identity : null,
          signerName: null, trustLevel: null,
          timestamp: parsedToken ? parsedToken.timestamp : null,
          isShort: parsedToken ? parsedToken.isShort : false,
          vaultUsed: false,
        });
        const badgeEl = reddit.injectIndicator(textNode, scanningEl) || scanningEl;

        if (!parsedToken) {
          console.debug('[SSD:reddit] unrecognised token format, badged but not verified');
          commit();
          continue;
        }

        console.debug('[SSD:reddit] rawPostText length:', rawPostText.length, 'preview:', rawPostText.slice(0, 80).replace(/\n/g, '↵'));
        let result;
        try {
          result = await verifier.verify(parsedToken.raw, rawPostText);
        } catch (err) {
          console.error('[SSD] verify failed', err);
          result = {
            state: 'INVALID', hash8: parsedToken.hash8,
            identity: parsedToken.identity, signerName: null, trustLevel: null,
            timestamp: parsedToken.timestamp, isShort: false, vaultUsed: false,
          };
        }
        console.debug('[SSD:reddit] verify result:', result.state, 'hash8:', result.hash8);
        result._rawPostText = rawPostText;
        badge.update(badgeEl, result);
        commit();
      }
    } finally {
      scanning = false;
    }
  }

  keyring.load().then(() => {
    reddit.observe(onNewContent);
  });

  window.addEventListener('unload', () => reddit.cleanup());
})();

if (typeof module !== 'undefined' && module.exports) module.exports = reddit;
