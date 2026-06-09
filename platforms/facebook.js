// platforms/facebook.js
// Facebook platform module. Implements the platform interface contract
// (verification side only — compose side is Prompt 2). See PLAT-Facebook-v0_2.
//
// The platform module does NOT parse post structure or extract text. It only:
//   1. observe()         — tells the core scanners when to re-run
//   2. injectIndicator() — places a badge near where a sig was found
//   3. cleanup()         — disconnects observers
//
// The content-script bootstrap (at the bottom of this file) wires the scanner,
// verifier and badge together: it is the single place that orchestrates a scan.

platforms.register('fb', {
  profileUrl:      handle => `https://www.facebook.com/${encodeURIComponent(handle)}`,
  label:           'Visit their Facebook profile to import key',
  nameFromHandle:  handle => handle,   // e.g. "alice.smith" — better than a hash8
});

const facebook = {
  id: 'facebook',
  name: 'Facebook',
  hostnames: ['www.facebook.com', 'm.facebook.com'],

  _observer: null,
  _debounceTimer: null,
  _origPushState: null,
  _popstateHandler: null,

  observe(onNewContent) {
    // Initial load.
    onNewContent();

    // Infinite scroll / dynamic posts — MutationObserver, debounced 150ms.
    this._observer = new MutationObserver(() => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => onNewContent(), 150);
    });
    this._observer.observe(document.body, { childList: true, subtree: true });

    // SPA navigation — wrap history.pushState and listen for popstate.
    this._origPushState = history.pushState.bind(history);
    const self = this;
    history.pushState = function (...args) {
      self._origPushState(...args);
      onNewContent();
    };
    this._popstateHandler = () => onNewContent();
    window.addEventListener('popstate', this._popstateHandler);
  },

  // Inject badgeElement near the anchor node. Returns the badge that is in the
  // DOM — either the newly injected one, or an existing one from a prior scan.
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
// Orchestrates: scan → for each token, read post text, verify, inject badge.
// Lives here because this is the active platform module loaded last by the
// manifest; adding a new platform = a new file that runs its own bootstrap.

(function bootstrapFacebook() {
  if (!facebook.hostnames.includes(location.hostname)) return;

  // Block-level HTML elements — their boundaries become \n in extracted text,
  // mirroring what el.innerText (used at signing time in sign-button._readCompose)
  // produces. Without this, paragraph breaks in Facebook posts are lost and
  // the content hash never matches what was signed.
  const BLOCK_TAGS = new Set([
    'ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DD','DIV','DL','DT',
    'FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM',
    'H1','H2','H3','H4','H5','H6',
    'HEADER','HGROUP','LI','MAIN','NAV','OL','P',
    'PRE','SECTION','SUMMARY','TABLE','TD','TH','TR','UL',
  ]);

  // Recursively extract text from the Facebook post DOM.
  //
  // Facebook uses two levels of block structure:
  //   <div dir="auto"> — a single line (soft-return within a paragraph) → \n
  //   other block divs  — a paragraph wrapper (hard Enter / blank line)  → \n\n
  //
  // This matches the compose-side behaviour: Shift+Enter produces a sibling
  // <div dir="auto"> (→ \n), Enter produces a new outer wrapper (→ \n\n).
  function extractText(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue;
      } else if (node.nodeName === 'BR') {
        out += '\n';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
        const inner = extractText(node);
        if (BLOCK_TAGS.has(tag) && inner !== '') {
          // <div dir="..."> = line-level (soft return) → single \n boundary
          // other block     = paragraph-level (hard return) → double \n boundary
          const isLine = tag === 'DIV' && node.hasAttribute('dir');
          if (out.length > 0) {
            if (!out.endsWith('\n')) out += '\n';
            if (!isLine && !out.endsWith('\n\n')) out += '\n';
          }
          out += inner;
          if (!out.endsWith('\n')) out += '\n';
          if (!isLine && !out.endsWith('\n\n')) out += '\n';
        } else {
          out += inner;
        }
      }
    }
    return out;
  }

  // Walk up from the token text node to find the post body.
  // Takes only the text that appears BEFORE the token in the extracted text —
  // this excludes badge text (appended after the token's parent) and any
  // Facebook UI that follows the token ("See less", engagement buttons, etc.).
  // Returns '' if no suitable container is found.
  function readPostText(textNode, tokenRaw) {
    let el = textNode.parentElement;
    while (el && el !== document.body) {
      const full = el.innerText || '';
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
      const pathParts = location.pathname.split('/').filter(Boolean);
      const urlHandle = pathParts.length === 1 && pathParts[0] !== 'profile.php'
        ? pathParts[0] : null;
      const identity  = urlHandle ? `fb:${urlHandle}` : null;
      const titleParts = document.title.split('|');
      const titleName  = titleParts.length >= 2 ? titleParts[0].trim() : '';
      const h1Name     = document.querySelector('h1')?.innerText?.trim() || '';
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
          // Capture post text NOW, before any badge injection touches the DOM.
          // On the individual post page, badge injection can trigger a React
          // re-render that detaches the original text node, leaving
          // textNode.parentElement null when readPostText runs later.
          const rawPostText = parsedToken ? readPostText(textNode, parsedToken.raw) : '';
          jobs.push({ textNode, parsedToken, commit, rawPostText });
        },
        handleKeyBeacon
      );
      console.debug('[SSD:fb] scan complete, jobs:', jobs.length);
      for (const { textNode, parsedToken, commit, rawPostText } of jobs) {
        // Inject SCANNING badge immediately — even for unrecognised token formats.
        const scanningEl = badge.create({
          state: 'SCANNING',
          hash8:    parsedToken ? parsedToken.hash8     : null,
          identity: parsedToken ? parsedToken.identity  : null,
          signerName: null, trustLevel: null,
          timestamp: parsedToken ? parsedToken.timestamp : null,
          isShort: parsedToken ? parsedToken.isShort : false,
          vaultUsed: false,
        });
        const badgeEl = facebook.injectIndicator(textNode, scanningEl) || scanningEl;

        if (!parsedToken) {
          // Token found but format not recognised — leave as SCANNING for now.
          console.debug('[SSD:fb] unrecognised token format, badged but not verified');
          commit();
          continue;
        }

        console.debug('[SSD:fb] rawPostText length:', rawPostText.length, 'preview:', rawPostText.slice(0, 80).replace(/\n/g, '↵'));
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
        console.debug('[SSD:fb] verify result:', result.state, 'hash8:', result.hash8);
        result._rawPostText = rawPostText;
        badge.update(badgeEl, result);
        commit();
      }
    } finally {
      scanning = false;
    }
  }

  keyring.load().then(() => {
    facebook.observe(onNewContent);
  });

  window.addEventListener('unload', () => facebook.cleanup());
})();

if (typeof module !== 'undefined' && module.exports) module.exports = facebook;
