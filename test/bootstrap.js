// test/bootstrap.js — minimal content-script bootstrap for local test pages.
// Mimics the scanning + badge injection that platforms/facebook.js does, without
// the Facebook hostname guard. Only loaded on localhost (see manifest.json).

(function bootstrapTest() {
  console.log('[SSD] test bootstrap loaded on', location.href);

  async function onNewContent() {
    console.log('[SSD] scanning for tokens…');
    const jobs = [];
    textScanner.scan((textNode, parsedToken) => {
      jobs.push({ textNode, parsedToken });
    });
    for (const { textNode, parsedToken } of jobs) {
      let el = textNode.parentElement;
      let container = null;
      while (el && el !== document.body) {
        if (el.getAttribute && el.getAttribute('role') === 'article') { container = el; break; }
        el = el.parentElement;
      }
      if (!container) container = textNode.parentElement;
      const rawPostText = (container || textNode.parentElement || document.body).textContent;
      try {
        const result = await verifier.verify(parsedToken.raw, rawPostText);
        const badgeEl = badge.create(result);
        const target = container || textNode.parentElement;
        if (target) {
          target.style.position = 'relative';
          if (!target.querySelector('.ssd-indicator')) target.appendChild(badgeEl);
        }
      } catch (err) {
        console.error('[SSD] verify failed', err);
      }
    }
  }

  keyring.load().then(() => onNewContent());
})();
