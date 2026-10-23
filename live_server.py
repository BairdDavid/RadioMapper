"""Serve Radio Mapper and proxy one receiver so the browser can read its live feed.

The receiver's sign-in URL does not allow other websites to call it. This server
serves the map and forwards /mp/<host>/... to https://<host>/... on localhost only.
"""
import http.server
import re
import urllib.error
import urllib.request

HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(?::\d+)?$")
PREFIX = "/mp/"


class Handler(http.server.SimpleHTTPRequestHandler):
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

    def proxy(self):
        rest = self.path[len(PREFIX):]
        host, sep, tail = rest.partition("/")
        if not sep or not HOST_RE.match(host):
            self.send_error(400, "Invalid receiver host")
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
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 18765), Handler)
    print("Radio Mapper at http://127.0.0.1:18765/")
    server.serve_forever()
