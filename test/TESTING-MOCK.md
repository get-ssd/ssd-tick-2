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

Each post's text also says which badge it should get ("Alice's signed message,
untouched. Shows VALID once Alice's key is added." etc.), so the expected state is
obvious on screen.

**Alice's key must be in the keyring for VALID.** Tokens use `fb:`/`x:`/`rd:`/
`tg:`/`wa:` identity hints, and the service worker's `resolveIdentity()` does
**not** auto-fetch for those — so Alice must be imported. **Bob reads MISMATCH
with or without his key**: the token's content hash shows the edit without the
key. Carol must never be imported; that is what makes her KEY_UNREACHABLE.

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

## Firefox — tablets (Nightly) and Windows

```
# 1. mock server
cd ../../socialmedia-mock && 00-startup.bat

# 2. build, then run
build-firefox.bat
demo\run.bat                 # every tablet in demo/tablets.json, then Windows Firefox
demo\run.bat --only android  # tablets only
demo\run.bat --only firefox  # Windows Firefox only
```

`demo/tick_run.py` drives Firefox over its Remote Debugging Protocol
(`demo/firefox_rdp.py`): on the tablets via `adb forward` to Nightly's debugger
socket (attaching to the Nightly already running in Android user 10), on Windows
via `-start-debugger-server` on a throwaway profile. Tick is installed as a
temporary add-on.

**Each run starts from an empty keyring.** Any previous Tick is uninstalled first
(its storage goes with it), then on the Facebook feed:

| Step | Alice | Bob | Carol |
|---|---|---|---|
| No keys | KEY_UNREACHABLE | MISMATCH | KEY_UNREACHABLE |
| Follow Alice's link, tap "Add key", Back, refresh | VALID | MISMATCH | KEY_UNREACHABLE |
| Follow Bob's link, tap "Add key", Back, refresh | VALID | MISMATCH | KEY_UNREACHABLE |

then the 18-badge pass over all five platforms.

**Refresh after Back is deliberate.** On the tablets, Back restores the feed from
the back/forward cache with the old badges; Tick does not re-verify on its own
(kept light), so the user refreshes. The runner logs the pre-refresh badges but
does not check them. (Windows Firefox 156 showed the new badges before the refresh.)

Tablet prerequisites: Nightly installed for Android user 10, **Settings → Remote
debugging via USB → ON**. The runner taps away Nightly's "<add-on> was added" notice.

Last known-good (2026-09-28, Tick 0.4.11): 0 failures on SERIAL-1, SERIAL-2,
SERIAL-3 and Windows Firefox 156 — walk-through plus 18/18 each.

### Manual route (web-ext)

`npx web-ext run --target=firefox-android --android-device=<serial>
--firefox-apk=org.mozilla.fenix --source-dir=dist/firefox-unpacked` with
`adb reverse tcp:10117 tcp:10117` also installs a temporary add-on, but it is
removed when that terminal closes. The runner above replaces it.

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

- `mock-verify.js` — the Brave/Chromium harness (all five platforms).
- `../demo/tick_run.py` — the Firefox runner (tablets + Windows), fresh-keyring walk-through.
- `facebook-mock.js` — **superseded/non-functional**: built on the
  `--load-extension` throwaway-profile approach that current Chrome blocks.
  Kept for reference only; `mock-verify.js` replaces it.
