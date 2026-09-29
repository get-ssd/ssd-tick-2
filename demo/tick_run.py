"""Run SSD Tick against socialmedia-mock on Android Nightly tablets and Windows browsers.

    py demo/tick_run.py                    # every tablet in tablets.json + Windows Firefox
    py demo/tick_run.py --only android     # tablets only
    py demo/tick_run.py --only firefox     # Windows Firefox only
    py demo/tick_run.py --chromium         # also run test/mock-verify.js on Chromium (close Chromium first)
    py demo/tick_run.py --serial SERIAL-1   # one tablet

Firefox (tablet and desktop) is driven over the Remote Debugging Protocol
(firefox_rdp.py): Tick is installed as a temporary add-on, any previous install is
removed first so the keyring starts empty. On the Facebook feed Alice and Carol
must read KEY_UNREACHABLE and Bob MISMATCH (tampering shows without his key); the
runner follows Alice's link, taps "Add key", goes back, refreshes and checks Alice
is VALID, then does the same for Bob. After
that every platform's badges are compared with the verdict the mock prints.
Expected set: Alice VALID, Bob MISMATCH, Carol KEY_UNREACHABLE (never seeded).

Needs: the mock server on :10117 (../../socialmedia-mock/00-startup.bat), a
current dist/ (build-firefox.bat), and on each tablet Nightly with
"Remote debugging via USB" on, in the foreground Android user.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

from firefox_rdp import RDP, RDPError

HERE = os.path.dirname(os.path.abspath(__file__))
TICK = os.path.dirname(HERE)
XPI = os.path.join(TICK, "dist", "ssd-tick-firefox.xpi")
MOCK_PORT = 10117
BASE = f"http://localhost:{MOCK_PORT}/social-mock"
FENIX = "org.mozilla.fenix"
DEVICE_XPI = "/data/local/tmp/ssd-tick.xpi"
DESKTOP_FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
T0 = time.time()

# Same table as test/mock-verify.js.
PLATFORMS = [
    ("Facebook", ".fb-expect", ".fb-post", [f"{BASE}/facebook"]),
    ("X", ".x-expect", ".x-cell", [f"{BASE}/x"]),
    ("Reddit", ".rd-expect", ".rd-post", [f"{BASE}/reddit"]),
    ("Telegram", ".tg-expect", ".tgme_widget_message",
     [f"{BASE}/telegram/alice_mock", f"{BASE}/telegram/bob_mock", f"{BASE}/telegram/carol_mock"]),
    ("WhatsApp", ".wa-expect", ".message-in",
     [f"{BASE}/whatsapp/15550000001", f"{BASE}/whatsapp/15550000002", f"{BASE}/whatsapp/15550000003"]),
]
TICK_ID = "ssd@idltd.com"
FEED = f"{BASE}/facebook"

JS_BADGE_COUNT = """JSON.stringify((() => {
  const b = [...document.querySelectorAll('.ssd-indicator')];
  return {total: b.length, scanning: b.filter(x => x.dataset.ssdState === 'SCANNING').length,
          expected: document.querySelectorAll(%s).length, ready: document.readyState};
})())"""

JS_COLLECT = """JSON.stringify((() => {
  const norm = t => (t || '').trim().split(/[\\s(]/)[0];
  return [...document.querySelectorAll(%s)].map(exp => {
    const c = exp.closest(%s);
    const badge = c && c.querySelector('.ssd-indicator');
    return {expect: norm(exp.textContent), actual: badge ? (badge.dataset.ssdState || 'NO_STATE') : 'NO_BADGE'};
  });
})())"""

JS_CLICK_ADD_KEY = """JSON.stringify((() => {
  const b = [...document.querySelectorAll('button,a')].filter(x => /add key/i.test(x.textContent));
  b.forEach(x => x.click());
  return b.length;
})())"""

JS_BUTTON_TEXT = """JSON.stringify([...document.querySelectorAll('button,a')]
  .filter(x => x.className && /beacon|key/i.test(x.className + ' ' + x.textContent))
  .map(x => x.textContent.trim()))"""

# Feed badge state per signer — each post's text names its signer ("Alice's signed message ...").
JS_FEED_STATES = """JSON.stringify([...document.querySelectorAll('.fb-post')].map(p => {
  const who = ((p.innerText.match(/(Alice|Bob|Carol)'s/) || [])[1] || '?');
  const b = p.querySelector('.ssd-indicator');
  return [who, b ? (b.dataset.ssdState || 'NO_STATE') : 'NO_BADGE'];
}))"""

JS_FOLLOW_AUTHOR = """(() => {
  const a = [...document.querySelectorAll('a.fb-author')].find(x => x.getAttribute('href').endsWith('/%s'));
  if (!a) return 'no link';
  a.click();
  return a.href;
})()"""

# After each step of the fresh walk-through: expected feed state per signer.
WALK_STEPS = [
    ("no keys", None, {"Alice": "KEY_UNREACHABLE", "Bob": "MISMATCH", "Carol": "KEY_UNREACHABLE"}),
    ("Alice's key added", "alice.mock", {"Alice": "VALID", "Bob": "MISMATCH", "Carol": "KEY_UNREACHABLE"}),
    ("Bob's key added", "bob.mock", {"Alice": "VALID", "Bob": "MISMATCH", "Carol": "KEY_UNREACHABLE"}),
]


class Log:
    def __init__(self, path):
        self.path, self.failures = path, []
        os.makedirs(os.path.dirname(path), exist_ok=True)

    def __call__(self, message):
        line = f"{time.strftime('%H:%M:%S')} {time.time() - T0:7.1f}s  {message}"
        print(line, flush=True)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def check(self, ok, message):
        self(("ok    " if ok else "FAIL  ") + message)
        if not ok:
            self.failures.append(message)
        return ok


# ── Browser-independent test body ─────────────────────────────────────────────
class Session:
    def __init__(self, name, rdp, log):
        self.name, self.rdp, self.log = name, rdp, log

    def wait_loaded(self, url, settle=1.0):
        end = time.time() + 20
        while time.time() < end:
            time.sleep(0.5)
            try:
                target = self.rdp.tab_target()
                if self.rdp.evaluate(target, "location.href") == url and                         self.rdp.evaluate(target, "document.readyState") == "complete":
                    break
            except RDPError:
                pass  # page swapped mid-evaluation; retry
        time.sleep(settle)
        return self.rdp.tab_target()

    def goto(self, url, settle=1.0):
        self.rdp.navigate(self.rdp.tab_target(), url)
        return self.wait_loaded(url, settle)

    def walkthrough(self):
        """Fresh keyring: feed shows every post unrecognised; follow Alice's link,
        add her key, go back, refresh; then Bob. Check the feed after each step.

        Going back restores the feed from the back/forward cache with the old
        badges — Tick deliberately does not re-verify on its own (kept light), so
        the user refreshes. The pre-refresh state is logged, not checked."""
        target = self.goto(FEED)
        for step, profile, want in WALK_STEPS:
            if profile:
                href = self.rdp.evaluate(target, JS_FOLLOW_AUTHOR % profile)
                if not self.log.check(href.endswith(profile), f"{self.name}: follow link to {profile} ({href})"):
                    return
                target = self.wait_loaded(href)
                before = self.rdp.evaluate(target, JS_BUTTON_TEXT)
                clicked = self.rdp.evaluate(target, JS_CLICK_ADD_KEY)
                time.sleep(4)  # the beacon verifies the key card before storing it
                after = self.rdp.evaluate(self.rdp.tab_target(), JS_BUTTON_TEXT)
                self.log.check(int(clicked or 0) > 0, f"{self.name}: {profile} — {before} → clicked {clicked} → {after}")
                self.rdp.evaluate(self.rdp.tab_target(), "setTimeout(() => history.back(), 50)")
                target = self.wait_loaded(FEED)
                stale = ", ".join(f"{w} {s}" for w, s in self.rdp.evaluate(target, JS_FEED_STATES))
                self.log(f"{self.name}: back on feed, before refresh: {stale}")
                self.rdp.evaluate(target, "setTimeout(() => location.reload(), 50)")
                time.sleep(1)  # let the reload start so wait_loaded doesn't see the old page
                target = self.wait_loaded(FEED)
            self.wait_badges(target, ".fb-expect")
            for who, state in self.rdp.evaluate(target, JS_FEED_STATES):
                self.log.check(state == want.get(who), f"{self.name}: feed, {step:<18} {who:<5} expected {want.get(who)!s:<16} actual {state}")

    def wait_badges(self, target, expect_sel, timeout=12):
        end = time.time() + timeout
        state = {}
        while time.time() < end:
            state = self.rdp.evaluate(target, JS_BADGE_COUNT % json.dumps(expect_sel))
            if state["total"] >= state["expected"] and state["scanning"] == 0:
                return state
            time.sleep(0.3)
        return state

    def run_platforms(self):
        total = passed = 0
        for name, expect_sel, container_sel, urls in PLATFORMS:
            rows = []
            for url in urls:
                try:
                    target = self.goto(url)
                    self.wait_badges(target, expect_sel)
                    rows += self.rdp.evaluate(target, JS_COLLECT % (json.dumps(expect_sel), json.dumps(container_sel)))
                except RDPError as e:
                    rows.append({"expect": "?", "actual": f"PAGE_ERR {e}"[:60]})
            for r in rows:
                total += 1
                ok = r["expect"] == r["actual"]
                passed += ok
                self.log.check(ok, f"{self.name}: {name:<9} expected {r['expect']:<16} actual {r['actual']}")
        self.log(f"{self.name}: {passed}/{total} badges matched")
        return passed, total


# ── Android tablets ───────────────────────────────────────────────────────────
class Tablet:
    def __init__(self, serial, name, user, port):
        self.serial, self.name, self.user, self.port = serial, name, str(user), port

    def adb(self, *args, check=True):
        env = dict(os.environ, MSYS_NO_PATHCONV="1")
        r = subprocess.run(["adb", "-s", self.serial, *args], capture_output=True, env=env)
        out = r.stdout.decode(errors="replace").replace("\r", "")
        if check and r.returncode:
            raise RuntimeError(f"{self.name}: adb {' '.join(args)} failed: {r.stderr.decode(errors='replace').strip()}")
        return out

    def prepare(self, log):
        current = self.adb("shell", "am get-current-user").strip()
        if current != self.user:
            raise RuntimeError(f"foreground Android user is {current}, not {self.user}")
        if FENIX not in self.adb("shell", f"pm list packages --user {self.user} {FENIX}"):
            raise RuntimeError(f"Firefox Nightly not installed for user {self.user}")
        self.adb("shell", "input keyevent KEYCODE_WAKEUP")
        self.adb("reverse", f"tcp:{MOCK_PORT}", f"tcp:{MOCK_PORT}")
        self.adb("push", XPI, DEVICE_XPI)
        self.adb("shell", f"chmod 644 {DEVICE_XPI}")
        self.adb("shell", f"am start --user {self.user} -a android.intent.action.VIEW -d {BASE}/facebook {FENIX}")
        socket_name = f"@{FENIX}/firefox-debugger-socket"
        for _ in range(20):
            if socket_name in self.adb("shell", "cat /proc/net/unix", check=False):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("no Firefox debugger socket — is 'Remote debugging via USB' on in Nightly?")
        self.adb("forward", f"tcp:{self.port}", f"localabstract:{FENIX}/firefox-debugger-socket")
        log(f"{self.name}: Nightly up, debugger forwarded to :{self.port}")

    def dismiss_added_notice(self, log):
        """Nightly shows '<add-on> was added' with an OK button on every install;
        they stack up across runs. Tap OK until none is left (read via uiautomator)."""
        taps = 0
        for _ in range(10):
            self.adb("shell", "uiautomator dump /data/local/tmp/ui.xml", check=False)
            xml = self.adb("exec-out", "cat /data/local/tmp/ui.xml", check=False)
            if " was added" not in xml:
                break
            m = re.search(r'text="OK"[^>]*class="android\.widget\.Button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
            if not m:
                break
            x1, y1, x2, y2 = map(int, m.groups())
            self.adb("shell", f"input tap {(x1 + x2) // 2} {(y1 + y2) // 2}")
            taps += 1
            time.sleep(0.8)
        if taps:
            log(f"{self.name}: dismissed {taps} 'was added' notice(s)")

    def release(self):
        self.adb("forward", "--remove", f"tcp:{self.port}", check=False)


def run_tablet(tablet, log):
    try:
        tablet.prepare(log)
        rdp = RDP(tablet.port)
    except (RuntimeError, OSError, RDPError) as e:
        log.check(False, f"{tablet.name}: setup — {e}")
        return
    try:
        if rdp.uninstall_addon(TICK_ID):
            log(f"{tablet.name}: old Tick uninstalled (keyring wiped)")
        addon = rdp.install_temporary_addon(DEVICE_XPI)
        log(f"{tablet.name}: Tick installed ({addon.get('id')})")
        time.sleep(1.5)  # let the notice appear before looking for it
        tablet.dismiss_added_notice(log)
        s = Session(tablet.name, rdp, log)
        s.walkthrough()
        s.run_platforms()
    except (RDPError, OSError) as e:
        log.check(False, f"{tablet.name}: {e}")
    finally:
        rdp.close()
        tablet.release()


# ── Windows Firefox ───────────────────────────────────────────────────────────
def run_desktop_firefox(log, port=6099):
    if not os.path.exists(DESKTOP_FIREFOX):
        log.check(False, f"Windows Firefox: not found at {DESKTOP_FIREFOX}")
        return
    try:
        RDP(port, timeout=2).close()
        log.check(False, f"Windows Firefox: something already answers on :{port} — a Firefox left from an earlier run? Close it first")
        return
    except OSError:
        pass
    profile = tempfile.mkdtemp(prefix="tick-ff-")
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as f:
        for k, v in {"devtools.debugger.remote-enabled": True, "devtools.chrome.enabled": True,
                     "devtools.debugger.prompt-connection": False, "browser.shell.checkDefaultBrowser": False,
                     "browser.aboutwelcome.enabled": False, "datareporting.policy.dataSubmissionEnabled": False,
                     "browser.startup.homepage_override.mstone": "ignore",
                     # First-run data-choices / terms / onboarding prompts are browser-modal:
                     # while one is up the debugger's root actor stops answering.
                     "datareporting.policy.dataSubmissionPolicyBypassNotification": True,
                     "toolkit.telemetry.reportingpolicy.firstRun": False,
                     "browser.preonboarding.enabled": False,
                     "termsofuse.bypassNotification": True,
                     "trailhead.firstrun.didSeeAboutWelcome": True,
                     "browser.startup.firstrunSkipsHomepage": True}.items():
            f.write(f'user_pref("{k}", {json.dumps(v)});\n')
    proc = subprocess.Popen([DESKTOP_FIREFOX, "-no-remote", "-profile", profile,
                             "-start-debugger-server", str(port), f"{BASE}/facebook"])
    rdp = None
    try:
        for _ in range(40):
            try:
                rdp = RDP(port)
                break
            except OSError:
                time.sleep(0.5)
        if rdp is None:
            log.check(False, "Windows Firefox: debugger server never answered")
            return
        addon = rdp.install_temporary_addon(XPI)
        log(f"Windows Firefox: Tick installed ({addon.get('id')})")
        s = Session("Windows Firefox", rdp, log)
        s.walkthrough()
        s.run_platforms()
    except (RDPError, OSError) as e:
        log.check(False, f"Windows Firefox: {e}")
    finally:
        if rdp:
            rdp.close()
        stop_firefox(proc, profile)
        shutil.rmtree(profile, ignore_errors=True)


def stop_firefox(proc, profile):
    """firefox.exe hands off to a child and exits, so killing proc alone leaves
    the real browser running. Kill every process launched with this profile."""
    proc.kill()
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='firefox.exe'\" | "
          f"Where-Object {{ $_.CommandLine -like '*{os.path.basename(profile)}*' }} | "
          "ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True)
    time.sleep(1)  # let Windows release the profile files before rmtree


# ── Windows Chromium (existing harness) ───────────────────────────────────────
def run_chromium(log):
    log("Windows Chromium: running test/mock-verify.js --browser=chromium --close")
    r = subprocess.run(["node", "test/mock-verify.js", "--browser=chromium", "--close"],
                       cwd=TICK, capture_output=True, text=True, encoding="utf-8", errors="replace")
    for line in r.stdout.splitlines():
        if line.strip():
            log(f"Windows Chromium: {line.rstrip()}")
    log.check(r.returncode == 0, "Windows Chromium: mock-verify.js " + ("passed" if r.returncode == 0 else f"exit {r.returncode}"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["android", "firefox"])
    ap.add_argument("--serial")
    ap.add_argument("--chromium", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    log = Log(os.path.join(HERE, "runs", time.strftime("%Y%m%d-%H%M%S") + ".log"))
    try:
        urllib.request.urlopen(f"{BASE}/facebook", timeout=5)
    except OSError as e:
        raise SystemExit(f"Mock server not reachable on :{MOCK_PORT} — start ../../socialmedia-mock/00-startup.bat ({e})")
    if not os.path.exists(XPI):
        raise SystemExit("dist/ssd-tick-firefox.xpi missing — run build-firefox.bat")

    cfg_path = os.path.join(HERE, "tablets.json")
    if not os.path.exists(cfg_path):
        raise SystemExit("demo/tablets.json missing — copy tablets.example.json and fill in your device serials")
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    tablets = [Tablet(t["serial"], t["name"], cfg.get("android_user", 10), cfg.get("rdp_base_port", 6010) + i)
               for i, t in enumerate(cfg["tablets"]) if not args.serial or t["serial"] == args.serial]

    if args.only != "firefox":
        for t in tablets:
            run_tablet(t, log)
    if args.only != "android":
        run_desktop_firefox(log)
    if args.chromium:
        run_chromium(log)

    log(f"DONE — {len(log.failures)} failure(s). Log: {log.path}")
    sys.exit(1 if log.failures else 0)


if __name__ == "__main__":
    main()
