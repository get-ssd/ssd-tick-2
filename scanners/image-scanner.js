// scanners/image-scanner.js
// STUB — Phase 2.
//
// TODO (Phase 2): scan <img> elements for QR codes that encode SSD payloads.
// For each decoded payload, locate the <img> and call callback(imgElement,
// parsedToken) — mirroring the text-scanner contract so the platform module can
// place a badge the same way. A QR decode library (loaded via CDN, no npm) will
// be needed; until then this is a no-op so the rest of the pipeline runs.

const imageScanner = {
  // Same callback signature as textScanner.scan: callback(anchorNode, parsedToken)
  scan(_callback) {
    // TODO Phase 2: decode QR codes from <img> elements. No-op for now.
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = imageScanner;
