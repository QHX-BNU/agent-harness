from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .models import RunState


class RunNotFoundError(KeyError):
    pass


class SQLiteCheckpointStore:
    """Small durable store. Each operation owns its connection for thread safety."""

    def __init__(self, path: str | Path = "runtime/agent_harness.db") -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    @contextmanager
    def _session(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._session() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_runs (
                    run_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute("CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id)")

    def save(self, state: RunState) -> None:
        payload = json.dumps(state.to_dict(), ensure_ascii=False, separators=(",", ":"))
        with self._session() as connection:
            connection.execute(
                """
                INSERT INTO agent_runs(run_id, session_id, status, state_json, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    status=excluded.status,
                    state_json=excluded.state_json,
                    updated_at=excluded.updated_at
                """,
                (state.run_id, state.session_id, state.status.value, payload, state.updated_at),
            )

    def load(self, run_id: str) -> RunState:
        with self._session() as connection:
            row = connection.execute("SELECT state_json FROM agent_runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            raise RunNotFoundError(run_id)
        return RunState.from_dict(json.loads(row[0]))

    def load_latest_session(self, session_id: str) -> RunState | None:
        with self._session() as connection:
            row = connection.execute(
                "SELECT state_json FROM agent_runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1",
                (session_id,),
            ).fetchone()
        return RunState.from_dict(json.loads(row[0])) if row else None

    def list_runs(self, limit: int = 50) -> list[RunState]:
        safe_limit = max(1, min(int(limit), 200))
        with self._session() as connection:
            rows = connection.execute(
                "SELECT state_json FROM agent_runs ORDER BY updated_at DESC LIMIT ?",
                (safe_limit,),
            ).fetchall()
        return [RunState.from_dict(json.loads(row[0])) for row in rows]
