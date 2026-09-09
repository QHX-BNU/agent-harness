from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class RunStatus(StrEnum):
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    COMPLETED = "completed"
    FAILED = "failed"
    MAX_STEPS = "max_steps"


@dataclass(slots=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ToolCall":
        return cls(id=data["id"], name=data["name"], arguments=data.get("arguments", {}))


@dataclass(slots=True)
class Message:
    role: str
    content: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None
    name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        return {key: value for key, value in data.items() if value not in (None, [], {})}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Message":
        calls = [ToolCall.from_dict(call) for call in data.get("tool_calls", [])]
        return cls(
            role=data["role"],
            content=data.get("content"),
            tool_calls=calls,
            tool_call_id=data.get("tool_call_id"),
            name=data.get("name"),
        )


@dataclass(slots=True)
class ModelResponse:
    content: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    raw: dict[str, Any] | None = None


@dataclass(slots=True)
class PendingApproval:
    tool_call: ToolCall
    reason: str
    requested_at: str

    def to_dict(self) -> dict[str, Any]:
        return {"tool_call": asdict(self.tool_call), "reason": self.reason, "requested_at": self.requested_at}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PendingApproval":
        return cls(
            tool_call=ToolCall.from_dict(data["tool_call"]),
            reason=data["reason"],
            requested_at=data["requested_at"],
        )


@dataclass(slots=True)
class RunState:
    run_id: str
    session_id: str
    status: RunStatus
    messages: list[Message]
    step: int = 0
    pending_approval: PendingApproval | None = None
    remaining_tool_calls: list[ToolCall] = field(default_factory=list)
    final_output: str | None = None
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "session_id": self.session_id,
            "status": self.status.value,
            "messages": [message.to_dict() for message in self.messages],
            "step": self.step,
            "pending_approval": self.pending_approval.to_dict() if self.pending_approval else None,
            "remaining_tool_calls": [asdict(call) for call in self.remaining_tool_calls],
            "final_output": self.final_output,
            "error": self.error,
            "metadata": self.metadata,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunState":
        pending = data.get("pending_approval")
        return cls(
            run_id=data["run_id"],
            session_id=data["session_id"],
            status=RunStatus(data["status"]),
            messages=[Message.from_dict(message) for message in data["messages"]],
            step=data.get("step", 0),
            pending_approval=PendingApproval.from_dict(pending) if pending else None,
            remaining_tool_calls=[ToolCall.from_dict(call) for call in data.get("remaining_tool_calls", [])],
            final_output=data.get("final_output"),
            error=data.get("error"),
            metadata=data.get("metadata", {}),
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
        )


@dataclass(slots=True)
class RunResult:
    run_id: str
    session_id: str
    status: RunStatus
    output: str | None = None
    pending_approval: PendingApproval | None = None
    error: str | None = None
    steps: int = 0

    @classmethod
    def from_state(cls, state: RunState) -> "RunResult":
        return cls(
            run_id=state.run_id,
            session_id=state.session_id,
            status=state.status,
            output=state.final_output,
            pending_approval=state.pending_approval,
            error=state.error,
            steps=state.step,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "session_id": self.session_id,
            "status": self.status.value,
            "output": self.output,
            "pending_approval": self.pending_approval.to_dict() if self.pending_approval else None,
            "error": self.error,
            "steps": self.steps,
        }
