"""Serve Radio Mapper and proxy one receiver so the browser can read its live feed.

The receiver's sign-in URL does not allow other websites to call it. This server
serves the map and forwards /mp/<host>/... to https://<host>/... on localhost only.
Receivers on the local network often use their own built-in certificate, which
browsers and Python do not trust, so for private-network hosts the certificate is
not checked and the live socket can be tunnelled through here as well.
"""
import http.server
import ipaddress
import os
import re
import socket
import ssl
import threading
import urllib.error
import urllib.request

HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(?::\d+)?$")
PREFIX = "/mp/"
TOKEN_PATH = "apps/device/api/v1/token"
SOCKET_PATH = "apps/device/api/v1/ws/"
ALLOWED_ORIGINS = {
    "https://bairddavid.github.io",
    "http://127.0.0.1:18765",
    "http://localhost:18765",
}
TUNNEL_HEADERS = {
    "upgrade", "connection", "sec-websocket-key", "sec-websocket-version",
    "sec-websocket-extensions", "sec-websocket-protocol", "user-agent",
}


def split_host(host):
    name, _, port = host.partition(":")
    return name, int(port) if port else 443


def is_private_host(name):
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(name, None)}
    except OSError:
        return False
    return bool(addresses) and all(ipaddress.ip_address(a.split("%")[0]).is_private for a in addresses)


def tls_context(name):
    if is_private_host(name):
        return ssl._create_unverified_context()
    return ssl.create_default_context()


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        if self.path.startswith(PREFIX):
            self.respond(204, "text/plain", b"")
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path.startswith(PREFIX):
            if self.headers.get("Upgrade", "").lower() == "websocket":
                self.tunnel()
            else:
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

    def target(self):
        rest = self.path[len(PREFIX):]
        host, sep, tail = rest.partition("/")
        if not sep or not HOST_RE.match(host):
            return None, None
        return host, tail

    def proxy(self):
        host, tail = self.target()
        if not host or self.command != "POST" or tail.split("?", 1)[0] != TOKEN_PATH:
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        data = self.rfile.read(length) if length else None
        request = urllib.request.Request("https://" + host + "/" + TOKEN_PATH, data=data, method=self.command)
        content_type = self.headers.get("Content-Type")
        if content_type:
            request.add_header("Content-Type", content_type)

        try:
            context = tls_context(split_host(host)[0])
            with urllib.request.urlopen(request, timeout=60, context=context) as response:
                self.respond(response.status, response.headers.get("Content-Type"), response.read())
        except urllib.error.HTTPError as error:
            self.respond(error.code, error.headers.get("Content-Type"), error.read())
        except Exception:
            self.send_error(502, "Receiver unreachable")

    def tunnel(self):
        host, tail = self.target()
        own_origin = "http://127.0.0.1:%d" % self.server.server_address[1]
        origin = self.headers.get("Origin")
        if not host or not tail.startswith(SOCKET_PATH) or origin not in ALLOWED_ORIGINS | {own_origin}:
            self.send_error(404)
            return

        name, port = split_host(host)
        try:
            raw = socket.create_connection((name, port), timeout=30)
            upstream = tls_context(name).wrap_socket(raw, server_hostname=name)
        except Exception:
            self.send_error(502, "Receiver unreachable")
            return

        lines = ["GET /" + tail + " HTTP/1.1", "Host: " + host]
        lines += [k + ": " + v for k, v in self.headers.items() if k.lower() in TUNNEL_HEADERS]
        upstream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
        upstream.settimeout(None)
        client = self.connection
        client.settimeout(None)
        self.close_connection = True

        def pump(source, sink):
            try:
                while True:
                    chunk = source.recv(65536)
                    if not chunk:
                        break
                    sink.sendall(chunk)
            except OSError:
                pass
            finally:
                for s in (source, sink):
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

        reader = threading.Thread(target=pump, args=(upstream, client), daemon=True)
        reader.start()
        pump(client, upstream)
        reader.join()
        upstream.close()

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
