// ui/popup.js
// The in-page verification detail panel. Shown when the badge is clicked.
// Renders the full verification result. This is NOT the toolbar popup (that is
// popup/popup.js, the key manager).

const verificationPopup = {

  _el: null,

  esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _trustLabel(level) {
    switch (level) {
      case 'self': return 'Your own key';
      case 'peer': return 'Peer contact';
      case 'bundle': return 'Vouched contact';
      case 'unverified': return 'Unverified';
      default: return 'Unknown';
    }
  },

  _fmtTimestamp(ts) {
    if (!ts) return '—';
    // 2026-05-30T14:17Z → 2026-05-30 14:17 UTC
    const m = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return m ? `${m[1]} ${m[2]} UTC` : ts;
  },

  remove() {
    if (this._el) { this._el.remove(); this._el = null; }
  },

  // Build the status lines / warning block for the result state.
  _statusHtml(result) {
    switch (result.state) {
      case 'VALID':
        return `
          <div class="ssd-pop-line ok">✓ Signature valid</div>
          <div class="ssd-pop-line ok">✓ Content unmodified</div>`;
      case 'VALID_UNKNOWN': {
        const url    = platforms.hintUrl(result.keyHint);
        const action = platforms.hintLabel(result.keyHint);
        return `
          <div class="ssd-pop-line ok">✓ Signature valid</div>
          <div class="ssd-pop-line ok">✓ Content unmodified</div>
          <div class="ssd-pop-warn neutral" style="margin-top:6px">
            <strong>Signer not in your contacts</strong>
            ${url ? `<div style="margin-top:4px"><a href="${this.esc(url)}" target="_blank" rel="noopener" class="ssd-pop-link">${this.esc(action)}</a></div>` : ''}
          </div>`;
      }
      case 'MISMATCH':
        return `
          <div class="ssd-pop-warn danger">
            <strong>⚠ Content was modified after signing</strong>
            <div>The text no longer matches the original signature.
            This may indicate tampering.</div>
          </div>`;
      case 'INVALID':
        return `<div class="ssd-pop-line bad">✗ Signature does not verify</div>`;
      case 'TRUNCATED':
        return `
          <div class="ssd-pop-warn neutral">
            <strong>~ Post may be cut off</strong>
            <div>The visible post text is too short to verify.
            View the full post then reload the page to verify.</div>
          </div>`;
      case 'VAULT_UNREACHABLE':
        return `
          <div class="ssd-pop-warn neutral">
            <strong>~ Vault unreachable</strong>
            <div>This post uses a short token. The vault needed to verify it
            could not be reached. The post cannot be verified at this time.</div>
          </div>`;
      case 'KEY_UNREACHABLE': {
        const url    = platforms.hintUrl(result.keyHint);
        const action = platforms.hintLabel(result.keyHint);
        return `
          <div class="ssd-pop-warn neutral">
            <strong>~ Signer's key not in your keyring</strong>
            ${url
              ? `<div style="margin-top:6px"><a href="${this.esc(url)}" target="_blank" rel="noopener" class="ssd-pop-link">${this.esc(action)}</a></div>
                 <div style="margin-top:4px;font-size:11px;opacity:.7">Look for the 🔑 Trust key button on their profile, then reload this page.</div>`
              : '<div>Import their key card to verify this post.</div>'
            }
          </div>`;
      }
      case 'EXPIRED':
        return `
          <div class="ssd-pop-line ok">✓ Signature valid</div>
          <div class="ssd-pop-warn warn">
            <strong>⚠ Key expired</strong>
            <div>The signature is valid but the signing key is past its
            declared expiry.</div>
          </div>`;
      case 'REVOKED':
        return `
          <div class="ssd-pop-warn danger">
            <strong>✗ Key revoked</strong>
            <div>The signer's key has been revoked and should no longer be
            trusted.</div>
          </div>`;
      default:
        return '';
    }
  },

  // Signer row: label + value, varies by whether the key is resolved.
  _signerRow(result) {
    if (result.signerName) {
      // Key is known — show confirmed name.
      return `<div class="ssd-popup-row"><span>Signer</span><span>${this.esc(result.signerName)}</span></div>`;
    }
    if (result.keyHint) {
      // Key hint present but key not in keyring — show hint as a claim, not a fact.
      return `<div class="ssd-popup-row"><span>Hint</span><span style="color:#888;font-style:italic">${this.esc(result.keyHint)}</span></div>`;
    }
    return '';
  },

  // Show the popup anchored to the badge element.
  async show(anchorEl, result) {
    this.remove();

    const stored = await chrome.storage.local.get('pwaUrl');
    const pwaUrl = stored.pwaUrl ? stored.pwaUrl.replace(/\/+$/, '') : null;

    const rect = anchorEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'ssd-popup';
    el.dataset.ssdState = result.state;

    const showDetail = !['TRUNCATED', 'VAULT_UNREACHABLE', 'KEY_UNREACHABLE', 'INVALID'].includes(result.state)
      || result.state === 'EXPIRED';

    const vaultLine = result.isShort
      ? (result.vaultUsed ? 'Public (used)' : 'Short token')
      : 'Not used';

    el.innerHTML = `
      <div class="ssd-popup-status">${this._statusHtml(result)}</div>
      ${showDetail || result.fingerprint ? `
      <div class="ssd-popup-detail">
        <div class="ssd-popup-row"><span>Signed</span><span>${this.esc(this._fmtTimestamp(result.timestamp))}</span></div>
        ${this._signerRow(result)}
        <div class="ssd-popup-row"><span>Key</span><span class="ssd-mono">${this.esc(result.fingerprint || '—')}</span></div>
        ${showDetail ? `
        <div class="ssd-popup-row"><span>Trust</span><span>${this.esc(this._trustLabel(result.trustLevel))}</span></div>
        <div class="ssd-popup-row"><span>Vault</span><span>${this.esc(vaultLine)}</span></div>` : ''}
      </div>` : ''}
      <div class="ssd-popup-actions">
        <button class="ssd-popup-btn" data-act="canonical">View canonical text</button>
        ${pwaUrl ? `<button class="ssd-popup-btn" data-act="open">Open in SSD</button>` : ''}
      </div>
    `;

    // Position: fixed, below the badge, clamped to viewport.
    const top = rect.bottom + 6;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 308));
    el.style.position = 'fixed';
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;

    document.body.appendChild(el);
    this._el = el;

    el.querySelector('[data-act="canonical"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this._showCanonical(el, result);
    });
    el.querySelector('[data-act="open"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(pwaUrl, '_blank');
    });

    // Keep clicks inside the popup from closing it.
    el.addEventListener('click', (e) => e.stopPropagation());

    // Dismiss on outside click/tap.
    setTimeout(() => {
      const close = () => this.remove();
      document.addEventListener('click', close, { once: true });
      document.addEventListener('touchend', close, { once: true });
    }, 0);
  },

  async _showCanonical(el, result) {
    const detail = el.querySelector('.ssd-popup-detail');
    const raw = result._rawPostText || '';
    let text = raw;
    try {
      if (typeof canon !== 'undefined' && raw) {
        text = (await canon.canonicalise(raw)).canonicalText;
      }
    } catch { /* show raw */ }
    const block = document.createElement('pre');
    block.className = 'ssd-popup-canonical';
    block.textContent = text || '(no text available)';
    if (detail) detail.after(block); else el.appendChild(block);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = verificationPopup;
