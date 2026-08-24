#!/usr/bin/env python3
"""Local Hysteria auth relay and cumulative traffic reporter for Nivora."""

import json
import hashlib
import hmac
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_AUTH_BODY = 16 * 1024
MAX_STATS_BODY = 5 * 1024 * 1024
ROUTE_RE = re.compile(r"^[A-Za-z0-9_.-]{2,80}$")
CLIENT_RE = re.compile(r"^hy2-[a-f0-9]{32}$")


def required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def read_secret(path):
    with open(path, "r", encoding="utf-8") as source:
        value = source.read().strip()
    if len(value.encode("utf-8")) < 32:
        raise RuntimeError("restricted secret file is missing or too short")
    return value


CENTRAL = required("NIVORA_CENTRAL_URL").rstrip("/")
ROUTE_ID = required("NIVORA_HYSTERIA_ROUTE_ID")
if not ROUTE_RE.fullmatch(ROUTE_ID):
    raise RuntimeError("invalid Hysteria route ID")
parsed_central = urllib.parse.urlparse(CENTRAL)
if parsed_central.scheme != "https" and parsed_central.hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise RuntimeError("central URL must use HTTPS unless it is loopback")

NODE_SECRET = read_secret(required("NIVORA_HYSTERIA_NODE_SECRET_FILE"))
STATS_SECRET = read_secret(required("NIVORA_HYSTERIA_STATS_SECRET_FILE"))
LAB_SECRET_FILE = os.environ.get("NIVORA_HYSTERIA_LAB_SECRET_FILE", "").strip()
LAB_SECRET = read_secret(LAB_SECRET_FILE) if LAB_SECRET_FILE else ""
LAB_CLIENT_ID = f"hy2-{hashlib.sha256(('lab:' + ROUTE_ID).encode()).hexdigest()[:32]}"
STATS_URL = os.environ.get("NIVORA_HYSTERIA_STATS_URL", "http://127.0.0.1:9999").rstrip("/")
LISTEN_HOST = os.environ.get("NIVORA_HYSTERIA_AGENT_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("NIVORA_HYSTERIA_AGENT_PORT", "8788"))
REPORT_SECONDS = max(30, int(os.environ.get("NIVORA_HYSTERIA_REPORT_SECONDS", "60")))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("nivora-hysteria-agent")


def request_json(url, method="GET", payload=None, secret=None, timeout=6, max_bytes=MAX_STATS_BODY):
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"Accept": "application/json", "User-Agent": "Nivora-Hysteria-Agent/1"}
    if secret:
        headers["Authorization"] = f"Bearer {secret}" if url.startswith(CENTRAL) else secret
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise ValueError("response too large")
        return json.loads(raw.decode("utf-8"))


def deny(handler):
    body = b'{"ok":false,"id":""}'
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class AuthHandler(BaseHTTPRequestHandler):
    server_version = "NivoraAgent"
    sys_version = ""

    def log_message(self, fmt, *args):
        return

    def do_POST(self):
        if self.path != "/auth":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 2 or length > MAX_AUTH_BODY:
                return deny(self)
            incoming = json.loads(self.rfile.read(length).decode("utf-8"))
            auth = incoming.get("auth")
            if not isinstance(auth, str) or not 1 <= len(auth) <= 8192:
                return deny(self)
            if LAB_SECRET and hmac.compare_digest(auth, LAB_SECRET):
                encoded = json.dumps({"ok": True, "id": LAB_CLIENT_ID}, separators=(",", ":")).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                return
            payload = {
                "addr": str(incoming.get("addr", ""))[:256],
                "auth": auth,
                "tx": max(0, int(incoming.get("tx", 0))),
            }
            result = request_json(
                f"{CENTRAL}/internal/v1/hysteria/auth/{urllib.parse.quote(ROUTE_ID)}",
                method="POST",
                payload=payload,
                secret=NODE_SECRET,
                timeout=6,
                max_bytes=4096,
            )
            client_id = result.get("id", "")
            if result.get("ok") is not True or not CLIENT_RE.fullmatch(client_id):
                return deny(self)
            encoded = json.dumps({"ok": True, "id": client_id}, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except Exception as error:
            log.warning("authentication relay unavailable: %s", type(error).__name__)
            deny(self)


def report_forever(stop_event):
    while not stop_event.wait(REPORT_SECONDS):
        try:
            raw = request_json(f"{STATS_URL}/traffic", secret=STATS_SECRET, timeout=5)
            if not isinstance(raw, dict) or len(raw) > 10_000:
                raise ValueError("invalid traffic response")
            clients = {}
            for client_id, counters in raw.items():
                if not CLIENT_RE.fullmatch(str(client_id)) or not isinstance(counters, dict):
                    continue
                clients[client_id] = {
                    "tx": max(0, int(counters.get("tx", 0))),
                    "rx": max(0, int(counters.get("rx", 0))),
                }
            if clients:
                request_json(
                    f"{CENTRAL}/internal/v1/hysteria/usage/{urllib.parse.quote(ROUTE_ID)}",
                    method="POST",
                    payload={"clients": clients},
                    secret=NODE_SECRET,
                    timeout=8,
                    max_bytes=4096,
                )
        except Exception as error:
            log.warning("traffic report deferred: %s", type(error).__name__)


def main():
    stop = threading.Event()
    reporter = threading.Thread(target=report_forever, args=(stop,), name="traffic-reporter", daemon=True)
    reporter.start()
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), AuthHandler)
    log.info("agent ready for route %s", ROUTE_ID)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
