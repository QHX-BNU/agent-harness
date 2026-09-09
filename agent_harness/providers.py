from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol, Sequence
from uuid import uuid4

from .models import Message, ModelResponse, ToolCall


class ModelProvider(Protocol):
    def complete(self, messages: Sequence[Message], tools: list[dict[str, Any]]) -> ModelResponse: ...


class ProviderError(RuntimeError):
    """A retryable or terminal model-provider failure."""


@dataclass(slots=True)
class OpenAICompatibleProvider:
    """Minimal Chat Completions adapter for OpenAI-compatible endpoints."""

    model: str
    api_key: str
    base_url: str = "https://api.openai.com/v1"
    timeout_seconds: float = 60.0

    @classmethod
    def from_env(cls) -> "OpenAICompatibleProvider":
        api_key = os.getenv("OPENAI_API_KEY", "")
        model = os.getenv("OPENAI_MODEL", "")
        if not api_key or not model:
            raise ValueError("OPENAI_API_KEY and OPENAI_MODEL are required")
        return cls(
            model=model,
            api_key=api_key,
            base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
        )

    def complete(self, messages: Sequence[Message], tools: list[dict[str, Any]]) -> ModelResponse:
        payload = {
            "model": self.model,
            "messages": [self._message(message) for message in messages],
            "tools": [{"type": "function", "function": schema} for schema in tools],
            "tool_choice": "auto",
        }
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
            raise ProviderError(f"model request failed: {exc}") from exc

        try:
            message = body["choices"][0]["message"]
            calls = []
            for item in message.get("tool_calls", []):
                arguments = item["function"].get("arguments", "{}")
                calls.append(
                    ToolCall(
                        id=item.get("id", f"call_{uuid4().hex[:12]}"),
                        name=item["function"]["name"],
                        arguments=json.loads(arguments) if isinstance(arguments, str) else arguments,
                    )
                )
            usage = {key: int(value) for key, value in body.get("usage", {}).items() if isinstance(value, int)}
            return ModelResponse(content=message.get("content"), tool_calls=calls, usage=usage, raw=body)
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise ProviderError(f"unexpected model response: {exc}") from exc

    @staticmethod
    def _message(message: Message) -> dict[str, Any]:
        data: dict[str, Any] = {"role": message.role, "content": message.content or ""}
        if message.tool_calls:
            data["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": json.dumps(call.arguments, ensure_ascii=False)},
                }
                for call in message.tool_calls
            ]
        if message.tool_call_id:
            data["tool_call_id"] = message.tool_call_id
        if message.name:
            data["name"] = message.name
        return data


class DemoSupportProvider:
    """Deterministic offline provider that exercises the same agent loop as an LLM."""

    def complete(self, messages: Sequence[Message], tools: list[dict[str, Any]]) -> ModelResponse:
        del tools
        last_user_index = max((index for index, message in enumerate(messages) if message.role == "user"), default=-1)
        current_turn = messages[last_user_index + 1 :]
        last_tool = next((message for message in reversed(current_turn) if message.role == "tool"), None)
        if last_tool is None:
            user_text = next((message.content or "" for message in reversed(messages) if message.role == "user"), "")
            match = re.search(r"ORD-\d+", user_text.upper())
            order_id = match.group(0) if match else "ORD-1001"
            return self._call("get_order", {"order_id": order_id})

        try:
            result = json.loads(last_tool.content or "{}")
        except json.JSONDecodeError:
            return ModelResponse(content="工具返回了无法解析的数据，已停止自动操作并建议人工处理。")

        if last_tool.name == "get_order":
            if not result.get("ok"):
                return ModelResponse(content="没有找到该订单。我没有执行任何写操作，建议核对订单号后重试。")
            order = result["result"]
            if order["status"] == "delayed":
                return self._call(
                    "issue_refund",
                    {
                        "order_id": order["order_id"],
                        "amount": order["amount"],
                        "reason": "物流超过承诺时效",
                    },
                )
            return ModelResponse(content=f"订单 {order['order_id']} 当前状态为 {order['status']}，无需退款。")

        if last_tool.name == "issue_refund":
            if result.get("ok"):
                refund = result["result"]
                return self._call(
                    "notify_customer",
                    {
                        "order_id": refund["order_id"],
                        "message": f"退款 {refund['amount']:.2f} 元已受理，退款单号 {refund['refund_id']}。",
                    },
                )
            return ModelResponse(content=f"退款没有执行：{result.get('error', '未知错误')}。")

        if last_tool.name == "notify_customer":
            return ModelResponse(content="订单已核验，退款已创建，并已向客户发送结果通知。")

        return ModelResponse(content="任务已处理完成。")

    @staticmethod
    def _call(name: str, arguments: dict[str, Any]) -> ModelResponse:
        return ModelResponse(tool_calls=[ToolCall(id=f"call_{uuid4().hex[:12]}", name=name, arguments=arguments)])
