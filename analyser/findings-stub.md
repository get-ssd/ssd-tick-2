# Analyser Run Findings

Run date: 2026-06-11
Extension build: 0.4.0
Collector NDJSON file: ssd-spike-1781192261498.ndjson (408 entries)
Platforms tested: www.facebook.com (profile page, alice.mock). m.facebook.com: BLOCKED — Chrome redirects unconditionally to www; extension never fired on mobile domain.

---

## Corpus results

| id | platform | expected | plugin showed | analyser state | match | strategy B | notes |
|----|----------|----------|---------------|----------------|-------|------------|-------|
| fb-www-valid        | fb-desktop | VALID    | VALID    | VALID    | ✓ | RECOVERED d2/s1/raw, 1 attempt (cache hit) | A match + Ed25519 A+B PASS |
| fb-www-mismatch     | fb-desktop | MISMATCH | MISMATCH | MISMATCH | ✓ | SEARCH_EXHAUSTED | Ed25519 A fails, disc heuristic sig-bytes=64→MISMATCH |
| fb-www-invalid      | fb-desktop | INVALID  | INVALID  | INVALID  | ✓ | RECOVERED (content match, sig corrupt) | atob error on truncated sig; bio character limit cut the token |
| fb-www-truncated    | fb-desktop | TRUNCATED | TRUNCATED | TRUNCATED | ✓ | n/a | First-scan lazy-render: preTokenLen=13 < threshold=20; process #2 got full text |
| fb-mobile-valid     | fb-mobile  | —        | —        | —        | — | — | BLOCKED: Chrome redirects m.facebook.com → www |
| fb-mobile-mismatch  | fb-mobile  | —        | —        | —        | — | — | BLOCKED: see above |

Strategy B column: RECOVERED / CACHE_STALE / SEARCH_EXHAUSTED / SELECTOR_EMPTY / n/a

---

## Strategy B cache behaviour

Cache key is `{depth, variantId}` (not `suffixCount`). On a cache hit, all suffixCounts at the cached depth × variantId are swept.

**Observed:** processN=1 (first scan): RECOVERED at d1/s2/raw, 5 attempts, cacheUsed=false. processN=2: RECOVERED at d1/s2/raw, 2 attempts, cacheUsed=true — confirmed cache hit, sweeping suffixCounts at d1/raw found the winner immediately. processN=3+: winner depth shifted to d2/s1 as the FB DOM re-rendered, cacheUsed=false (cache busted or no candidates at d1 after re-render) — full search ran, 1 attempt, d2/s1/raw.

**Conclusion:** Cache-key fix confirmed working. Depth-level instability across re-renders is real but the design handles it — stale cache falls through to full search, new winner found and saved.

---

## Re-fire events

processN reached 6 on the VALID post (fa9988e6) in a single session. Re-fires are more frequent than the "occasional" expectation — FB virtualisation / MutationObserver debounce triggers multiple re-scans as the page stabilises. Winner depth shifted between d1 and d2 across re-fires, confirming DOM instability across renders.

---

## MISMATCH/INVALID discrimination paths

**MISMATCH (fd214bae):** disc path = heuristic. `vault: no canonical_text`. sig-bytes=64 → verdict=MISMATCH. Vault-query path NOT exercised (vault always returned no canonical_text in this session).

**INVALID (truncated sig):** disc path = heuristic. sig decode error (atob on truncated base64) → decode-error → verdict=INVALID. Correct: FB bio character limit truncated the second token mid-signature.

---

## Strategy A canon divergences

None observed on clean posts. All nine CANON stages produced identical byte counts for the VALID post (no NFC change, no line-ending change, no trailing-whitespace change, no word-wrap needed). The only byte-count change was CANON-7 (trailing-LF) +1 byte.

---

## Dedup / re-fire flag

processN reached 6 for a single token across the session. The current `_processCount` WeakMap-per-page-load counts correctly. The dedup redesign (`_processed` WeakMap → self-tagging) was NOT implemented per prompt scope. Recommendation: the high re-fire count (6×) makes the redesign more pressing than expected.

---

## Issues / unexpected findings

**m.facebook.com completely inaccessible from desktop Chrome:** Chrome's network stack redirects m.facebook.com to www.facebook.com before the extension fires, even with DevTools device emulation (viewport + UA override). Requires real mobile hardware (Android + Firefox-for-Android) to test with the extension running.

**m.facebook.com MISMATCH hypothesis updated:** A saved MHTML snapshot of m.facebook.com/alice.mock was analysed offline (JSDOM + textContent walk). Both post tokens (fa9988e6, fd214bae) had clean body text at d0 — no author/timestamp chrome at any depth ≤ d5. Chrome only appears at d6 (the full-page container), but `readPostText` exits at d0 (≥10 pre-token chars found). **Chrome bleed-in is ruled out as the cause on the profile page.** The remaining candidate: m.facebook.com's DOM produces different `innerText` whitespace/newlines than www, causing a CANON hash divergence. A direct `innerText` comparison on the live page (not textContent) is the next diagnostic step.

**No chrome bleed-in on www.facebook.com profile pages:** raw-text-info consistently showed clean post body (no author name, no timestamp) at all depths. Profile page DOM isolates post body from author/timestamp in sibling subtrees that readPostText's innerText traversal doesn't reach. Chrome-skipping by Strategy B was NOT directly observed — there was no chrome in any candidate. Feed page (where post cards include author+timestamp in the same container) not tested.

**TRUNCATED on first scan:** Process #1 fires before FB has fully rendered the post body. preTokenLen < 20 → TRUNCATED. Process #2 gets the full text. This is expected but confirms that verifier results should not be considered final until at least the second scan.

**Bio character-limit truncation → INVALID:** Placing two SSD tokens in a FB bio causes the second to be truncated at the bio character limit. The extension correctly reports INVALID (atob error on truncated base64 signature). Token length and platform character limits are an open deployment consideration.

**CFG.analyser left true:** The session left `CFG.analyser: true` in core/cfg.js. This enables the diagnostic panel and collector logging on every page load. Should be reset to `false` before any production / user-facing deployment.
