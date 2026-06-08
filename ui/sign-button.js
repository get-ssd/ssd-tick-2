// ui/sign-button.js
// [Sign] button injected into platform compose boxes.
//
// Depends on: signer, keyring (loaded before this in the manifest).
// Platform files call signButton.create(composeEl, platform) and append the
// returned element wherever they see fit.

const signButton = {

  // Create the [Sign] button wired to the given compose element.
  // Returns the button element, or null if no signing keys are configured.
  create(composeElement, platform) {
    const btn = document.createElement('button');
    btn.className = 'ssd-sign-btn';
    btn.setAttribute('type', 'button');
    btn.setAttribute('title', 'Sign this post with SSD');
    this._setState(btn, 'default');

    btn.addEventListener('click', async () => {
      const currentState = btn.dataset.ssdState;

      // Signed → clicking again removes the token and resets.
      if (currentState === 'signed') {
        this._removeToken(composeElement);
        this._setState(btn, 'default');
        return;
      }

      // Error → retry.
      if (currentState === 'error') {
        this._setState(btn, 'default');
        return;
      }

      if (currentState !== 'default') return;

      await this._signingFlow(btn, composeElement, platform);
    });

    return btn;
  },

  async _signingFlow(btn, composeElement, platform) {
    // 1. Pick signing key.
    const keys = signer.signingKeys();
    if (keys.length === 0) {
      this._showMessage(btn, 'No signing key configured — open SSD to set one up');
      return;
    }

    let hash8;
    if (keys.length === 1) {
      hash8 = keys[0].hash8;
    } else {
      hash8 = await this._pickKey(btn, keys);
      if (!hash8) return; // user dismissed picker
    }

    // 2. Read raw compose text, strip any existing token.
    const rawWithToken = this._readCompose(composeElement);
    const rawText = rawWithToken.replace(/\s*\[SSD:[^\]]+\]\s*$/, '').trim();

    // 3. Sign.
    this._setState(btn, 'signing');
    try {
      const { token } = await signer.sign(rawText, hash8, platform);
      // 4. Inject token as final line with blank-line separator.
      this._appendToken(composeElement, token);
      this._setState(btn, 'signed');
    } catch (err) {
      console.error('[SSD] Signing failed:', err);
      this._setState(btn, 'error');
    }
  },

  // Show a floating key picker near the button; resolves to hash8 or null.
  _pickKey(btn, keys) {
    return new Promise(resolve => {
      const picker = document.createElement('div');
      picker.className = 'ssd-key-picker';

      for (const k of keys) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ssd-key-picker-item';
        const hint = k.identity || `fp:${k.hash8}`;
        const label = (k.name || k.hash8).replace(/^[OD]:/, '');
        item.textContent = `${label} (${k.hash8}) — ${hint}`;
        item.addEventListener('click', () => {
          picker.remove();
          resolve(k.hash8);
        });
        picker.appendChild(item);
      }

      // Dismiss on outside click.
      const dismiss = (e) => {
        if (!picker.contains(e.target) && e.target !== btn) {
          picker.remove();
          document.removeEventListener('click', dismiss, true);
          resolve(null);
        }
      };
      document.addEventListener('click', dismiss, true);

      // Position below the button.
      const rect = btn.getBoundingClientRect();
      picker.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:2147483647`;
      document.body.appendChild(picker);
    });
  },

  _setState(btn, state) {
    btn.dataset.ssdState = state;
    btn.disabled = (state === 'signing');
    const labels = {
      default: '🔏 Sign',
      signing: 'Signing…',
      signed:  '✓ Signed',
      error:   '✗ Failed',
    };
    btn.textContent = labels[state] || labels.default;
  },

  _showMessage(btn, msg) {
    btn.title = msg;
    this._setState(btn, 'error');
    setTimeout(() => { if (btn.dataset.ssdState === 'error') this._setState(btn, 'default'); }, 4000);
  },

  // Read the visible text of a compose element (contenteditable or textarea/input).
  _readCompose(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
    return el.innerText || el.textContent || '';
  },

  // Append the SSD token as the final line of the compose element, separated by
  // a blank line. Uses execCommand so React/Vue synthetic events fire correctly.
  _appendToken(el, token) {
    const suffix = '\n\n' + token;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      document.execCommand('insertText', false, suffix);
    } else {
      // contenteditable
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, suffix);
    }
  },

  // Remove the trailing [SSD:…] token from the compose element.
  _removeToken(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = el.value.replace(/\s*\[SSD:[^\]]+\]\s*$/, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const text = (el.innerText || el.textContent || '').replace(/\s*\[SSD:[^\]]+\]\s*$/, '');
      // Replace innerText via execCommand to keep React in sync.
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    }
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = signButton;
