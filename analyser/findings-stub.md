# Analyser Run Findings

Run date:
Extension build: 0.4.0
Collector NDJSON file:
Platforms tested:

---

## Corpus results

| id | platform | expected | plugin showed | analyser state | match | strategy B | notes |
|----|----------|----------|---------------|----------------|-------|------------|-------|
| fb-www-valid        | fb-desktop | VALID         | | | | | |
| fb-www-mismatch     | fb-desktop | MISMATCH      | | | | | |
| fb-www-invalid      | fb-desktop | INVALID       | | | | | |
| fb-www-valid-unknown| fb-desktop | VALID_UNKNOWN | | | | | |
| fb-www-url-hint     | fb-desktop | VALID         | | | | | |
| fb-www-fb-hint      | fb-desktop | VALID         | | | | | |
| fb-mobile-valid     | fb-mobile  | VALID         | | | | | |
| fb-mobile-mismatch  | fb-mobile  | MISMATCH      | | | | | |
| tw-valid            | twitter    | VALID         | | | | n/a | |
| tw-mismatch         | twitter    | MISMATCH      | | | | n/a | |

Strategy B column: RECOVERED / CACHE_STALE / SEARCH_EXHAUSTED / SELECTOR_EMPTY / n/a

---

## Strategy B cache behaviour

*(After first run, did a second load of the same page produce RECOVERED via cache?
Did the suffixCount sweep work — i.e. did the cached depth × variantId hit even when
paragraph structure shifted between loads?)*

---

## Re-fire events

*(Any `process #N` where N > 1? Which platform / post type? Frequency?)*

---

## MISMATCH/INVALID discrimination paths

*(For each MISMATCH and INVALID entry: was it vault-query or heuristic?
Did the vault path give the correct verdict?)*

---

## Strategy A canon divergences

*(For any entry where `A result match=false`: what did the per-stage log show?
Which CANON stage changed the output unexpectedly?)*

---

## Dedup / re-fire flag

*(The Tick dedup mechanism — find-our-badges-first / self-tagging, replacing the
node-keyed `_processed` WeakMap — was NOT changed in this session. If re-fires
appeared frequently, note here as a design decision for Chat.)*

---

## Issues / unexpected findings
