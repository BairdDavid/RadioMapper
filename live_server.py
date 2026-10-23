"""Serve Radio Mapper and proxy one receiver so the browser can read its live feed.

The receiver's sign-in URL does not allow other websites to call it. This server
serves the map and forwards /mp/<host>/... to https://<host>/... on localhost only.
"""
import http.server
import os
import re
import urllib.error
import urllib.request

HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(?::\d+)?$")
PREFIX = "/mp/"
ALLOWED_ORIGINS = {
    "https://bairddavid.github.io",
    "http://127.0.0.1:18765",
    "http://localhost:18765",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        if self.path.startswith(PREFIX):
            self.respond(204, "text/plain", b"")
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path.startswith(PREFIX):
            self.proxy()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith(PREFIX):
            self.proxy()
        else:
            self.send_error(404)

    def end_headers(self):
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
        super().end_headers()

    def proxy(self):
        rest = self.path[len(PREFIX):]
        host, sep, tail = rest.partition("/")
        tail = tail.split("?", 1)[0]
        if not sep or not HOST_RE.match(host) or self.command != "POST" or tail != "apps/device/api/v1/token":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        data = self.rfile.read(length) if length else None
        request = urllib.request.Request("https://" + host + "/" + tail, data=data, method=self.command)
        content_type = self.headers.get("Content-Type")
        if content_type:
            request.add_header("Content-Type", content_type)

        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                self.respond(response.status, response.headers.get("Content-Type"), response.read())
        except urllib.error.HTTPError as error:
            self.respond(error.code, error.headers.get("Content-Type"), error.read())
        except Exception:
            self.send_error(502, "Receiver unreachable")

    def respond(self, status, content_type, body):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type or "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass


if __name__ == "__main__":
    port = int(os.environ.get("RADIO_MAPPER_PORT", "18765"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Radio Mapper at http://127.0.0.1:{port}/", flush=True)
    server.serve_forever()
