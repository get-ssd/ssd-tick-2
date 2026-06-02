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

  // Inject badgeElement near the anchor node. Returns the badge that is in the
  // DOM — either the newly injected one, or an existing one from a prior scan.
  injectIndicator(anchorNode, badgeElement) {
    const parent = anchorNode.parentElement || anchorNode.parentNode;
    const container =
      (parent && parent.closest && parent.closest('[role="article"]')) ||
      (parent && parent.closest && parent.closest('[role="main"]')) ||
      parent;

    console.debug('[SSD:inject] container:', container ? container.nodeName : null, container ? container.getAttribute && container.getAttribute('role') : null);
    if (!container) { console.debug('[SSD:inject] no container — bailing'); return null; }

    const existing = container.querySelector && container.querySelector('.ssd-indicator');
    if (existing) {
      console.debug('[SSD:inject] returning existing .ssd-indicator');
      return existing;
    }

    if (container.style) container.style.position = 'relative';
    container.appendChild(badgeElement);
    console.debug('[SSD:inject] badge appended, state:', badgeElement.dataset.ssdState);
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

  // ── Compose side ──────────────────────────────────────────────────────────────

  _composeObserver: null,
  _seenCompose: null, // WeakSet of already-handled compose elements

  // Aria-label substrings that identify Facebook compose textboxes.
  // Facebook uses the user's locale — these cover en-US; add more as needed.
  COMPOSE_LABELS: ["what's on your mind", "write something", "create a post"],

  // Watch for compose boxes appearing. Calls onCompose(element) once per element.
  //
  // Primary: MutationObserver watching for [role="textbox"] whose aria-label
  // matches a known compose phrase.
  //
  // Opt-in fallback (Prompt 3+): the toolbar popup can send { type: 'SSD_SIGN_ACTIVE' }
  // to the content script to sign whatever element is currently focused — useful when
  // Facebook uses a compose surface this observer doesn't recognise.
  composeObserve(onCompose) {
    this._seenCompose = new WeakSet();
    const self = this;

    function check(node) {
      if (!node || node.nodeType !== 1) return;
      const candidates = [node];
      if (node.querySelectorAll) {
        node.querySelectorAll('[role="textbox"]').forEach(el => candidates.push(el));
      }
      for (const el of candidates) {
        if (el.getAttribute && el.getAttribute('role') !== 'textbox') continue;
        if (self._seenCompose.has(el)) continue;
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if (self.COMPOSE_LABELS.some(l => label.includes(l))) {
          self._seenCompose.add(el);
          onCompose(el);
        }
      }
    }

    // Check whatever is already in the DOM.
    check(document.body);

    // Watch for new nodes.
    this._composeObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) check(node);
      }
    });
    this._composeObserver.observe(document.body, { childList: true, subtree: true });
  },

  // Inject the [Sign] button into the compose box's action bar.
  // Guards against double injection; cleans up when the compose box leaves the DOM.
  injectSignButton(composeElement) {
    if (composeElement._ssdSignBtn) return;

    const btn = signButton.create(composeElement, 'facebook');
    if (!btn) return;

    composeElement._ssdSignBtn = btn;
    btn.classList.add('ssd-sign-btn--fb');

    // Prefer the "Add to your post" action bar; fall back to sibling of compose el.
    const modal = composeElement.closest('[role="dialog"]') || composeElement.parentElement;
    const actionBar = modal && modal.querySelector('[aria-label="Add to your post"]');
    if (actionBar) {
      actionBar.appendChild(btn);
    } else {
      composeElement.insertAdjacentElement('afterend', btn);
    }

    // Remove button when the compose element leaves the DOM.
    const cleanup = new MutationObserver(() => {
      if (!document.contains(composeElement)) {
        btn.remove();
        delete composeElement._ssdSignBtn;
        cleanup.disconnect();
      }
    });
    cleanup.observe(document.body, { childList: true, subtree: true });
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
    const tokenText = textNode.textContent;
    console.debug('[SSD:readPost] token text length:', tokenText.length);

    // Walk up from the token's text node. At each level log what we see.
    // The post body lives in sibling elements — so the first ancestor whose
    // textContent is meaningfully longer than the token alone is the container
    // that holds both the post text and the token.
    let el = textNode.parentElement;
    let container = null;
    let level = 0;
    while (el && el !== document.body) {
      const full = el.textContent || '';
      const nonToken = full.length - tokenText.length;
      console.debug('[SSD:readPost] L' + level, el.nodeName,
        el.getAttribute && el.getAttribute('role') ? 'role=' + el.getAttribute('role') : '',
        'full:', full.length, 'non-token:', nonToken,
        'sample:', full.slice(0, 80).replace(/\n/g, '↵'));
      if (nonToken >= 20) {
        container = el;
        console.debug('[SSD:readPost] → container found at L' + level);
        break;
      }
      el = el.parentElement;
      level++;
    }

    if (!container) {
      console.debug('[SSD:readPost] no container found — falling back to textNode.textContent');
    }
    const result = (container ? container.textContent : tokenText) || '';
    console.debug('[SSD:readPost] result:', result.length, 'chars, preview:', result.slice(0, 120).replace(/\n/g, '↵'));
    return result;
  }

  // Handle a 3-field key declaration token: —SSD·{fingerprint}·{value}—
  // value is either a 44-char base64 raw Ed25519 public key or an https:// URL.
  // Injects a trust badge near the declaration — key is only imported on click.
  function handleKeyDeclaration(fingerprint, value, anchorNode) {
    if (keyring.has(fingerprint)) return;

    const isUrl    = /^https?:\/\//.test(value);
    const isBase64 = /^[A-Za-z0-9+/]{43}=$/.test(value);
    if (!isUrl && !isBase64) return;

    // Find a container to anchor the badge to.
    const parent = anchorNode.parentElement || anchorNode.parentNode;
    if (!parent) return;
    if (parent.querySelector && parent.querySelector('.ssd-trust-btn[data-fp="' + fingerprint + '"]')) return;

    const btn = document.createElement('button');
    btn.className = 'ssd-trust-btn ssd-indicator';
    btn.dataset.fp = fingerprint;
    btn.dataset.ssdState = 'KEY_DECLARATION';
    btn.setAttribute('title', `SSD key declaration — click to trust this signer (${fingerprint})`);
    btn.textContent = '🔑 Trust key';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = 'Importing…';
      try {
        if (isUrl) {
          await chrome.runtime.sendMessage({ type: 'resolveKey', fingerprint, keyHint: `url:${value}` });
          await keyring.load();
        } else {
          const title = document.title.split('|');
          const name  = (title.length >= 2 && title[0].trim()) ? title[0].trim() : fingerprint;
          await keyring.put({
            fingerprint, name, public_key: value,
            signing_algorithm: 'Ed25519',
            issued: null, expires: null, self_signed: null,
            imported_at: new Date().toISOString(),
            source: 'profile',
            vouched_by: null, bundle_name: null, credibility: null, vault: null, token_default: null,
          });
        }
        btn.textContent = '✓ Key trusted';
        btn.dataset.ssdState = 'VALID';
        // Re-scan so any signed posts on the page now verify green.
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
        (textNode, parsedToken, commit) => { jobs.push({ textNode, parsedToken, commit }); },
        (fingerprint, value, textNode) => handleKeyDeclaration(fingerprint, value, textNode)
      );
      console.debug('[SSD:fb] scan complete, jobs:', jobs.length);
      for (const { textNode, parsedToken, commit } of jobs) {
        // Inject a SCANNING badge immediately so the user sees it straight away.
        const scanningEl = badge.create({
          state: 'SCANNING', fingerprint: parsedToken.fingerprint,
          keyHint: parsedToken.keyHint, signerName: null, trustLevel: null,
          timestamp: parsedToken.timestamp, isShort: parsedToken.isShort, vaultUsed: false,
        });
        const badgeEl = facebook.injectIndicator(textNode, scanningEl) || scanningEl;

        const rawPostText = readPostText(textNode);
        console.debug('[SSD:fb] rawPostText length:', rawPostText.length, 'preview:', rawPostText.slice(0, 80).replace(/\n/g, '↵'));
        let result;
        try {
          result = await verifier.verify(parsedToken.raw, rawPostText);
        } catch (err) {
          console.error('[SSD] verify failed', err);
          result = {
            state: 'INVALID', fingerprint: parsedToken.fingerprint,
            keyHint: parsedToken.keyHint, signerName: null, trustLevel: null,
            timestamp: parsedToken.timestamp, isShort: false, vaultUsed: false,
          };
        }
        console.debug('[SSD:fb] verify result:', result.state, 'fp:', result.fingerprint);
        result._rawPostText = rawPostText;
        badge.update(badgeEl, result);
        if (result.state !== 'TRUNCATED') commit();
      }
    } finally {
      scanning = false;
    }
  }

  keyring.load().then(() => {
    facebook.observe(onNewContent);

    // ── Compose side bootstrap ───────────────────────────────────────────────
    facebook.composeObserve(el => facebook.injectSignButton(el));

    // Opt-in: toolbar popup sends { type: 'SSD_SIGN_ACTIVE' } to sign whatever
    // is currently focused — handles compose surfaces the observer misses.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'SSD_SIGN_ACTIVE') {
        const el = document.activeElement;
        if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT' &&
            el.getAttribute('role') !== 'textbox')) {
          return;
        }
        // Treat as a compose element we haven't seen before.
        if (!el._ssdSignBtn) {
          facebook.injectSignButton(el);
        }
        // Trigger sign flow immediately.
        if (el._ssdSignBtn) el._ssdSignBtn.click();
      }
    });
  });

  window.addEventListener('unload', () => facebook.cleanup());
})();

if (typeof module !== 'undefined' && module.exports) module.exports = facebook;
