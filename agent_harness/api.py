from __future__ import annotations

import json
import os
import threading
from collections import Counter
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .models import RunState, RunStatus
from .providers import DemoSupportProvider, OpenAICompatibleProvider
from .runner import AgentRunner
from .storage import RunNotFoundError


MAX_BODY_BYTES = 64 * 1024
WEB_DIR = Path(__file__).with_name("web")
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/static/app.css": ("app.css", "text/css; charset=utf-8"),
    "/static/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/static/favicon.svg": ("favicon.svg", "image/svg+xml"),
}


class ApiMetrics:
    def __init__(self) -> None:
        self._counts: Counter[str] = Counter()
        self._lock = threading.Lock()

    def increment(self, name: str) -> None:
        with self._lock:
            self._counts[name] += 1

    def render(self) -> str:
        with self._lock:
            items = sorted(self._counts.items())
        lines = ["# TYPE agent_harness_events_total counter"]
        lines.extend(f'agent_harness_events_total{{event="{name}"}} {value}' for name, value in items)
        return "\n".join(lines) + "\n"


def _run_summary(state: RunState) -> dict[str, Any]:
    user_message = next((message.content for message in reversed(state.messages) if message.role == "user"), "")
    return {
        "run_id": state.run_id,
        "session_id": state.session_id,
        "status": state.status.value,
        "step": state.step,
        "preview": (user_message or "")[:80],
        "output": state.final_output,
        "pending_approval": state.pending_approval.to_dict() if state.pending_approval else None,
        "created_at": state.created_at,
        "updated_at": state.updated_at,
    }


def _provider_info(runner: AgentRunner) -> dict[str, Any]:
    provider = runner.provider_snapshot()
    if isinstance(provider, OpenAICompatibleProvider):
        return {
            "type": "openai-compatible",
            "model": provider.model,
            "base_url": provider.base_url,
            "configured": bool(provider.api_key and provider.model),
            "api_key_set": bool(provider.api_key),
        }
    return {"type": "demo", "model": "deterministic-support-demo", "configured": True, "api_key_set": False}


