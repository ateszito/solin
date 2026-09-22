#!/usr/bin/env python3
"""
dev_single_origin.py — single-origin dev harness (SCALE-BRIDGE-001 proof).

Serves `app/` (the Solin SPA) as static files AND reverse-proxies
`/api/*` to the local FastAPI backend (default 127.0.0.1:8086).

This models the PRODUCTION topology (one origin, SPA + API behind one edge —
Cloudflare Tunnel) WITHOUT needing the Docker nginx to actually wire the
proxy (which it doesn't yet; Dockerfile §5 says "replace the two static routes
with proxy_pass" is a TODO).

Usage:
    python3 scripts/dev_single_origin.py --port 8100 --backend 127.0.0.1:8086
"""
from __future__ import annotations
import argparse, io, json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http import HTTPStatus
import mimetypes
import urllib.request
import urllib.error

APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app"))
BACKEND = "127.0.0.1:8086"
PORT = 8100
# We rewrite the API base at request time (see index below) — the SPA reads
# _solin.env.js which we generate once in /tmp and also inject.
# Actually: we serve a tiny _solin.env.js that bakes API_BASE_URL = "" (same origin).
BAKED_ENV_JS = (
    "window.SOLIN_CONFIG = {\n"
    '  SOLIN_ENV: "development",\n'
    '  APP_VERSION: "v0.1.2-dev+b91629c+single-origin",\n'
    '  API_BASE_URL: "",\n'
    '  PUBLIC_BASE_URL: "http://127.0.0.1:8100",\n'
    '  FEATURE_ALLOW_EDIT: "true",\n'
    '  FEATURE_INVISIBILITY: "true",\n'
    '  DEBUG: "true"\n'
    "};"
)

class Handler(BaseHTTPRequestHandler):
    server_version = "SolinDevSingle/1.0"

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _serve_api(self):
        path = self.path
        # Preserve querystring
        body = self._read_body()
        url = f"http://{BACKEND}{path}"
        req = urllib.request.Request(
            url,
            data=body if self.command != "GET" else None,
            method=self.command,
            headers={
                k: v for k, v in self.headers.items()
                if k.lower() not in ("host","connection","content-length")
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self._cors()
                for k, v in resp.headers.items():
                    if k.lower() in ("connection", "transfer-encoding"):
                        continue
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self._cors()
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        except Exception as e:
            payload = json.dumps({"error": str(e)}).encode()
            self.send_response(502)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def _serve_static(self):
        # _solin.env.js is baked at request-time so the SPA hits THIS origin
        if self.path in ("/_solin.env.js", "/index.html"):
            pass
        path = self.path
        # Normalise: strip leading /, map to APP_DIR
        rel = path.lstrip("/") or "index.html"
        full = os.path.join(APP_DIR, rel)
        if not os.path.isfile(full):
            # SPA fallback to index.html for any non-file non-API route
            if "." not in os.path.basename(path) and not path.startswith("/_solin"):
                full = os.path.join(APP_DIR, "index.html")
            elif path == "/_solin.env.js":
                # Baked env — serve inline (API_BASE="")
                data = BAKED_ENV_JS.encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            else:
                self.send_response(404)
                self.send_header("Content-Length", "9")
                self.end_headers()
                self.wfile.write(b"Not found")
                return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._serve_api()
        else:
            self._serve_static()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._serve_api()
        else:
            self._serve_static()

    def do_PUT(self):
        self._serve_api()

    def do_DELETE(self):
        self._serve_api()

    def log_message(self, format, *args):
        sys.stderr.write("[dev-single-origin] %s - %s\n" % (self.address_string(), format % args))


def main():
    global BACKEND
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=PORT)
    p.add_argument("--backend", type=str, default=BACKEND)
    a = p.parse_args()
    BACKEND = a.backend
    print(f"[dev-single-origin] app dir: {APP_DIR}")
    print(f"[dev-single-origin] serving on http://127.0.0.1:{a.port}")
    print(f"[dev-single-origin] proxying /api/* -> http://{a.backend}")
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    srv.serve_forever()


if __name__ == "__main__":
    main()
