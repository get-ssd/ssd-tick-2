// SSD Sign — bookmarklet source (primary mobile surface)
//
// Install: create a new browser bookmark, paste the javascript: URL below as
// the address. On mobile, add it to your bookmarks bar so a single tap invokes
// it while the compose field is still focused.
//
// Replace PWA_URL with the address of your SSD app if it differs from the
// default. The http://localhost:8080 default works for local dev.
//
// Gate 2 note: this bookmarklet opens sign.html with ?action=sign&text=...
// The PWA's sign.html does not yet handle the action=sign parameter — it
// currently expects a pre-built signed_payload from the extension. That wiring
// is the pending work flagged in the session report; the bookmarklet is built
// to the handoff boundary.
//
// ── javascript: URL (copy this into the bookmark's address field) ──────────
//
// javascript:(function(){var PWA_URL='http://localhost:8080';function isEditable(e){if(!e)return false;if(e.isContentEditable)return true;var t=e.tagName;if(t==='TEXTAREA')return true;if(t==='INPUT'){var tp=(e.type||'').toLowerCase();return !tp||tp==='text'||tp==='search'||tp==='email'||tp==='url';}return false;}function getText(e){if(!e)return'';return e.tagName==='TEXTAREA'||e.tagName==='INPUT'?e.value:(e.innerText||e.textContent||'');}var text='';var active=document.activeElement;if(isEditable(active)){text=getText(active);}else{var cands=Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""],input[type="text"],input:not([type])')).filter(function(e){return getText(e).trim().length>0;});if(cands.length>0){cands.sort(function(a,b){return getText(b).length-getText(a).length;});text=getText(cands[0]);}}text=text.replace(/\s*\[SSD:[^\]]+\]\s*$/,'').trim();if(!text){alert('SSD Sign: No compose field found.\nTap the field you are composing in, then try again.');return;}window.open(PWA_URL+'/sign.html?action=sign&context=bookmarklet&text='+encodeURIComponent(text),'_blank');})();
//
// ── Readable source ────────────────────────────────────────────────────────

javascript: (function () {
  // Replace with your SSD PWA address.
  var PWA_URL = 'http://localhost:8080';

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      var t = (el.type || '').toLowerCase();
      return !t || t === 'text' || t === 'search' || t === 'email' || t === 'url';
    }
    return false;
  }

  function getText(el) {
    if (!el) return '';
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
      ? el.value
      : (el.innerText || el.textContent || '');
  }

  // Gate 1: activeElement first (correct for bookmark-bar tap, which preserves
  // field focus). Heuristic fallback for address-bar keyword invocation (blurs).
  var text = '';
  var active = document.activeElement;
  if (isEditable(active)) {
    text = getText(active);
  } else {
    var candidates = Array.from(
      document.querySelectorAll(
        'textarea, [contenteditable="true"], [contenteditable=""], input[type="text"], input:not([type])'
      )
    ).filter(function (el) { return getText(el).trim().length > 0; });
    if (candidates.length > 0) {
      candidates.sort(function (a, b) { return getText(b).length - getText(a).length; });
      text = getText(candidates[0]);
    }
  }

  // Strip any existing SSD token before signing.
  text = text.replace(/\s*\[SSD:[^\]]+\]\s*$/, '').trim();

  if (!text) {
    alert(
      'SSD Sign: No compose field found.\n' +
      'Tap the field you are composing in, then try again.'
    );
    return;
  }

  // Gate 2 handoff — opens sign.html with the raw text in URL params.
  // sign.html does not yet handle ?action=sign&text=... — wiring pending.
  var url = PWA_URL + '/sign.html?action=sign&context=bookmarklet&text=' +
    encodeURIComponent(text);
  window.open(url, '_blank');
})();
