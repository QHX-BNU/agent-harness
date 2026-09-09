from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

from .policy import PolicyEngine, refund_limit_rule
from .providers import DemoSupportProvider, OpenAICompatibleProvider
from .runner import Agent, AgentRunner, RunnerConfig
from .storage import SQLiteCheckpointStore
from .tools import ToolContext, ToolRegistry, tool
from .tracing import JsonlTracer


SYSTEM_PROMPT = """你是电商售后执行 Agent。目标是安全、完整地处理客户订单问题。

成功标准：先读取订单事实；只在延误时按订单实付金额退款；完成后通知客户。
约束：不得猜测订单状态或金额；写操作必须通过工具；工具失败时解释并停止；不要声称完成未执行的动作。
输出：简洁说明已完成动作、当前结果和任何阻塞。"""


class SupportDatabase:
    """Transactional business store; separate from the agent checkpoint store."""

    def __init__(self, path: str | Path = "runtime/business.db") -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
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
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS orders (
                    order_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    amount REAL NOT NULL,
                    customer_email TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS refunds (
                    refund_id TEXT PRIMARY KEY,
                    order_id TEXT NOT NULL UNIQUE,
                    amount REAL NOT NULL,
                    reason TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id TEXT NOT NULL,
                    message TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )
            connection.executemany(
                "INSERT OR IGNORE INTO orders(order_id, status, amount, customer_email) VALUES (?, ?, ?, ?)",
                [
                    ("ORD-1001", "delayed", 299.0, "alice@example.com"),
                    ("ORD-1002", "delivered", 89.0, "bob@example.com"),
                ],
            )

    def get_order(self, order_id: str) -> dict[str, Any] | None:
        with self._session() as connection:
            row = connection.execute(
                "SELECT order_id, status, amount FROM orders WHERE order_id = ?", (order_id,)
            ).fetchone()
        return dict(row) if row else None

    def issue_refund(self, order_id: str, amount: float, reason: str, run_id: str) -> dict[str, Any]:
        with self._lock, self._session() as connection:
            existing = connection.execute(
                "SELECT refund_id, order_id, amount FROM refunds WHERE order_id = ?", (order_id,)
            ).fetchone()
            if existing:
                return {**dict(existing), "idempotent_replay": True}
            order = connection.execute(
                "SELECT status, amount FROM orders WHERE order_id = ?", (order_id,)
            ).fetchone()
            if order is None:
                raise ValueError("order not found")
            if order["status"] != "delayed":
                raise ValueError("only delayed orders are refundable")
            if abs(float(order["amount"]) - float(amount)) > 0.001:
                raise ValueError("refund amount does not match the paid amount")
            refund_id = f"RF-{uuid4().hex[:10].upper()}"
            connection.execute(
                "INSERT INTO refunds(refund_id, order_id, amount, reason, run_id) VALUES (?, ?, ?, ?, ?)",
                (refund_id, order_id, amount, reason, run_id),
            )
            return {"refund_id": refund_id, "order_id": order_id, "amount": amount, "idempotent_replay": False}

    def notify(self, order_id: str, message: str, run_id: str) -> dict[str, Any]:
        with self._session() as connection:
            cursor = connection.execute(
                "INSERT INTO notifications(order_id, message, run_id) VALUES (?, ?, ?)",
                (order_id, message, run_id),
            )
            return {"notification_id": cursor.lastrowid, "order_id": order_id, "status": "sent"}


def build_runner(
    *,
    runtime_dir: str | Path = "runtime",
    provider_name: str | None = None,
    config: RunnerConfig | None = None,
) -> AgentRunner:
    runtime_path = Path(runtime_dir)
    backend = SupportDatabase(runtime_path / "business.db")
    registry = ToolRegistry()

    @tool(description="按订单号读取可信订单状态与实付金额。只读，可安全重试。", side_effect="read", max_retries=1)
    def get_order(order_id: str) -> dict[str, Any]:
        order = backend.get_order(order_id)
        if order is None:
            raise ValueError("order not found")
        return order

    @tool(
        description="为延误订单创建全额退款。会产生资金副作用；order_id 保证业务幂等。",
        side_effect="write",
        idempotent=True,
    )
    def issue_refund(order_id: str, amount: float, reason: str, context: ToolContext) -> dict[str, Any]:
        return backend.issue_refund(order_id, amount, reason, context.run_id)

    @tool(description="向客户发送售后处理结果。会产生外部消息副作用。", side_effect="write")
    def notify_customer(order_id: str, message: str, context: ToolContext) -> dict[str, Any]:
        return backend.notify(order_id, message, context.run_id)

    registry.register(get_order)
    registry.register(issue_refund)
    registry.register(notify_customer)

    selected = provider_name or os.getenv("HARNESS_PROVIDER", "demo")
    if selected == "demo":
        provider = DemoSupportProvider()
    elif selected == "openai-compatible":
        provider = OpenAICompatibleProvider.from_env()
    else:
        raise ValueError(f"unknown provider: {selected}")

    return AgentRunner(
        agent=Agent(name="customer-support", instructions=SYSTEM_PROMPT, tools=registry),
        provider=provider,
        store=SQLiteCheckpointStore(runtime_path / "agent_harness.db"),
        tracer=JsonlTracer(runtime_path / "traces.jsonl"),
        policy=PolicyEngine(rules=[refund_limit_rule(200.0)]),
        config=config,
    )
