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

  injectIndicator(anchorNode, badgeElement) {
    // Walk up to a semantic post container if one exists above the anchor.
    const parent = anchorNode.parentElement || anchorNode.parentNode;
    const container =
      (parent && parent.closest && parent.closest('[role="article"]')) ||
      (parent && parent.closest && parent.closest('[role="main"]')) ||
      parent;

    if (!container) return;

    // Guard: don't inject twice into the same container.
    if (container.querySelector && container.querySelector('.ssd-indicator')) return;

    if (container.style) container.style.position = 'relative';
    container.appendChild(badgeElement);
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

  // ── Compose side — STUBBED, implemented in Prompt 2 ──────────────────────────
  composeObserve(_onCompose) {
    // TODO Prompt 2: watch for Facebook compose boxes and call onCompose(el).
  },
  injectSignButton(_composeElement) {
    // TODO Prompt 2: inject the [Sign] button into the compose box.
  },
};

// ── Content-script bootstrap ───────────────────────────────────────────────────
// Orchestrates: scan → for each token, read post text, verify, inject badge.
// Lives here because this is the active platform module loaded last by the
// manifest; adding a new platform = a new file that runs its own bootstrap.

(function bootstrapFacebook() {
  if (!facebook.hostnames.includes(location.hostname)) return;

  // Read the post's raw text for a token's text node. The token's own context
  // is the nearest [role="article"]; we take that container's textContent so
  // canonicalisation sees exactly what the user sees (incl. "See more" text).
  function readPostText(textNode) {
    let el = textNode.parentElement;
    let container = null;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute('role') === 'article') { container = el; break; }
      el = el.parentElement;
    }
    if (!container) {
      // No article ancestor — fall back to the smallest ancestor that contains
      // enough text around the token to be meaningful.
      el = textNode.parentElement;
      while (el && el !== document.body) {
        if ((el.textContent || '').trim().length >= 20) { container = el; break; }
        el = el.parentElement;
      }
    }
    return (container ? container.textContent : textNode.textContent) || '';
  }

  let scanning = false;
  async function onNewContent() {
    if (scanning) return;
    scanning = true;
    try {
      const jobs = [];
      textScanner.scan((textNode, parsedToken) => {
        jobs.push({ textNode, parsedToken });
      });
      for (const { textNode, parsedToken } of jobs) {
        const rawPostText = readPostText(textNode);
        let result;
        try {
          result = await verifier.verify(parsedToken.raw, rawPostText);
        } catch (err) {
          console.error('[SSD] verify failed', err);
          continue;
        }
        result._rawPostText = rawPostText;
        const el = badge.create(result);
        facebook.injectIndicator(textNode, el);
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
