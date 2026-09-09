from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .models import RunState, ToolCall
from .tools import ToolDefinition


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    allowed: bool = True
    requires_approval: bool = False
    reason: str = "allowed by policy"


PolicyRule = Callable[[ToolCall, ToolDefinition, RunState], PolicyDecision | None]


class PolicyEngine:
    """Deterministic authorization layer; the model never grants its own permission."""

    def __init__(self, rules: list[PolicyRule] | None = None, blocked_tools: set[str] | None = None) -> None:
        self.rules = rules or []
        self.blocked_tools = blocked_tools or set()

    def evaluate(self, call: ToolCall, definition: ToolDefinition, state: RunState) -> PolicyDecision:
        if call.name in self.blocked_tools:
            return PolicyDecision(allowed=False, reason=f"tool '{call.name}' is blocked")
        if definition.requires_approval:
            return PolicyDecision(requires_approval=True, reason=f"tool '{call.name}' always requires approval")
        for rule in self.rules:
            decision = rule(call, definition, state)
            if decision is not None and (not decision.allowed or decision.requires_approval):
                return decision
        return PolicyDecision()


def refund_limit_rule(limit: float = 200.0) -> PolicyRule:
    def evaluate(call: ToolCall, definition: ToolDefinition, state: RunState) -> PolicyDecision | None:
        del definition, state
        if call.name == "issue_refund" and float(call.arguments.get("amount", 0)) >= limit:
            return PolicyDecision(
                requires_approval=True,
                reason=f"refund amount reaches the manual-review threshold ({limit:.2f})",
            )
        return None

    return evaluate

