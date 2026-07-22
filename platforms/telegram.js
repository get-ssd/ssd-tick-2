// platforms/telegram.js
// Telegram platform module (verification side). Mirrors the reddit/facebook
// contract: observe() re-runs the scanners, injectIndicator() places a badge,
// cleanup() disconnects. Text extraction treats <div dir="auto"> as a soft
// line-break (single \n), matching how Telegram renders message lines.
//
// Target DOM (t.me/s/<channel> public preview, and the socialmedia-mock):
//   - message text: <div class="tgme_widget_message_text"> with one
//     <div dir="auto"> per line, token as the last line
//   - channel description carries an [SSDKEY:hash8:pubkey] beacon

platforms.register('tg', {
  profileUrl:     handle => `https://t.me/${encodeURIComponent(handle)}`,
  label:          'Visit their Telegram channel to import key',
  nameFromHandle: handle => `@${handle}`,
});

const telegram = {
  id: 'telegram',
  name: 'Telegram',
  // localhost/127.0.0.1: the socialmedia-mock server's Telegram pages — the
  // manifest only injects this file on /social-mock/telegram* paths there.
  hostnames: ['t.me', 'web.telegram.org', 'localhost', '127.0.0.1'],

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

(function bootstrapTelegram() {
  if (!telegram.hostnames.includes(location.hostname)) return;

  const BLOCK_TAGS = new Set([
    'ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DD','DIV','DL','DT',
    'FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM',
    'H1','H2','H3','H4','H5','H6',
    'HEADER','HGROUP','LI','MAIN','NAV','OL','P',
    'PRE','SECTION','SUMMARY','TABLE','TD','TH','TR','UL',
  ]);

  // <div dir="..."> is a line-level break (single \n); other blocks are
  // paragraph-level (double \n). Matches Telegram's per-line message markup.
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

  const handleKeyBeacon = textScanner.makeBeaconHandler(
    (hash8) => {
      // socialmedia-mock: /social-mock/telegram/<channel>[/<id>];
      // real: t.me/<channel> or t.me/s/<channel>.
      const m = location.pathname.match(/\/telegram\/([-\w]+)/i)
             || location.pathname.match(/\/s\/([-\w]+)/i)
             || location.pathname.match(/^\/([-\w]+)/);
      const urlHandle = m ? m[1] : null;
      const identity  = urlHandle ? `tg:${urlHandle}` : null;
      const atName    = (document.querySelector('.tgme_channel_info_header_username, .tg-channel-username')?.innerText || '').trim();
      const h1Name    = document.querySelector('h1, .tgme_channel_info_header_title, .tg-channel-title')?.innerText?.trim() || '';
      const name = (urlHandle ? `@${urlHandle}` : '') || atName || h1Name || hash8;
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
      console.debug('[SSD:tg] scan complete, jobs:', jobs.length);
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
        const badgeEl = telegram.injectIndicator(textNode, scanningEl) || scanningEl;

        if (!parsedToken) { commit(); continue; }

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
        console.debug('[SSD:tg] verify result:', result.state, 'hash8:', result.hash8);
        result._rawPostText = rawPostText;
        badge.update(badgeEl, result);
        commit();
      }
    } finally {
      scanning = false;
    }
  }

  keyring.load().then(() => {
    telegram.observe(onNewContent);
  });

  window.addEventListener('unload', () => telegram.cleanup());
})();

if (typeof module !== 'undefined' && module.exports) module.exports = telegram;
