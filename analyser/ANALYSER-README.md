# SSD Analyser — Run Guide

## What this is

A verbose diagnostic mode of the Tick extension (v0.4.0). It runs the real
verification pipeline over real signed posts, logging every decision — canon
stage-by-stage, two extraction strategies side by side, key resolution path,
Ed25519 verify result, and MISMATCH/INVALID discrimination path.

Output goes to: an on-page collapsible panel (screenshottable on mobile) and a
local NDJSON collector running on your machine.

---

## Step 1 — Enable the analyser flag

Edit `ssd-tick-2/core/cfg.js` and set `analyser: true`:

```js
const CFG = {
  analyser: true,          // ← flip this
  analyserCollectorUrl: 'http://localhost:8099/log',
  ...
};
```

Or toggle at runtime in devtools: `CFG.analyser = true` then reload the page.

---

## Step 2 — Start the collector

```sh
node spikes/generic-extraction/collector.js
```

Listens on `http://localhost:8099`. Writes append-only NDJSON to
`ssd-spike-<timestamp>.ndjson` in the current directory.

---

## Step 3 — Load the extension (unpacked)

### Firefox-for-Android (primary mobile target)

Firefox-for-Android loads unpacked extensions directly — no signing required.

1. Enable USB debugging on the phone and connect via USB.
2. Confirm `adb devices` shows the phone.
3. On the phone: open Firefox → Settings → About Firefox → tap "Firefox" 5×
   to enable Developer Mode.
4. On desktop: `about:debugging` → "Setup" tab → connect to the device.
5. Load: "This Firefox" (on the device) → Load Temporary Add-on →
   navigate to `ssd-tick-2/manifest.json`.
6. Confirm the extension icon appears in Firefox toolbar.

Alternatively use `web-ext run --target=firefox-android` from `ssd-tick-2/`.

Set `analyserCollectorUrl` to your desktop's LAN IP, e.g.
`http://192.168.1.x:8099/log` so the phone can reach the collector.

### Desktop Chrome
`chrome://extensions` → Developer mode → Load unpacked → select `ssd-tick-2/`

### Desktop Firefox
`about:debugging` → This Firefox → Load Temporary Add-on → `ssd-tick-2/manifest.json`

---

## Step 4 — Prepare the corpus

Open `analyser/corpus.json`. For each entry:

| expected_state  | How to create it |
|-----------------|-----------------|
| VALID           | Sign a post via sign-direct.js or the PWA compose box. Do not edit it. |
| MISMATCH        | Sign a post, then edit the body text before verifying. |
| INVALID         | Post a token with one character of the signature changed. |
| VALID_UNKNOWN   | Sign with a key NOT imported into the local keyring. |
| url: hint       | Use `url:https://yoursite/ssd-key.json` as the identity when signing. |
| fb: hint        | Use `fb:yourhandle` as the identity when signing. |

Fill in the `url` field for each entry after posting.

---

## Step 5 — Run the analyser

1. Open a corpus entry URL in the browser.
2. The SSD Analyser panel appears bottom-right (collapsible, ▾ header).
3. Each signed post produces a log block as it loads.
4. Use the **Export** button to download the full panel log as a `.txt` file.
5. Check the collector terminal for raw NDJSON lines.

---

## Reading the panel output

```
── token a1b2c3d4 process #1 [facebook] ──
  A  input                        312b  "Hello world this is a signed..."
  A  CANON-1 (strip-token)        290b  "Hello world this is a signed..."
  A  CANON-2 (NFC)                290b  "Hello world this is a signed..."
  ...
  A  CANON-7 (trailing-LF)        291b  "Hello world this is a signed..."
  A  result  content8=a1b2c3d4  token=a1b2c3d4  match=true
  B  RECOVERED  winner=d2 s3 trim+collapse  cache=false  attempts=12
  KEY  local-keyring  a1b2c3d4 (Alice)
  ED25519  [A]  PASS
  OUTCOME  plugin=VALID  analyser=VALID  MATCH
```

Key things to look for:

| Entry | Meaning |
|-------|---------|
| `process #N` where N > 1 | Tick re-fired on the same token (platform re-render) |
| `A result match=false` | Strategy A did not reproduce the signed content |
| `B SEARCH_EXHAUSTED` | Suffix search found no matching candidate |
| `B winner=d2 s3 trim+collapse` | Strategy B recovered at depth 2, 3 suffix blocks, trim+collapse variant |
| `DISC path=vault-query → MISMATCH` | Vault confirmed sig is valid but post was edited |
| `DISC path=heuristic → MISMATCH` | Vault unreachable; 64-byte sig with resolvable key inferred MISMATCH |
| `*** DIVERGE ***` | Analyser state differs from what the plugin badge shows |

---

## After running

Fill in `analyser/findings-stub.md` and bring it to Chat for artifact reconciliation.
