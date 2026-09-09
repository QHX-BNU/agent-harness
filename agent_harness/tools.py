from __future__ import annotations

import inspect
import types
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Union, get_args, get_origin, get_type_hints


class ToolError(RuntimeError):
    pass


class ToolValidationError(ToolError):
    pass


class ToolTimeoutError(ToolError):
    pass


@dataclass(slots=True)
class ToolContext:
    run_id: str
    session_id: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ToolDefinition:
    name: str
    description: str
    function: Callable[..., Any]
    parameters: dict[str, Any]
    side_effect: Literal["none", "read", "write"] = "none"
    requires_approval: bool = False
    timeout_seconds: float = 10.0
    max_retries: int = 0
    idempotent: bool = False
    context_parameter: str | None = None

    def schema(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "parameters": self.parameters}

    def execute(self, arguments: dict[str, Any], context: ToolContext) -> Any:
        self.validate(arguments)
        kwargs = dict(arguments)
        if self.context_parameter:
            kwargs[self.context_parameter] = context

        attempts = 1 + (self.max_retries if self.side_effect != "write" or self.idempotent else 0)
        last_error: Exception | None = None
        for _ in range(attempts):
            executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"tool-{self.name}")
            future = executor.submit(self.function, **kwargs)
            try:
                value = future.result(timeout=self.timeout_seconds)
                executor.shutdown(wait=True)
                return value
            except FutureTimeoutError as exc:
                future.cancel()
                executor.shutdown(wait=False, cancel_futures=True)
                last_error = ToolTimeoutError(f"tool '{self.name}' exceeded {self.timeout_seconds}s")
            except Exception as exc:  # Tool failures become data for the agent loop.
                executor.shutdown(wait=True)
                last_error = exc
        assert last_error is not None
        if isinstance(last_error, ToolError):
            raise last_error
        raise ToolError(f"tool '{self.name}' failed: {last_error}") from last_error

    def validate(self, arguments: dict[str, Any]) -> None:
        if not isinstance(arguments, dict):
            raise ToolValidationError("tool arguments must be a JSON object")
        properties = self.parameters.get("properties", {})
        unknown = set(arguments) - set(properties)
        missing = set(self.parameters.get("required", [])) - set(arguments)
        if unknown:
            raise ToolValidationError(f"unexpected arguments: {', '.join(sorted(unknown))}")
        if missing:
            raise ToolValidationError(f"missing arguments: {', '.join(sorted(missing))}")
        for name, value in arguments.items():
            expected = properties[name].get("type")
            if expected and not _matches_json_type(value, expected):
                raise ToolValidationError(f"argument '{name}' must be {expected}")


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

    def register(self, definition: ToolDefinition | Callable[..., Any]) -> ToolDefinition:
        item = definition if isinstance(definition, ToolDefinition) else getattr(definition, "__tool_definition__", None)
        if item is None:
            raise TypeError("register a ToolDefinition or a function decorated with @tool")
        if item.name in self._tools:
            raise ValueError(f"duplicate tool name: {item.name}")
        self._tools[item.name] = item
        return item

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    def schemas(self) -> list[dict[str, Any]]:
        return [item.schema() for item in self._tools.values()]

    def __iter__(self):
        return iter(self._tools.values())


def tool(
    *,
    description: str,
    name: str | None = None,
    side_effect: Literal["none", "read", "write"] = "none",
    requires_approval: bool = False,
    timeout_seconds: float = 10.0,
    max_retries: int = 0,
    idempotent: bool = False,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorate a typed function and attach an LLM-compatible JSON schema."""

    def decorate(function: Callable[..., Any]) -> Callable[..., Any]:
        signature = inspect.signature(function)
        hints = get_type_hints(function)
        properties: dict[str, Any] = {}
        required: list[str] = []
        context_parameter: str | None = None
        for parameter_name, parameter in signature.parameters.items():
            annotation = hints.get(parameter_name, Any)
            if annotation is ToolContext:
                context_parameter = parameter_name
                continue
            properties[parameter_name] = _json_schema(annotation)
            if parameter.default is inspect.Parameter.empty and not _is_optional(annotation):
                required.append(parameter_name)
            elif parameter.default is not inspect.Parameter.empty:
                properties[parameter_name]["default"] = parameter.default
        definition = ToolDefinition(
            name=name or function.__name__,
            description=description,
            function=function,
            parameters={"type": "object", "properties": properties, "required": required, "additionalProperties": False},
            side_effect=side_effect,
            requires_approval=requires_approval,
            timeout_seconds=timeout_seconds,
            max_retries=max_retries,
            idempotent=idempotent,
            context_parameter=context_parameter,
        )
        setattr(function, "__tool_definition__", definition)
        return function

    return decorate


def _is_optional(annotation: Any) -> bool:
    origin = get_origin(annotation)
    return origin in (Union, types.UnionType) and type(None) in get_args(annotation)


def _json_schema(annotation: Any) -> dict[str, Any]:
    origin = get_origin(annotation)
    args = get_args(annotation)
    if annotation is Any:
        return {}
    if origin is Literal:
        values = list(args)
        schema: dict[str, Any] = {"enum": values}
        if values:
            schema["type"] = _primitive_type(type(values[0]))
        return schema
    if origin in (Union, types.UnionType):
        non_null = [arg for arg in args if arg is not type(None)]
        if len(non_null) == 1:
            return _json_schema(non_null[0])
        return {"anyOf": [_json_schema(arg) for arg in non_null]}
    if origin in (list, tuple, set):
        return {"type": "array", "items": _json_schema(args[0] if args else Any)}
    if origin is dict:
        return {"type": "object", "additionalProperties": _json_schema(args[1] if len(args) > 1 else Any)}
    return {"type": _primitive_type(annotation)}


def _primitive_type(annotation: Any) -> str:
    return {str: "string", int: "integer", float: "number", bool: "boolean", dict: "object", list: "array"}.get(annotation, "string")


def _matches_json_type(value: Any, expected: str) -> bool:
    checks = {
        "string": lambda item: isinstance(item, str),
        "integer": lambda item: isinstance(item, int) and not isinstance(item, bool),
        "number": lambda item: isinstance(item, (int, float)) and not isinstance(item, bool),
        "boolean": lambda item: isinstance(item, bool),
        "object": lambda item: isinstance(item, dict),
        "array": lambda item: isinstance(item, list),
        "null": lambda item: item is None,
    }
    return checks.get(expected, lambda _: True)(value)

