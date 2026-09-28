"""Minimal Firefox Remote Debugging Protocol client.

The same protocol about:debugging and web-ext use. Firefox Nightly on Android
exposes it on the abstract socket `org.mozilla.fenix/firefox-debugger-socket`
("Remote debugging via USB"); `adb forward` makes it a local TCP port. Desktop
Firefox exposes it with `-start-debugger-server <port>`.

It attaches to the Firefox that is already running, in whichever Android user
owns it — no geckodriver, no profile push.

Wire format: `<length>:<json>` in both directions. Replies come from the actor a
request was sent to; unsolicited events (type set, e.g. `evaluationResult`) are
interleaved and queued until someone asks for them.
"""
import json
import socket
import time


class RDPError(RuntimeError):
    pass


class RDP:
    def __init__(self, port, host="127.0.0.1", timeout=15.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.buf = b""
        self.events = []
        self.greeting = self._read()
        if self.greeting.get("from") != "root":
            raise RDPError(f"unexpected greeting: {self.greeting}")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    # ── Framing ────────────────────────────────────────────────────────────
    def _read(self):
        while b":" not in self.buf:
            self._fill()
        size, rest = self.buf.split(b":", 1)
        size = int(size)
        while len(rest) < size:
            self.buf = rest
            self._fill()
            rest = self.buf
        self.buf = rest[size:]
        return json.loads(rest[:size].decode("utf-8"))

    def _fill(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise RDPError("connection closed by Firefox")
        self.buf += chunk

    def _send(self, packet):
        data = json.dumps(packet).encode("utf-8")
        self.sock.sendall(str(len(data)).encode() + b":" + data)

    # ── Request / events ───────────────────────────────────────────────────
    def request(self, to, type_, **fields):
        """Send a request and return the actor's reply (events are queued)."""
        self._send({"to": to, "type": type_, **fields})
        while True:
            msg = self._read()
            if msg.get("from") == to and ("type" not in msg or msg.get("error")):
                if msg.get("error"):
                    raise RDPError(f"{to} {type_}: {msg['error']} {msg.get('message', '')}")
                return msg
            self.events.append(msg)

    def wait_event(self, match, timeout=15.0):
        end = time.time() + timeout
        while True:
            for i, msg in enumerate(self.events):
                if match(msg):
                    return self.events.pop(i)
            if time.time() >= end:
                raise RDPError("timed out waiting for event")
            self.sock.settimeout(max(0.1, end - time.time()))
            try:
                self.events.append(self._read())
            except socket.timeout:
                pass
            finally:
                self.sock.settimeout(15.0)

    # ── Root-level helpers ─────────────────────────────────────────────────
    def root(self):
        return self.request("root", "getRoot")

    def install_temporary_addon(self, addon_path):
        """addon_path is a path Firefox itself can read (on the device for Android)."""
        addons = self.root()["addonsActor"]
        return self.request(addons, "installTemporaryAddon", addonPath=addon_path, openDevTools=False)["addon"]

    def uninstall_addon(self, addon_id):
        """Remove an add-on (and its storage). Returns False if it was not installed."""
        if not any(a.get("id") == addon_id for a in self.request("root", "listAddons")["addons"]):
            return False
        self.request(self.root()["addonsActor"], "uninstallAddon", addonId=addon_id)
        return True

    def tabs(self):
        return self.request("root", "listTabs")["tabs"]

    def tab_target(self, tab=None):
        """Target form for a tab (selected tab by default): has actor and consoleActor."""
        tabs = self.tabs()
        if not tabs:
            raise RDPError("no tabs open")
        tab = tab or next((t for t in tabs if t.get("selected")), tabs[0])
        reply = self.request(tab["actor"], "getTarget")
        return reply.get("frame") or reply.get("form")

    def addon_target(self, addon_id):
        """Target form for an extension's background context."""
        addons = self.request("root", "listAddons")["addons"]
        desc = next((a for a in addons if a.get("id") == addon_id), None)
        if desc is None:
            raise RDPError(f"add-on {addon_id} not listed")
        reply = self.request(desc["actor"], "getTarget")
        return reply.get("form") or reply.get("frame")

    # ── Target helpers ─────────────────────────────────────────────────────
    def navigate(self, target, url):
        self.request(target["actor"], "navigateTo", url=url)

    def evaluate(self, target, js, timeout=15.0):
        """Evaluate js in the target's global and return the result.

        Objects come back as grips, so callers return JSON.stringify(...) and
        this decodes strings that look like JSON. Exceptions raise RDPError.
        """
        console = target["consoleActor"]
        reply = self.request(console, "evaluateJSAsync", text=js)
        rid = reply["resultID"]
        res = self.wait_event(lambda m: m.get("type") == "evaluationResult" and m.get("resultID") == rid, timeout)
        if res.get("hasException") or res.get("exception") is not None and res.get("exceptionMessage"):
            raise RDPError(f"page exception: {res.get('exceptionMessage')}")
        value = res.get("result")
        if isinstance(value, dict) and value.get("type") == "undefined":
            return None
        if isinstance(value, dict) and value.get("type") == "longString":
            value = self.request(value["actor"], "substring", start=0, end=value["length"])["substring"]
        if isinstance(value, str) and value[:1] in "[{":
            try:
                return json.loads(value)
            except ValueError:
                pass
        return value
