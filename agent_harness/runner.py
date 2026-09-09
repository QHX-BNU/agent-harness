from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from .models import Message, PendingApproval, RunResult, RunState, RunStatus, ToolCall
from .policy import PolicyEngine
from .providers import ModelProvider
from .storage import SQLiteCheckpointStore
from .tools import ToolContext, ToolError, ToolRegistry, ToolValidationError
from .tracing import JsonlTracer


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True, slots=True)
class Agent:
    name: str
    instructions: str
    tools: ToolRegistry


@dataclass(slots=True)
class RunnerConfig:
    max_steps: int = 8
    model_retries: int = 2
    retry_base_seconds: float = 0.15
    max_total_tokens: int | None = None


class AgentRunner:
    """Owns the model/tool loop, policies, durable pauses, and audit events."""

    def __init__(
        self,
        *,
        agent: Agent,
        provider: ModelProvider,
        store: SQLiteCheckpointStore,
        tracer: JsonlTracer,
        policy: PolicyEngine | None = None,
        config: RunnerConfig | None = None,
    ) -> None:
        self.agent = agent
        self.provider = provider
        self.store = store
        self.tracer = tracer
        self.policy = policy or PolicyEngine()
        self.config = config or RunnerConfig()
        self._locks_guard = threading.Lock()
        self._run_locks: dict[str, threading.RLock] = {}
        self._provider_lock = threading.Lock()

    def run(
        self,
        user_input: str,
        *,
        session_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RunResult:
        state = self._create_state(user_input, session_id=session_id, metadata=metadata)
        with self._run_lock(state.run_id):
            return self._loop(state)

    def run_background(
        self,
        user_input: str,
        *,
        session_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RunResult:
        """Persist a run immediately and continue it on a daemon worker thread."""
        state = self._create_state(user_input, session_id=session_id, metadata=metadata)
        initial = RunResult.from_state(state)
        worker = threading.Thread(
            target=self._run_state,
            args=(state,),
            name=f"agent-{state.run_id[-8:]}",
            daemon=True,
        )
        worker.start()
        return initial

    def set_provider(self, provider: ModelProvider) -> None:
        with self._provider_lock:
            self.provider = provider

    def provider_snapshot(self) -> ModelProvider:
        with self._provider_lock:
            return self.provider

    def resume(self, run_id: str, *, approved: bool, approver: str = "human") -> RunResult:
        with self._run_lock(run_id):
            state = self.store.load(run_id)
            if state.status != RunStatus.WAITING_APPROVAL or state.pending_approval is None:
                raise ValueError(f"run '{run_id}' is not waiting for approval")

            pending = state.pending_approval
            state.pending_approval = None
            state.status = RunStatus.RUNNING
            self.tracer.emit(
                "approval.resolved",
                run_id=run_id,
                approved=approved,
                approver=approver,
                tool=pending.tool_call.name,
            )
            if approved:
                self._execute_tool(state, pending.tool_call)
            else:
                self._append_tool_result(
                    state,
                    pending.tool_call,
                    ok=False,
                    error=f"operation rejected by {approver}",
                    error_type="ApprovalRejected",
                )

            remaining = list(state.remaining_tool_calls)
            state.remaining_tool_calls.clear()
            if remaining and not self._process_tool_calls(state, remaining):
                return RunResult.from_state(state)
            self._save(state)
            return self._loop(state)

    def inspect(self, run_id: str) -> RunState:
        return self.store.load(run_id)

    def _create_state(
        self,
        user_input: str,
        *,
        session_id: str | None,
        metadata: dict[str, Any] | None,
    ) -> RunState:
        if not user_input.strip():
            raise ValueError("user_input cannot be empty")
        timestamp = _now()
        resolved_session_id = session_id or f"session_{uuid4().hex}"
        messages = [Message(role="system", content=self.agent.instructions)]
        if session_id:
            previous = self.store.load_latest_session(session_id)
            if previous and previous.status in {RunStatus.RUNNING, RunStatus.WAITING_APPROVAL}:
                raise ValueError(f"session '{session_id}' already has an active run")
            if previous and previous.status == RunStatus.COMPLETED:
                messages = [Message.from_dict(message.to_dict()) for message in previous.messages]
        messages.append(Message(role="user", content=user_input))
        state = RunState(
            run_id=f"run_{uuid4().hex}",
            session_id=resolved_session_id,
            status=RunStatus.RUNNING,
            messages=messages,
            metadata=metadata or {},
            created_at=timestamp,
            updated_at=timestamp,
        )
        self.tracer.emit("run.started", run_id=state.run_id, session_id=state.session_id)
        self._save(state)
        return state

    def _run_state(self, state: RunState) -> None:
        with self._run_lock(state.run_id):
            self._loop(state)

    def _loop(self, state: RunState) -> RunResult:
        while state.step < self.config.max_steps:
            state.step += 1
            self.tracer.emit("model.started", run_id=state.run_id, step=state.step)
            try:
                response = self._call_model(state)
            except Exception as exc:
                state.status = RunStatus.FAILED
                state.error = f"model failed after retries: {exc}"
                self.tracer.emit("run.failed", run_id=state.run_id, error=state.error)
                self._save(state)
                return RunResult.from_state(state)

            response_tokens = response.usage.get("total_tokens")
            if response_tokens is None:
                response_tokens = response.usage.get("input_tokens", response.usage.get("prompt_tokens", 0))
                response_tokens += response.usage.get("output_tokens", response.usage.get("completion_tokens", 0))
            token_total = int(state.metadata.get("token_total", 0)) + int(response_tokens)
            state.metadata["token_total"] = token_total
            self.tracer.emit(
                "model.completed",
                run_id=state.run_id,
                step=state.step,
                tool_count=len(response.tool_calls),
                usage=response.usage,
            )
            if self.config.max_total_tokens is not None and token_total > self.config.max_total_tokens:
                state.status = RunStatus.FAILED
                state.error = f"token budget exceeded ({token_total}>{self.config.max_total_tokens})"
                self._save(state)
                return RunResult.from_state(state)

            state.messages.append(
                Message(role="assistant", content=response.content, tool_calls=response.tool_calls)
            )
            if response.tool_calls:
                if not self._process_tool_calls(state, response.tool_calls):
                    return RunResult.from_state(state)
                self._save(state)
                continue

            if not response.content:
                state.status = RunStatus.FAILED
                state.error = "model returned neither content nor tool calls"
                self._save(state)
                return RunResult.from_state(state)

            state.status = RunStatus.COMPLETED
            state.final_output = response.content
            self.tracer.emit("run.completed", run_id=state.run_id, steps=state.step)
            self._save(state)
            return RunResult.from_state(state)

        state.status = RunStatus.MAX_STEPS
        state.error = f"stopped after max_steps={self.config.max_steps}"
        self.tracer.emit("run.max_steps", run_id=state.run_id, steps=state.step)
        self._save(state)
        return RunResult.from_state(state)

    def _call_model(self, state: RunState):
        provider = self.provider_snapshot()
        last_error: Exception | None = None
        for attempt in range(self.config.model_retries + 1):
            try:
                return provider.complete(state.messages, self.agent.tools.schemas())
            except Exception as exc:
                last_error = exc
                if attempt < self.config.model_retries:
                    self.tracer.emit("model.retry", run_id=state.run_id, attempt=attempt + 1, error=str(exc))
                    time.sleep(self.config.retry_base_seconds * (2**attempt))
        assert last_error is not None
        raise last_error

    def _process_tool_calls(self, state: RunState, calls: list[ToolCall]) -> bool:
        for index, call in enumerate(calls):
            definition = self.agent.tools.get(call.name)
            if definition is None:
                self._append_tool_result(state, call, ok=False, error="unknown tool", error_type="UnknownTool")
                continue
            try:
                definition.validate(call.arguments)
            except ToolValidationError as exc:
                self._append_tool_result(state, call, ok=False, error=str(exc), error_type=type(exc).__name__)
                continue

            decision = self.policy.evaluate(call, definition, state)
            self.tracer.emit(
                "policy.checked",
                run_id=state.run_id,
                tool=call.name,
                allowed=decision.allowed,
                requires_approval=decision.requires_approval,
                reason=decision.reason,
            )
            if not decision.allowed:
                self._append_tool_result(state, call, ok=False, error=decision.reason, error_type="PolicyDenied")
                continue
            if decision.requires_approval:
                state.status = RunStatus.WAITING_APPROVAL
                state.pending_approval = PendingApproval(
                    tool_call=call,
                    reason=decision.reason,
                    requested_at=_now(),
                )
                state.remaining_tool_calls = list(calls[index + 1 :])
                self.tracer.emit(
                    "approval.requested",
                    run_id=state.run_id,
                    tool=call.name,
                    arguments=call.arguments,
                    reason=decision.reason,
                )
                self._save(state)
                return False
            self._execute_tool(state, call)
        return True

    def _execute_tool(self, state: RunState, call: ToolCall) -> None:
        definition = self.agent.tools.get(call.name)
        if definition is None:
            self._append_tool_result(state, call, ok=False, error="unknown tool", error_type="UnknownTool")
            return
        self.tracer.emit("tool.started", run_id=state.run_id, tool=call.name, arguments=call.arguments)
        started = time.perf_counter()
        try:
            result = definition.execute(
                call.arguments,
                ToolContext(run_id=state.run_id, session_id=state.session_id, metadata=state.metadata),
            )
        except ToolError as exc:
            self._append_tool_result(state, call, ok=False, error=str(exc), error_type=type(exc).__name__)
            self.tracer.emit(
                "tool.failed",
                run_id=state.run_id,
                tool=call.name,
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
                error=str(exc),
            )
            return
        self._append_tool_result(state, call, ok=True, result=result)
        self.tracer.emit(
            "tool.completed",
            run_id=state.run_id,
            tool=call.name,
            duration_ms=round((time.perf_counter() - started) * 1000, 2),
        )

    @staticmethod
    def _append_tool_result(
        state: RunState,
        call: ToolCall,
        *,
        ok: bool,
        result: Any = None,
        error: str | None = None,
        error_type: str | None = None,
    ) -> None:
        envelope: dict[str, Any] = {"ok": ok}
        if ok:
            envelope["result"] = result
        else:
            envelope.update({"error": error, "error_type": error_type})
        state.messages.append(
            Message(
                role="tool",
                name=call.name,
                tool_call_id=call.id,
                content=json.dumps(envelope, ensure_ascii=False, default=str),
            )
        )

    def _save(self, state: RunState) -> None:
        state.updated_at = _now()
        self.store.save(state)

    def _run_lock(self, run_id: str) -> threading.RLock:
        with self._locks_guard:
            return self._run_locks.setdefault(run_id, threading.RLock())
