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
  hostnames: ['www.reddit.com', 'old.reddit.com'],

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
          if (out.length > 0 && !out.endsWith('\n')) out += '\n';
          if (!out.endsWith('\n\n')) out += '\n';
          out += inner;
          if (!out.endsWith('\n')) out += '\n';
          if (!out.endsWith('\n\n')) out += '\n';
        } else {
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

  function handleKeyDeclaration(hash8, value, anchorNode) {
    if (keyring.has(hash8)) return;

    const isUrl    = /^https?:\/\//.test(value);
    const isBase64 = /^[A-Za-z0-9_-]{43}$/.test(value);
    if (!isUrl && !isBase64) return;

    const parent = anchorNode.parentElement || anchorNode.parentNode;
    if (!parent) return;
    if (parent.querySelector && parent.querySelector('.ssd-trust-btn[data-hash8="' + hash8 + '"]')) return;

    const btn = document.createElement('button');
    btn.className = 'ssd-trust-btn ssd-indicator';
    btn.dataset.hash8 = hash8;
    btn.dataset.ssdState = 'KEY_DECLARATION';
    btn.setAttribute('title', `SSD key declaration — click to trust this signer (${hash8})`);
    btn.textContent = '🔑 Trust key';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = 'Importing…';
      try {
        if (isUrl) {
          await chrome.runtime.sendMessage({ type: 'resolveKey', hash8, identity: `url:${value}` });
          await keyring.load();
        } else {
          // Identity hint from URL: reddit.com/user/{handle} or /u/{handle} → rd:{handle}.
          const pathMatch  = location.pathname.match(/^\/(?:user|u)\/([-\w]+)/i);
          const urlHandle  = pathMatch ? pathMatch[1] : null;
          const identity   = urlHandle ? `rd:${urlHandle}` : null;
          // Name from page title: "u/username - Reddit" (new) or "overview for username" (old).
          const title       = document.title;
          const uSlash      = title.match(/\bu\/([-\w]+)/i);
          const overviewFor = title.match(/overview\s+for\s+([-\w]+)/i);
          const titleName   = uSlash ? `u/${uSlash[1]}` : overviewFor ? `u/${overviewFor[1]}` : '';
          const h1Name      = document.querySelector('h1')?.innerText?.trim() || '';
          const name        = titleName || h1Name || hash8;
          await keyring.put({
            hash8, name, identity, public_key: value,
            signing_algorithm: 'Ed25519',
            issued: null, expires: null, self_signed: null,
            imported_at: new Date().toISOString(),
            source: 'profile',
            vouched_by: null, bundle_name: null, credibility: null, vault: null, token_default: null,
          });
        }
        btn.textContent = '✓ Key trusted';
        btn.dataset.ssdState = 'VALID';
        onNewContent();
      } catch (err) {
        btn.textContent = '✗ Failed';
        btn.disabled = false;
        console.error('[SSD] key import failed', err);
      }
    });

    parent.style.position = 'relative';
    parent.appendChild(btn);
  }

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
        (hash8, value, textNode) => handleKeyDeclaration(hash8, value, textNode)
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
