from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from agent_harness.application import SupportDatabase, build_runner
from agent_harness.models import Message, ModelResponse, RunStatus, ToolCall
from agent_harness.policy import PolicyEngine
from agent_harness.runner import Agent, AgentRunner, RunnerConfig
from agent_harness.storage import SQLiteCheckpointStore
from agent_harness.tools import ToolContext, ToolRegistry, ToolValidationError, tool
from agent_harness.tracing import JsonlTracer


class ToolTests(unittest.TestCase):
    def test_typed_function_becomes_schema_and_validates(self) -> None:
        @tool(description="sample")
        def sample(count: int, label: str = "x", context: ToolContext | None = None) -> str:
            del context
            return label * count

        definition = sample.__tool_definition__
        self.assertEqual(definition.parameters["properties"]["count"]["type"], "integer")
        self.assertEqual(definition.parameters["required"], ["count"])
        with self.assertRaises(ToolValidationError):
            definition.validate({"count": "two"})


class HarnessFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="agent-harness-test-")
        self.runtime = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_refund_pauses_persists_and_resumes(self) -> None:
        runner = build_runner(runtime_dir=self.runtime)
        first = runner.run("订单 ORD-1001 延误，请退款")
        self.assertEqual(first.status, RunStatus.WAITING_APPROVAL)
        self.assertEqual(first.pending_approval.tool_call.name, "issue_refund")

        fresh_runner = build_runner(runtime_dir=self.runtime)
        final = fresh_runner.resume(first.run_id, approved=True, approver="test")
        self.assertEqual(final.status, RunStatus.COMPLETED)
        self.assertIn("退款已创建", final.output)

        stored = fresh_runner.inspect(first.run_id)
        tool_names = [message.name for message in stored.messages if message.role == "tool"]
        self.assertEqual(tool_names, ["get_order", "issue_refund", "notify_customer"])

    def test_rejected_refund_does_not_write(self) -> None:
        runner = build_runner(runtime_dir=self.runtime)
        first = runner.run("订单 ORD-1001 延误，请退款")
        final = runner.resume(first.run_id, approved=False, approver="risk-team")
        self.assertEqual(final.status, RunStatus.COMPLETED)
        self.assertIn("没有执行", final.output)

        with SupportDatabase(self.runtime / "business.db")._session() as connection:
            count = connection.execute("SELECT COUNT(*) FROM refunds").fetchone()[0]
        self.assertEqual(count, 0)

    def test_delivered_order_is_read_only(self) -> None:
        runner = build_runner(runtime_dir=self.runtime)
        result = runner.run("查看 ORD-1002 并退款")
        self.assertEqual(result.status, RunStatus.COMPLETED)
        self.assertIn("无需退款", result.output)

    def test_trace_redacts_contact_data(self) -> None:
        tracer = JsonlTracer(self.runtime / "trace.jsonl")
        tracer.emit("test", run_id="r1", email="person@example.com", phone="13812345678")
        text = (self.runtime / "trace.jsonl").read_text(encoding="utf-8")
        self.assertNotIn("person@example.com", text)
        self.assertNotIn("13812345678", text)

    def test_unknown_tool_is_returned_as_observation(self) -> None:
        class UnknownThenFinal:
            def complete(self, messages, tools):
                del tools
                if any(message.role == "tool" for message in messages):
                    envelope = json.loads(next(message.content for message in reversed(messages) if message.role == "tool"))
                    return ModelResponse(content=f"handled {envelope['error_type']}")
                return ModelResponse(tool_calls=[ToolCall(id="c1", name="missing", arguments={})])

        runner = AgentRunner(
            agent=Agent(name="test", instructions="test", tools=ToolRegistry()),
            provider=UnknownThenFinal(),
            store=SQLiteCheckpointStore(self.runtime / "runs.db"),
            tracer=JsonlTracer(self.runtime / "traces.jsonl"),
            policy=PolicyEngine(),
            config=RunnerConfig(max_steps=2),
        )
        result = runner.run("test")
        self.assertEqual(result.status, RunStatus.COMPLETED)
        self.assertEqual(result.output, "handled UnknownTool")

    def test_business_idempotency_prevents_double_refund(self) -> None:
        backend = SupportDatabase(self.runtime / "business.db")
        first = backend.issue_refund("ORD-1001", 299.0, "late", "run-a")
        second = backend.issue_refund("ORD-1001", 299.0, "late", "run-b")
        self.assertEqual(first["refund_id"], second["refund_id"])
        self.assertTrue(second["idempotent_replay"])

    def test_completed_session_can_continue(self) -> None:
        runner = build_runner(runtime_dir=self.runtime)
        first = runner.run("查看 ORD-1002", session_id="customer-7")
        self.assertEqual(first.status, RunStatus.COMPLETED)
        second = runner.run("再查看 ORD-9999", session_id="customer-7")
        self.assertEqual(second.status, RunStatus.COMPLETED)
        self.assertEqual(second.session_id, first.session_id)
        self.assertGreater(len(runner.inspect(second.run_id).messages), 4)

    def test_background_run_exposes_history_and_trace(self) -> None:
        runner = build_runner(runtime_dir=self.runtime)
        started = runner.run_background("查看 ORD-1002", session_id="web-session")
        self.assertEqual(started.status, RunStatus.RUNNING)
        deadline = time.monotonic() + 2
        stored = runner.inspect(started.run_id)
        while stored.status == RunStatus.RUNNING and time.monotonic() < deadline:
            time.sleep(0.02)
            stored = runner.inspect(started.run_id)
        self.assertEqual(stored.status, RunStatus.COMPLETED)
        self.assertEqual(runner.store.list_runs(1)[0].run_id, started.run_id)
        events = runner.tracer.read(started.run_id)
        self.assertEqual(events[0]["event"], "run.started")
        self.assertEqual(events[-1]["event"], "run.completed")


if __name__ == "__main__":
    unittest.main()
