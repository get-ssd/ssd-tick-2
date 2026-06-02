// ui/badge.js
// The verification indicator element. Appearance is driven entirely by the
// verification result's `state`. Clicking/tapping the badge opens the detail
// popup (ui/popup.js).

const badge = {

  // state → { colour, icon, label(result) }
  STATES: {
    SCANNING:          { colour: '#888888', icon: '…', label: () => 'Signed post' },
    VALID:             { colour: '#4caf77', icon: '✓', label: r => r.signerName || 'Verified' },
    VALID_UNKNOWN:     { colour: '#e8a020', icon: '?', label: () => 'Unknown signer' },
    MISMATCH:          { colour: '#e05050', icon: '✗', label: () => 'Content modified' },
    INVALID:           { colour: '#e05050', icon: '✗', label: () => 'Invalid signature' },
    TRUNCATED:         { colour: '#666666', icon: '~', label: () => 'Post cut off' },
    VAULT_UNREACHABLE: { colour: '#666666', icon: '~', label: () => 'Vault unreachable' },
    KEY_UNREACHABLE:   { colour: '#888888', icon: '🔑', label: r => 'Signed — ' + (r.keyHint || 'key not loaded') },
    EXPIRED:           { colour: '#e8a020', icon: '⚠', label: () => 'Key expired' },
    REVOKED:           { colour: '#e05050', icon: '✗', label: () => 'Key revoked' },
  },

  // Create a badge element for a verification result. Returns the element.
  create(result) {
    const spec = this.STATES[result.state] || this.STATES.INVALID;

    const el = document.createElement('span');
    el.className = 'ssd-indicator';
    el.dataset.ssdState = result.state;
    el.style.setProperty('--ssd-colour', spec.colour);
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `SSD: ${spec.label(result)}`);
    el.title = `SSD — ${spec.label(result)} (click for details)`;
    el._ssdResult = result;

    const seal = document.createElement('span');
    seal.className = 'ssd-indicator-seal';
    seal.textContent = spec.icon;

    const label = document.createElement('span');
    label.className = 'ssd-indicator-label';
    label.textContent = spec.label(result);

    el.appendChild(seal);
    el.appendChild(label);

    const open = (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (typeof verificationPopup !== 'undefined') {
        verificationPopup.show(el, el._ssdResult);
      }
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') open(e);
    });

    return el;
  },

  // Update an existing badge element in place with a new result.
  update(el, result) {
    const spec = this.STATES[result.state] || this.STATES.INVALID;
    el.dataset.ssdState = result.state;
    el.style.setProperty('--ssd-colour', spec.colour);
    el.setAttribute('aria-label', `SSD: ${spec.label(result)}`);
    el.title = `SSD — ${spec.label(result)} (click for details)`;
    el._ssdResult = result;
    const seal = el.querySelector('.ssd-indicator-seal');
    if (seal) seal.textContent = spec.icon;
    const label = el.querySelector('.ssd-indicator-label');
    if (label) label.textContent = spec.label(result);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = badge;
