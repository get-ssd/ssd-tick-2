// analyser/panel.js
// On-page diagnostic panel. Collapsible, fixed bottom-right, screenshottable
// on mobile without devtools. init() is idempotent — safe to call multiple times.
//
// Depends on: CFG (loaded before this by manifest).

const analyserPanel = {
  _logEl: null,

  init() {
    if (document.getElementById('ssd-ap') || !CFG.analyser) return;

    const panel = document.createElement('div');
    panel.id = 'ssd-ap';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '12px', right: '12px', zIndex: '2147483647',
      background: '#0d0d1a', color: '#c8d0ff', font: '11px/1.5 monospace',
      border: '1px solid #3a3a6e', borderRadius: '6px', width: '440px',
      maxHeight: '520px', display: 'flex', flexDirection: 'column',
      boxShadow: '0 4px 24px rgba(0,0,0,0.85)',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '5px 10px', background: '#1a1a3a', borderRadius: '6px 6px 0 0',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      cursor: 'pointer', userSelect: 'none', flexShrink: '0',
    });
    header.innerHTML = '<strong>SSD Analyser v0.4</strong><span id="ssd-ap-t">&#9660;</span>';
    let open = true;
    header.addEventListener('click', () => {
      open = !open;
      body.style.display = open ? 'flex' : 'none';
      document.getElementById('ssd-ap-t').textContent = open ? '▾' : '▸';
    });

    const body = document.createElement('div');
    Object.assign(body.style, {
      padding: '6px 8px', overflowY: 'auto', flex: '1',
      display: 'flex', flexDirection: 'column', gap: '4px',
    });

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;flex-shrink:0;margin-bottom:4px';
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      Object.assign(b.style, {
        font: '10px monospace', background: '#2a2a5e', color: '#ddf',
        border: '1px solid #5a5a9a', borderRadius: '3px',
        padding: '2px 8px', cursor: 'pointer',
      });
      b.addEventListener('click', fn);
      return b;
    };
    btns.append(
      mkBtn('Clear',  () => { if (this._logEl) this._logEl.textContent = ''; }),
      mkBtn('Export', () => this._export()),
      mkBtn('Bust cache', () => {
        try { localStorage.removeItem('ssd-analyser-cache:' + location.hostname); } catch {}
        this.appendLine('[cache busted for ' + location.hostname + ']');
      }),
    );
    body.appendChild(btns);

    this._logEl = document.createElement('pre');
    Object.assign(this._logEl.style, {
      margin: '0', font: '10px/1.3 monospace', whiteSpace: 'pre-wrap',
      overflowY: 'auto', flex: '1', maxHeight: '380px',
      background: '#07071a', padding: '5px', borderRadius: '3px',
    });
    this._logEl.textContent = '[SSD Analyser ready — ' + location.hostname + ']\n';
    body.appendChild(this._logEl);

    panel.append(header, body);
    document.body.appendChild(panel);
  },

  appendLine(text) {
    if (!this._logEl) return;
    this._logEl.textContent += text + '\n';
    this._logEl.scrollTop = this._logEl.scrollHeight;
  },

  _export() {
    const text = this._logEl ? this._logEl.textContent : '';
    const blob = new Blob([text], { type: 'text/plain' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'ssd-analyser-' + location.hostname + '-' + Date.now() + '.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = analyserPanel;
