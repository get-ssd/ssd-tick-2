// platforms/twitter.js
// Twitter/X platform module. PoC — lives on feature/twitter-poc for review
// before merge. See docs/PROMPT-Twitter-Plugin-v0_1.md (v0.2).
//
// Sig delivery differs from all other platforms: the [SSD:...] token is posted as
// an immediate self-reply, NOT inline in the tweet body. The tweet body is the
// signed content; the reply carries the machine-readable token. Both encode the
// same data — the card image QR is the human-readable path (future scope).
//
// Scan architecture: textScanner still finds all [SSD: text nodes. After each
// text node is located, we check whether it sits inside a self-reply article
// (reply-path) or inside the tweet body (inline-path, backwards compat).
//
//   reply-path:  token in reply article → body is in the preceding sibling
//                article from the same @handle → badge on parent tweet
//   inline-path: token in tweet body → standard walk-up readPostText → badge
//                near the token (same as facebook.js / reddit.js)
//
// Lazy-loading of replies: when a reply hasn't loaded yet, textScanner simply
// finds nothing. On the next MutationObserver cycle (when the reply loads),
// onNewContent() fires and textScanner finds the token. No explicit pending
// state is needed — MutationObserver provides the retry loop implicitly.

platforms.register('tw', {
  profileUrl:     handle => `https://twitter.com/${encodeURIComponent(handle)}`,
  label:          'Visit their Twitter/X profile to import key',
  nameFromHandle: handle => `@${handle}`,
});

platforms.register('x', {
  profileUrl:     handle => `https://x.com/${encodeURIComponent(handle)}`,
  label:          'Visit their X profile to import key',
  nameFromHandle: handle => `@${handle}`,
});

