"""Minimal extension example: add a typed tool and plug in a provider."""

from pathlib import Path

from agent_harness.models import ModelResponse
from agent_harness.runner import Agent, AgentRunner
from agent_harness.storage import SQLiteCheckpointStore
from agent_harness.tools import ToolRegistry, tool
from agent_harness.tracing import JsonlTracer


@tool(description="Return the inventory quantity for a product SKU.", side_effect="read")
def get_inventory(sku: str) -> dict[str, object]:
    return {"sku": sku, "available": 42}


class OneShotProvider:
    def complete(self, messages, tools):
        del messages, tools
        return ModelResponse(content="Replace OneShotProvider with your real model provider.")


registry = ToolRegistry()
registry.register(get_inventory)
runner = AgentRunner(
    agent=Agent(name="inventory", instructions="Answer inventory questions from tools.", tools=registry),
    provider=OneShotProvider(),
    store=SQLiteCheckpointStore(Path("runtime/custom.db")),
    tracer=JsonlTracer(Path("runtime/custom.jsonl")),
)
print(runner.run("How many SKU-42 items remain?").to_dict())
