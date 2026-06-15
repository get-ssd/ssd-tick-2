// core/sign-this-text.js
// "Sign this text" — captures the active compose field and hands it to the
// SSD signing flow. Loaded as a content script on all supported hosts.
//
// Entry point: { type: 'SSD_SIGN_THIS', source } message from background or popup.
//
// Depends on: cfg (declares `ext`), signer — both loaded before this.

// Chrome context-menu: track the element that was right-clicked.
// chrome.contextMenus provides no getTargetElement API; the content script
// records it from the contextmenu DOM event.
let _lastRightClicked = null;
document.addEventListener('contextmenu', e => {
  if (_isEditable(e.target)) _lastRightClicked = e.target;
});

function _isEditable(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const t = (el.type || '').toLowerCase();
    return !t || t === 'text' || t === 'search' || t === 'email' || t === 'url';
  }
  return false;
}

function _getFieldText(el) {
  if (!el) return '';
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
    ? el.value
    : (el.innerText || el.textContent || '');
}

// Gate 1 recommendation: activeElement first (correct when the compose field
// is still focused — bookmark-bar tap, toolbar button, context-menu click all
// preserve focus). Heuristic fallback covers address-bar invocation which blurs.
function _captureActiveField(source) {
  if (source === 'context-menu' && _lastRightClicked) {
    return { el: _lastRightClicked, text: _getFieldText(_lastRightClicked) };
  }
  const active = document.activeElement;
  if (active && _isEditable(active)) {
    return { el: active, text: _getFieldText(active) };
  }
  // Heuristic fallback: find the editable with the most content.
  const candidates = [
    ...document.querySelectorAll(
      'textarea, [contenteditable="true"], [contenteditable=""], input[type="text"], input:not([type])'
    ),
  ].filter(el => _getFieldText(el).trim().length > 0);
  if (candidates.length === 0) return { el: null, text: '' };
  candidates.sort((a, b) => _getFieldText(b).length - _getFieldText(a).length);
  const el = candidates[0];
  return { el, text: _getFieldText(el) };
}

// Append the SSD token as the final line, mirroring sign-button._appendToken.
function _appendToken(el, token) {
  const suffix = '\n\n' + token;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    document.execCommand('insertText', false, suffix);
  } else {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, suffix);
  }
}

// ── Notice toast ────────────────────────────────────────────────────────────

function _showNotice(message, state) {
  const el = document.createElement('div');
  el.className = 'ssd-sign-notice';
  el.dataset.state = state;
  el.textContent = message;
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
  return el;
}

function _updateNotice(el, message, state) {
  if (!el || !el.parentNode) return;
  el.textContent = message;
  el.dataset.state = state;
}

// ── Key picker (modal overlay) ──────────────────────────────────────────────

function _pickKey(keys) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'ssd-sign-overlay';

    const picker = document.createElement('div');
    picker.className = 'ssd-sign-key-picker';

    const title = document.createElement('div');
    title.className = 'ssd-sign-key-title';
    title.textContent = 'Choose a signing key';
    picker.appendChild(title);

    for (const k of keys) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ssd-key-picker-item';
      const label = (k.name || k.hash8).replace(/^[OD]:/, '');
      const hint  = k.identity || `fp:${k.hash8}`;
      btn.textContent = `${label} (${k.hash8}) — ${hint}`;
      btn.addEventListener('click', () => {
        overlay.remove();
        document.removeEventListener('keydown', onEsc, true);
        resolve(k.hash8);
      });
      picker.appendChild(btn);
    }

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ssd-sign-key-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      overlay.remove();
      document.removeEventListener('keydown', onEsc, true);
      resolve(null);
    });
    picker.appendChild(cancel);

    const onEsc = e => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onEsc, true);
        resolve(null);
      }
    };
    document.addEventListener('keydown', onEsc, true);

    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        overlay.remove();
        document.removeEventListener('keydown', onEsc, true);
        resolve(null);
      }
    });

    overlay.appendChild(picker);
    document.body.appendChild(overlay);
  });
}

// ── Main entry point ────────────────────────────────────────────────────────

async function signThisText(source) {
  const { el, text } = _captureActiveField(source);
  const rawText = text.replace(/\s*\[SSD:[^\]]+\]\s*$/, '').trim();

  if (!rawText) {
    const n = _showNotice(
      'No compose field found — tap the field you are composing in, then try again.',
      'warn'
    );
    setTimeout(() => n.remove(), 5000);
    return;
  }

  const keys = signer.signingKeys();
  if (keys.length === 0) {
    const n = _showNotice('No signing key — open SSD to set one up.', 'warn');
    setTimeout(() => n.remove(), 5000);
    return;
  }

  let hash8;
  if (keys.length === 1) {
    hash8 = keys[0].hash8;
  } else {
    hash8 = await _pickKey(keys);
    if (!hash8) return;
  }

  const notice = _showNotice('Signing…', 'info');
  try {
    // Gate 2 boundary: signer.sign() sends SSD_SIGN_REQUEST to the background.
    // Neither Chrome SW nor FF background has a handler for this yet — this will
    // throw. Capture and key-pick above are complete; handoff is the broken wire.
    const { token } = await signer.sign(rawText, hash8, source || 'sign-this-text');
    if (el) _appendToken(el, token);
    _updateNotice(notice, '✓ Signed', 'ok');
    setTimeout(() => notice.remove(), 3000);
  } catch (err) {
    _updateNotice(notice, `✗ ${err.message}`, 'error');
    setTimeout(() => notice.remove(), 5000);
  }
}

// ── Message listener (background / popup → content script) ─────────────────

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'SSD_SIGN_THIS') {
    signThisText(msg.source || 'extension').catch(console.error);
    sendResponse({ ok: true });
    return false;
  }
});