const twitter = {
  id: 'twitter',
  name: 'Twitter/X',
  // localhost/127.0.0.1: the socialmedia-mock server's X pages — the bootstrap
  // path guard restricts activation to /social-mock/x* there.
  hostnames: ['twitter.com', 'x.com', 'localhost', '127.0.0.1'],

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

  // For reply-path: anchorElement is the parent tweet article — inject near
  // its action bar so the badge reads as part of the tweet, not the reply.
  // For inline-path: anchorElement is the token's text node; same pattern as
  // facebook.js (append to the parent element).
  injectIndicator(anchorElement, badgeElement) {
    const container = anchorElement.nodeType === Node.ELEMENT_NODE
      ? anchorElement
      : (anchorElement.parentElement || anchorElement.parentNode);
    if (!container) { console.debug('[SSD:tw:inject] no container'); return null; }

    const existing = container.querySelector && container.querySelector('.ssd-indicator');
    if (existing) { console.debug('[SSD:tw:inject] returning existing badge'); return existing; }

    // Prefer injecting into the tweet's action toolbar (like/retweet/share row).
    try {
      const actionBar = container.querySelector('[role="group"]');
      if (actionBar) {
        actionBar.appendChild(badgeElement);
        console.debug('[SSD:tw:inject] badge injected into action bar');
        return badgeElement;
      }
    } catch { /* fall through to append */ }

    container.appendChild(badgeElement);
    console.debug('[SSD:tw:inject] badge appended to container:', container.nodeName);
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

  // Walk up from a node to the nearest tweet article element.
  findTweetArticle(node) {
    try {
      let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      while (el && el !== document.body) {
        if (el.nodeName === 'ARTICLE' && el.getAttribute('data-testid') === 'tweet') return el;
        el = el.parentElement;
      }
    } catch { }
    return null;
  },

  // Extract the @handle visible in the tweet header. Returns lowercase or null.
  // Twitter renders the handle as link text "@username" inside the article.
  getAuthorHandle(articleEl) {
    try {
      const links = articleEl.querySelectorAll('a[href^="/"]');
      for (const link of links) {
        const text = link.textContent.trim();
        // Match @handle: starts with @, no spaces, at least 2 chars total.
        if (text.startsWith('@') && text.length > 1 && !/\s/.test(text)) {
          return text.toLowerCase();
        }
      }
    } catch { }
    return null;
  },

  // Given the article that contains the reply token, find the parent tweet
  // article from the same @handle that appears before it in document order.
  // Returns the parent tweet article or null.
  findParentTweet(replyArticle) {
    try {
      const replyHandle = this.getAuthorHandle(replyArticle);
      if (!replyHandle) return null;

      // Strategy A: cellInnerDiv sibling walk — works on the home/profile timeline
      // where each tweet sits in its own cellInnerDiv at the same level.
      const replyCell = replyArticle.closest('[data-testid="cellInnerDiv"]');
      if (replyCell) {
        let prev = replyCell.previousElementSibling;
        for (let i = 0; i < 3 && prev; i++) {
          const article = prev.querySelector('article[data-testid="tweet"]')
                       || (prev.matches && prev.matches('article[data-testid="tweet"]') ? prev : null);
          if (article && this.getAuthorHandle(article) === replyHandle) return article;
          prev = prev.previousElementSibling;
        }
      }

      // Strategy B: document-order scan — works on tweet detail pages where the
      // original tweet and its replies sit in different container sections.
      // Return the last article from the same author that precedes the reply.
      const allArticles = document.querySelectorAll('article[data-testid="tweet"]');
      let lastMatch = null;
      for (const article of allArticles) {
        if (article === replyArticle) break;
        if (this.getAuthorHandle(article) === replyHandle) lastMatch = article;
      }
      return lastMatch;
    } catch { }
    return null;
  },

  // STUB: twitter.scanCardQR(tweetElement)
  // Future: extract QR from attached image, decode SSD token
  // For now: QR path not implemented — token from reply only
  scanCardQR(_tweetEl) {
    return null;
  },
};

// ── Content-script bootstrap ───────────────────────────────────────────────────

(function bootstrapTwitter() {
  if (!twitter.hostnames.includes(location.hostname)) return;
  // On localhost the manifest injects every platform module on /social-mock/*;
  // each module activates only on its own platform's paths.
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (isLocal && !location.pathname.startsWith('/social-mock/x')) return;

  // Extract the post body from a tweet article using Twitter's stable
  // data-testid="tweetText" attribute. Returns innerText or '' on failure.
  // Truncated tweets ("Show more"): use whatever is visible. If the text was
  // truncated at signing time, verification will produce INVALID — not a bug.
  // The MutationObserver will re-scan if the user expands the tweet.
  function extractTweetBody(articleEl) {
    try {
      const textEl = articleEl.querySelector('[data-testid="tweetText"]');
      return textEl ? textEl.innerText.trim() : '';
    } catch { }
    return '';
  }

  // Inline-path text extraction: walk up from the token text node until we
  // find a container that includes the token, then return the text before it.
  function readPostText(textNode, tokenRaw) {
    let el = textNode.parentElement;
    while (el && el !== document.body) {
      const text = el.innerText || '';
      const idx = text.lastIndexOf(tokenRaw);
      if (idx >= 10) {
        const pre = text.slice(0, idx).trim();
        console.debug('[SSD:tw:readPost]', el.nodeName, 'pre-token:', pre.length,
          '»', pre.slice(0, 60).replace(/\n/g, '↵'));
        return pre;
      }
      el = el.parentElement;
    }
    console.debug('[SSD:tw:readPost] no container found');
    return '';
  }

  // [SSDKEY:] beacon handler — three import states per SPEC-PROTO §5.7.
  const handleKeyBeacon = textScanner.makeBeaconHandler(
    (hash8) => {
      // socialmedia-mock serves profiles at /social-mock/x/<handle>; the mock's
      // fixtures sign with the x: identity prefix.
      const isMock   = location.pathname.startsWith('/social-mock/x');
      const pathname = isMock ? location.pathname.slice('/social-mock/x'.length) : location.pathname;
      const pathMatch = pathname.match(/^\/(@?[-\w]+)/);
      const urlHandle = pathMatch ? pathMatch[1].replace(/^@/, '') : null;
      const identity  = urlHandle ? `${isMock ? 'x' : 'tw'}:${urlHandle}` : null;
      const titleMatch = document.title.match(/\(@([-\w]+)\)/);
      const name = titleMatch ? `@${titleMatch[1]}`
                 : (urlHandle ? `@${urlHandle}` : hash8);
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
          if (!parsedToken) {
            jobs.push({ type: 'inline', textNode, parsedToken: null, commit, rawPostText: '' });
            return;
          }

          // Determine if this token is in a self-reply (reply-path) or in a
          // tweet body (inline-path). Reply-path: find the article containing
          // the token, then look for a preceding sibling article from the same
          // @handle — that is the signed tweet.
          const tokenArticle = twitter.findTweetArticle(textNode);
          if (tokenArticle) {
            const parentTweet = twitter.findParentTweet(tokenArticle);
            if (parentTweet) {
              // Reply-path: signed content is the parent tweet's body text.
              // The token string itself is NOT part of the signed content;
              // verifier.verify / canon handle rawPostText-without-token fine
              // (CANON-1 finds no [SSD: in the body and uses all of it).
              const bodyText = extractTweetBody(parentTweet);
              console.debug('[SSD:tw] reply-path, body preview:',
                bodyText.slice(0, 60).replace(/\n/g, '↵'));
              jobs.push({ type: 'reply', textNode, parsedToken, commit,
                          rawPostText: bodyText, badgeTarget: parentTweet });
              return;
            }
          }

          // Inline-path: token is in the tweet body itself.
          const rawPostText = readPostText(textNode, parsedToken.raw);
          jobs.push({ type: 'inline', textNode, parsedToken, commit, rawPostText });
        },
        handleKeyBeacon
      );

      console.debug('[SSD:tw] scan complete, jobs:', jobs.length);

      for (const { type, textNode, parsedToken, commit, rawPostText, badgeTarget } of jobs) {

        // Reply-path: badge goes on the parent tweet article.
        // Inline-path: badge goes near the token text node (standard pattern).
        const anchor = (type === 'reply' && badgeTarget) ? badgeTarget : textNode;

        const scanningEl = badge.create({
          state: 'SCANNING',
          hash8:    parsedToken ? parsedToken.hash8     : null,
          identity: parsedToken ? parsedToken.identity  : null,
          signerName: null, trustLevel: null,
          timestamp:   parsedToken ? parsedToken.timestamp   : null,
          isShort:     parsedToken ? parsedToken.isShort     : false,
          vaultUsed: false,
        });
        const badgeEl = twitter.injectIndicator(anchor, scanningEl) || scanningEl;

        if (!parsedToken) {
          console.debug('[SSD:tw] unrecognised token format');
          commit();
          continue;
        }

        console.debug('[SSD:tw]', type, 'rawPostText length:', rawPostText.length);

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

        console.debug('[SSD:tw] verify result:', result.state, 'hash8:', result.hash8);
        result._rawPostText = rawPostText;
        badge.update(badgeEl, result);
        commit();
        if (CFG.analyser && typeof analyser !== 'undefined') {
          analyser.analyse(textNode, parsedToken, rawPostText, 'twitter', result).catch(console.error);
        }
      }
    } finally {
      scanning = false;
    }
  }

  keyring.load().then(() => {
    if (CFG.analyser && typeof analyserPanel !== 'undefined') analyserPanel.init();
    twitter.observe(onNewContent);
  });

  window.addEventListener('unload', () => twitter.cleanup());
})();

if (typeof module !== 'undefined' && module.exports) module.exports = twitter;