def _configure_provider(runner: AgentRunner, body: dict[str, Any]) -> dict[str, Any]:
    provider_type = str(body.get("type", "")).strip()
    if provider_type == "demo":
        runner.set_provider(DemoSupportProvider())
        return _provider_info(runner)
    if provider_type != "openai-compatible":
        raise ValueError("provider type must be 'demo' or 'openai-compatible'")

    current = runner.provider_snapshot()
    model = str(body.get("model", "")).strip()
    base_url = str(body.get("base_url", "https://api.openai.com/v1")).strip().rstrip("/")
    supplied_key = str(body.get("api_key", "")).strip()
    existing_key = current.api_key if isinstance(current, OpenAICompatibleProvider) else ""
    api_key = supplied_key or existing_key or os.getenv("OPENAI_API_KEY", "")
    parsed_url = urlparse(base_url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise ValueError("base_url must be a valid http(s) URL")
    if not model:
        raise ValueError("model is required")
    if not api_key:
        raise ValueError("api_key is required the first time this provider is configured")
    runner.set_provider(OpenAICompatibleProvider(model=model, api_key=api_key, base_url=base_url))
    return _provider_info(runner)


def make_handler(runner: AgentRunner, api_key: str | None = None) -> type[BaseHTTPRequestHandler]:
    metrics = ApiMetrics()

    class Handler(BaseHTTPRequestHandler):
        server_version = "AgentHarness/0.2"

        def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
            parsed = urlparse(self.path)
            path = parsed.path
            if path in STATIC_FILES:
                filename, content_type = STATIC_FILES[path]
                self._static(filename, content_type)
                return
            if not self._authorized():
                return
            if path == "/health":
                self._json(HTTPStatus.OK, {"status": "ok"})
                return
            if path == "/metrics":
                self._bytes(HTTPStatus.OK, metrics.render().encode("utf-8"), "text/plain; version=0.0.4")
                return
            if path == "/v1/config":
                self._json(HTTPStatus.OK, _provider_info(runner))
                return
            if path == "/v1/runs":
                query = parse_qs(parsed.query)
                try:
                    limit = int(query.get("limit", ["30"])[0])
                except ValueError:
                    limit = 30
                self._json(HTTPStatus.OK, {"runs": [_run_summary(item) for item in runner.store.list_runs(limit)]})
                return
            if path.startswith("/v1/runs/") and path.endswith("/events"):
                run_id = path.removeprefix("/v1/runs/").removesuffix("/events").rstrip("/")
                self._json(HTTPStatus.OK, {"events": runner.tracer.read(run_id)})
                return
            if path.startswith("/v1/runs/"):
                run_id = path.removeprefix("/v1/runs/")
                try:
                    state = runner.inspect(run_id)
                except RunNotFoundError:
                    self._json(HTTPStatus.NOT_FOUND, {"error": "run not found"})
                    return
                self._json(HTTPStatus.OK, state.to_dict())
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
            if not self._authorized():
                return
            try:
                body = self._read_json()
            except ValueError as exc:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            path = urlparse(self.path).path
            try:
                if path == "/v1/config":
                    config = _configure_provider(runner, body)
                    metrics.increment("provider_configured")
                    self._json(HTTPStatus.OK, config)
                    return
                if path == "/v1/runs":
                    run_method = runner.run_background if body.get("async") is True else runner.run
                    result = run_method(
                        str(body.get("input", "")),
                        session_id=body.get("session_id"),
                        metadata=body.get("metadata") if isinstance(body.get("metadata"), dict) else None,
                    )
                    metrics.increment("run_started")
                    status = HTTPStatus.ACCEPTED if result.status in {RunStatus.RUNNING, RunStatus.WAITING_APPROVAL} else HTTPStatus.OK
                    self._json(status, result.to_dict())
                    return
                if path.endswith("/approval") and path.startswith("/v1/runs/"):
                    run_id = path.removeprefix("/v1/runs/").removesuffix("/approval").rstrip("/")
                    if not isinstance(body.get("approved"), bool):
                        raise ValueError("'approved' must be a boolean")
                    result = runner.resume(
                        run_id,
                        approved=body["approved"],
                        approver=str(body.get("approver", "console-user")),
                    )
                    metrics.increment(f"approval_{'approved' if body['approved'] else 'rejected'}")
                    self._json(HTTPStatus.OK, result.to_dict())
                    return
            except RunNotFoundError:
                self._json(HTTPStatus.NOT_FOUND, {"error": "run not found"})
                return
            except ValueError as exc:
                self._json(HTTPStatus.CONFLICT, {"error": str(exc)})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def _authorized(self) -> bool:
            if api_key and self.headers.get("X-API-Key") != api_key:
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return False
            return True

        def _read_json(self) -> dict[str, Any]:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as exc:
                raise ValueError("invalid Content-Length") from exc
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ValueError(f"body must be between 1 and {MAX_BODY_BYTES} bytes")
            try:
                value = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError("body must be valid UTF-8 JSON") from exc
            if not isinstance(value, dict):
                raise ValueError("JSON body must be an object")
            return value

        def _static(self, filename: str, content_type: str) -> None:
            try:
                payload = (WEB_DIR / filename).read_bytes()
            except FileNotFoundError:
                self._json(HTTPStatus.NOT_FOUND, {"error": "web asset not found"})
                return
            self._bytes(HTTPStatus.OK, payload, content_type)

        def _json(self, status: HTTPStatus, value: object) -> None:
            self._bytes(
                status,
                json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"),
                "application/json; charset=utf-8",
            )

        def _bytes(self, status: HTTPStatus, payload: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
            )
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: Any) -> None:
            print(f"api {self.client_address[0]} {format % args}")

    return Handler


def serve(runner: AgentRunner, host: str = "127.0.0.1", port: int = 8080) -> None:
    api_key = os.getenv("HARNESS_API_KEY")
    server = ThreadingHTTPServer((host, port), make_handler(runner, api_key))
    protection = "X-API-Key enabled" if api_key else "local demo mode (no API key)"
    print(f"Agent Harness Console: http://{host}:{port} — {protection}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
