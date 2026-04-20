from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import mimetypes
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/styles.css": "styles.css",
}
BLOCKED_HEADERS = {
    "connection",
    "content-length",
    "host",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}


class PollClientHandler(BaseHTTPRequestHandler):
    server_version = "TTSPollClient/0.1"

    def do_GET(self) -> None:
        if self.path == "/api/health":
            self.write_json({"status": "ok"})
            return
        self.serve_static()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/request":
            self.write_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
            return
        self.handle_proxy_request()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def serve_static(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        filename = STATIC_FILES.get(parsed.path)
        if filename is None:
            self.write_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
            return

        path = (PROJECT_ROOT / filename).resolve()
        if PROJECT_ROOT not in path.parents and path != PROJECT_ROOT:
            self.write_json({"error": "Invalid path"}, status=HTTPStatus.BAD_REQUEST)
            return
        if not path.is_file():
            self.write_json({"error": "File missing"}, status=HTTPStatus.NOT_FOUND)
            return

        content = path.read_bytes()
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def handle_proxy_request(self) -> None:
        try:
            payload = self.read_json_body()
            started = time.perf_counter()
            response = proxy_request(payload, allow_remote=self.server.allow_remote)
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            self.log_message(
                "proxied %s %s -> %s in %.1f ms",
                payload.get("method") or "GET",
                payload.get("url") or "",
                response.get("status"),
                elapsed_ms,
            )
            self.write_json(response, status=HTTPStatus.OK)
        except ProxyError as exc:
            self.write_json({"ok": False, "error": str(exc)}, status=exc.status)
        except Exception as exc:
            self.write_json(
                {"ok": False, "error": f"Proxy error: {exc}"},
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )

    def read_json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length") or 0)
        if content_length <= 0:
            raise ProxyError("Request body is required.", HTTPStatus.BAD_REQUEST)
        raw = self.rfile.read(content_length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ProxyError(f"Invalid JSON: {exc}", HTTPStatus.BAD_REQUEST) from exc
        if not isinstance(parsed, dict):
            raise ProxyError("Request body must be a JSON object.", HTTPStatus.BAD_REQUEST)
        return parsed

    def write_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format: str, *args: Any) -> None:
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        sys.stderr.write("%s %s - %s\n" % (timestamp, self.address_string(), format % args))


class ProxyError(Exception):
    def __init__(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


class PollClientServer(ThreadingHTTPServer):
    allow_remote: bool = False


def proxy_request(payload: dict[str, Any], *, allow_remote: bool) -> dict[str, Any]:
    target_url = str(payload.get("url") or "").strip()
    if not target_url:
        raise ProxyError("url is required.")
    validate_url(target_url, allow_remote=allow_remote)

    method = str(payload.get("method") or "GET").upper()
    if method not in ALLOWED_METHODS:
        raise ProxyError(f"Unsupported method: {method}")

    headers = normalize_headers(payload.get("headers") or {})
    body = encode_body(payload.get("body"), headers)
    timeout_ms = int(payload.get("timeoutMs") or 60000)
    timeout = max(timeout_ms, 1000) / 1000.0
    response_type = str(payload.get("responseType") or "json").lower()

    request = urllib.request.Request(target_url, data=body, method=method)
    for name, value in headers.items():
        request.add_header(name, value)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return build_proxy_response(
                ok=True,
                status=response.status,
                reason=response.reason,
                headers=dict(response.headers.items()),
                data=response.read(),
                response_type=response_type,
            )
    except urllib.error.HTTPError as exc:
        return build_proxy_response(
            ok=False,
            status=exc.code,
            reason=exc.reason,
            headers=dict(exc.headers.items()),
            data=exc.read(),
            response_type=response_type,
        )
    except urllib.error.URLError as exc:
        raise ProxyError(f"Target request failed: {exc.reason}", HTTPStatus.BAD_GATEWAY) from exc


def validate_url(target_url: str, *, allow_remote: bool) -> None:
    parsed = urllib.parse.urlparse(target_url)
    if parsed.scheme not in {"http", "https"}:
        raise ProxyError("Only http and https URLs are allowed.")
    if not parsed.hostname:
        raise ProxyError("URL hostname is required.")
    if allow_remote:
        return
    if not is_loopback_host(parsed.hostname):
        raise ProxyError("Only loopback targets are allowed. Restart with --allow-remote to override.")


def is_loopback_host(hostname: str) -> bool:
    normalized = hostname.strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def normalize_headers(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ProxyError("headers must be a JSON object.")
    headers: dict[str, str] = {}
    for name, header_value in value.items():
        normalized_name = str(name).strip()
        if not normalized_name:
            continue
        if normalized_name.lower() in BLOCKED_HEADERS:
            continue
        headers[normalized_name] = str(header_value)
    return headers


def encode_body(value: Any, headers: dict[str, str]) -> bytes | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value.encode("utf-8")
    if isinstance(value, (dict, list, int, float, bool)):
        if not any(name.lower() == "content-type" for name in headers):
            headers["Content-Type"] = "application/json"
        return json.dumps(value, ensure_ascii=False).encode("utf-8")
    raise ProxyError("body must be null, string, object, array, number, or boolean.")


def build_proxy_response(
    *,
    ok: bool,
    status: int,
    reason: str,
    headers: dict[str, str],
    data: bytes,
    response_type: str,
) -> dict[str, Any]:
    content_type = headers.get("Content-Type") or headers.get("content-type") or ""
    text = decode_text(data)
    result: dict[str, Any] = {
        "ok": ok,
        "status": status,
        "statusText": reason,
        "headers": headers,
        "contentType": content_type,
    }

    if response_type == "blob":
        result["bodyBase64"] = base64.b64encode(data).decode("ascii")
        result["bodyText"] = text if len(data) <= 4096 else ""
        return result

    result["bodyText"] = text
    parsed_json = try_parse_json(text)
    if parsed_json is not None:
        result["bodyJson"] = parsed_json
    return result


def decode_text(data: bytes) -> str:
    if not data:
        return ""
    for encoding in ("utf-8", "utf-8-sig", "cp1251"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def try_parse_json(text: str) -> Any | None:
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local static UI + proxy for polling job APIs.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--allow-remote", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    server = PollClientServer((args.host, args.port), PollClientHandler)
    server.allow_remote = bool(args.allow_remote)
    print(f"TTS Poll Client: http://{args.host}:{args.port}")
    print(f"Remote targets: {'allowed' if args.allow_remote else 'blocked'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
