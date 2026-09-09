from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .api import serve
from .application import build_runner
from .evals import run_evals
from .models import RunResult, RunStatus


def _print(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def _result_exit_code(result: RunResult) -> int:
    return 0 if result.status in {RunStatus.COMPLETED, RunStatus.WAITING_APPROVAL} else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-harness", description="Runnable agent runtime demo")
    parser.add_argument("--runtime-dir", default="runtime", help="checkpoint, business DB, and trace directory")
    subparsers = parser.add_subparsers(dest="command", required=True)

    demo = subparsers.add_parser("demo", help="run the complete offline approval demo")
    demo.add_argument("--input", default="订单 ORD-1001 物流延误了，请核实并退款")
    demo.add_argument("--deny", action="store_true", help="simulate a human rejection instead of approval")

    run = subparsers.add_parser("run", help="start one run")
    run.add_argument("input")
    run.add_argument("--provider", choices=["demo", "openai-compatible"], default=None)
    run.add_argument("--session-id")

    resume = subparsers.add_parser("resume", help="resolve a pending approval and continue")
    resume.add_argument("run_id")
    decision = resume.add_mutually_exclusive_group(required=True)
    decision.add_argument("--approve", action="store_true")
    decision.add_argument("--deny", action="store_true")
    resume.add_argument("--approver", default="cli-user")
    resume.add_argument("--provider", choices=["demo", "openai-compatible"], default=None)

    show = subparsers.add_parser("show", help="inspect a durable run")
    show.add_argument("run_id")

    subparsers.add_parser("eval", help="run the deterministic quality/safety eval set")

    server = subparsers.add_parser("serve", help="start the JSON HTTP API")
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8080)
    server.add_argument("--provider", choices=["demo", "openai-compatible"], default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    runtime_dir = Path(args.runtime_dir)

    if args.command == "eval":
        report = run_evals()
        _print(report)
        return 0 if report["passed"] == report["total"] else 1

    provider_name = getattr(args, "provider", None)
    try:
        runner = build_runner(runtime_dir=runtime_dir, provider_name=provider_name)
        if args.command == "demo":
            first = runner.run(args.input, metadata={"channel": "interview-demo"})
            print("\n[1/2] Agent 已暂停并返回审批请求：")
            _print(first.to_dict())
            if first.status == RunStatus.WAITING_APPROVAL:
                print(f"\n[2/2] 模拟人工{'拒绝' if args.deny else '批准'}后从检查点恢复：")
                final = runner.resume(first.run_id, approved=not args.deny, approver="interview-demo")
                _print(final.to_dict())
                return _result_exit_code(final)
            return _result_exit_code(first)
        if args.command == "run":
            result = runner.run(args.input, session_id=args.session_id)
            _print(result.to_dict())
            return _result_exit_code(result)
        if args.command == "resume":
            result = runner.resume(args.run_id, approved=args.approve, approver=args.approver)
            _print(result.to_dict())
            return _result_exit_code(result)
        if args.command == "show":
            _print(runner.inspect(args.run_id).to_dict())
            return 0
        if args.command == "serve":
            serve(runner, args.host, args.port)
            return 0
    except (ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 2
