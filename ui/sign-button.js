// ui/sign-button.js
// STUB — Prompt 2 (compose plugin).
//
// TODO (Prompt 2): build the [Sign] button injected into the platform compose
// box. On click it will: read the raw compose text, canonicalise it (core/canon),
// build the signed payload, call the PWA signing endpoint (or a local key),
// append the resulting —SSD·…— token to the compose box, and optionally submit
// to the vault for short-token use. It must never modify the user's text above
// the token — it appends only (CANON-Spec §11).

const signButton = {
  // Returns the [Sign] button element. No-op stub for now.
  create(_composeElement) {
    // TODO Prompt 2: construct and wire the Sign button.
    return null;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = signButton;
