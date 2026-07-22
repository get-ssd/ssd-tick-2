# Testing SSD Tick against socialmedia-mock

How to verify the extension actually badges signed posts, on real browsers,
across all five mock platforms. Written so a cold session can reproduce it.

Mock repo: `../../socialmedia-mock` (see its `STATE.md`).

---

## What is being tested

The mock serves genuinely Ed25519-signed posts. Three verdicts must appear:

| Signer | hash8 | Expected badge | Why |
|---|---|---|---|
| Alice | `A485141D` | `VALID` | signed, untouched, key in keyring |
| Bob | `0D1CBB3A` | `MISMATCH` | key resolvable, displayed text tampered after signing |
| Carol | `BDF1B1DF` | `KEY_UNREACHABLE` | validly signed, key published nowhere |

Badges are `span.ssd-indicator[data-ssd-state]`. Each mock post also renders its
expected verdict in a `.fb-expect` / `.x-expect` / `.rd-expect` / `.tg-expect` /
`.wa-expect` tag, which the harness diffs against the real badge.

**Keys must be in the keyring for VALID/MISMATCH.** Tokens use `fb:`/`x:`/`rd:`/
`tg:`/`wa:` identity hints, and the service worker's `resolveIdentity()` does
**not** auto-fetch for those — so Alice and Bob must be imported. Carol must
never be imported; that is what makes her KEY_UNREACHABLE.

---

## Wiring (already done — context for future changes)

Each platform module is injected by a **path-scoped** content-script block, one
per mock path, in *both* `manifest.json` (Firefox) and `manifest-chrome.json`:

```
/social-mock/facebook*  → platforms/facebook.js
/social-mock/x*         → platforms/twitter.js
/social-mock/reddit*    → platforms/reddit.js
/social-mock/telegram*  → platforms/telegram.js
/social-mock/whatsapp*  → platforms/whatsapp.js
```

Each module also lists `localhost`/`127.0.0.1` in its `hostnames` guard.

**Do not collapse these into one broad `/social-mock/*` block.** All files in a
content-script block share one isolated world, so they share the single
`textScanner._processed` map — whichever module bootstraps first wins the scan
and badges *every* platform's tokens. That is what the broad block used to do
(the Facebook module was silently badging Telegram/X posts). Path-scoping is
what makes each module actually responsible for its own platform.

---

## Automated run (Chromium-family)

```
# 1. mock server
cd ../../socialmedia-mock && 00-startup.bat

# 2. close the target browser first (single-instance lock + debug port)
node test/mock-verify.js --browser=brave
node test/mock-verify.js --browser=chromium
#   --close    auto-close the browser when finished
```

`mock-verify.js` launches the browser on its **real profile** (where tick2 is
installed), seeds Alice+Bob **non-destructively** via the extension popup page,
then loads every platform and prints expected-vs-actual per post.

Last known-good result: **18/18 on Brave and 18/18 on Chromium.**

### Why it attaches to the real profile
Current Chrome/Chromium **ignore `--load-extension` into a throwaway profile**,
so side-loading an unpacked extension for a test no longer works. The extension
must already be installed. It is, in both Brave and Chromium, loading from
`ssd.tick-2/dist/chrome` (id `oikjghlmjiapoliomcdnkfbkkfcoellh` — same in both,
since the id derives from that path).

**Rebuild `dist/chrome` (`build-chrome.bat`) before testing if you changed the
extension** — launching the browser fresh loads whatever is in that folder. A
browser left running keeps the old copy until reloaded.

---

## Firefox / Android (Firefox Nightly on a phone)

Release Firefox will not permanently install an unsigned xpi, and puppeteer's
desktop-Firefox path does not get content scripts injected (MV3 host-permission
model). The working route is `web-ext` onto **Firefox Nightly** over ADB.

Prerequisites: USB debugging authorised on the phone; Nightly →
**Settings → Remote debugging via USB → ON**.

```
adb reverse tcp:8080 tcp:8080     # phone's localhost:8080 → this PC's mock server
npx web-ext run --target=firefox-android \
  --android-device=<serial> \
  --firefox-apk=org.mozilla.fenix \
  --source-dir="<repo>/ssd.tick-2/dist/firefox-unpacked"
```

`dist/firefox-unpacked` is the built Firefox extension unzipped (from
`build-firefox.bat`'s xpi). Use it rather than the repo root, or web-ext will
package `.git`, `node_modules` and `dist`.

**This installs a *temporary* add-on — it is removed when the `web-ext` session
ends or Firefox restarts.** Keep that terminal open for the whole test.

Then on the phone open `http://localhost:8080/social-mock/facebook`. A fresh
profile has an empty keyring, so **every post reads KEY_UNREACHABLE** — that
alone proves the content script runs on Gecko/Android. For VALID/MISMATCH,
open `/social-mock/facebook/alice.mock` and `…/bob.mock` and tap the
**"🔑 Add key"** beacon buttons, then reload.

Status: install confirmed working; on-device badge verification not completed.

---

## Gotchas that cost time before

- **`nkeimhogjdpnpccoofpliimaahmaaome` is Google Hangouts**, not this extension.
  The old `test/e2e.js` hardcodes it as if it were ours. Ignore it.
- **tick2 is not installed in Google Chrome** — only Brave and Chromium.
- The repo-root `manifest.json` is the **Firefox** manifest (event-page
  `background.scripts`). Chrome needs `manifest-chrome.json` → `dist/chrome`
  (service worker). Pointing Chrome at the repo root loads the wrong manifest.
- Telegram/WhatsApp have **no combined feed** — the harness visits each
  channel/chat URL separately.
- Restart the mock server after editing `server.js`; fixtures alone hot-reload.

## Files

- `mock-verify.js` — the working harness (Brave/Chromium, all five platforms).
- `facebook-mock.js` — **superseded/non-functional**: built on the
  `--load-extension` throwaway-profile approach that current Chrome blocks.
  Kept for reference only; `mock-verify.js` replaces it.
