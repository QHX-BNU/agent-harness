from __future__ import annotations

import json
import re
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class JsonlTracer:
    """Append-only audit events with basic secret/PII redaction."""

    _lock = threading.Lock()
    _sensitive_key = re.compile(r"(token|secret|password|api[_-]?key|authorization)", re.IGNORECASE)
    _email = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
    _phone = re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)")

    def __init__(self, path: str | Path = "runtime/traces.jsonl") -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, event: str, *, run_id: str, **data: Any) -> None:
        record = {
            "timestamp": datetime.now(UTC).isoformat(),
            "event": event,
            "run_id": run_id,
            **self._redact(data),
        }
        line = json.dumps(record, ensure_ascii=False, default=str)
        with self._lock:
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")

    def read(self, run_id: str, limit: int = 200) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        safe_limit = max(1, min(int(limit), 1000))
        events: list[dict[str, Any]] = []
        with self._lock:
            with self.path.open("r", encoding="utf-8") as stream:
                for line in stream:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get("run_id") == run_id:
                        events.append(event)
        return events[-safe_limit:]

    def _redact(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: "[REDACTED]" if self._sensitive_key.search(str(key)) else self._redact(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [self._redact(item) for item in value]
        if isinstance(value, str):
            return self._phone.sub("[PHONE]", self._email.sub("[EMAIL]", value))
        return value
