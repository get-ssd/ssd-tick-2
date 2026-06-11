// core/cfg.js
// Global config for the SSD extension. Loaded first by all content_scripts
// entries so every module can read CFG at load time.
//
// To enable the diagnostic analyser: set CFG.analyser = true here, or toggle
// it at runtime from devtools: CFG.analyser = true; then reload the page.

const CFG = {
  analyser:             false,
  analyserCollectorUrl: 'http://localhost:8099/log',
  maxAncestorDepth:     6,
  maxSuffixBlocks:      10,
};

if (typeof module !== 'undefined' && module.exports) module.exports = CFG;
