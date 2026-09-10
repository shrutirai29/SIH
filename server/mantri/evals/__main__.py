"""CLI for the MANTRI eval suite (tickets G6, G7).

    python -m mantri.evals
    python -m mantri.evals --variant no-exemplars --json docs/metrics/g7-no-exemplars.json
    python -m mantri.evals --bakeoff qwen/qwen2.5-vl-7b-instruct,qwen/qwen2.5-vl-72b-instruct

Needs `PRAHARI_LLM_API_KEY`. This imports from `app` - the schema, the prompt builder,
the post-validator and the PII pack - so that the suite measures **the code the server
runs**, not a copy of it that has drifted.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from app.agents.grounder import build_user_prompt, make_validator
from app.guards.ingress_pii import contains_pii
from app.llm.client import LlmClient, LlmConfig
from app.main import ACTION_PLAN_SCHEMA, _plan_schema_validate

from .bakeoff import render_bakeoff, run_bakeoff
from .harness import Variant, load_tasks, run_suite


def _validator(ssg: dict[str, Any]) -> Any:
    return make_validator(ssg, _plan_schema_validate)


def _client(model: str | None = None) -> LlmClient:
    config = LlmConfig()
    if model:
        config.model = model
    return LlmClient(config)


def _load_env() -> str:
    """Reads `server/.env`, if there is one. Returns a note for the reader.

    Loaded here rather than on `import app`, deliberately: `tests/test_agent_eval.py`
    makes a real, paid call whenever `PRAHARI_LLM_API_KEY` is present, so a `.env`
    that loaded itself on import would turn every `pytest` run into a bill. An entry
    point that exists to call a provider is the right place to read one.

    Shell environment wins over the file - `os.environ` is not overwritten - so
    `--model` and an exported key still behave the way they always did.
    """
    env_file = Path(__file__).resolve().parents[2] / ".env"
    if not env_file.exists():
        return ""
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - python-dotenv ships with uvicorn[standard]
        return f"found {env_file.name} but python-dotenv is not installed; ignoring it"
    load_dotenv(env_file, override=False)
    return f"loaded {env_file}"


async def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="mantri.evals")
    parser.add_argument(
        "--variant",
        default=Variant.FULL.value,
        choices=[v.value for v in Variant],
        help="which prompt configuration to test (ablations answer 'is this part worth it')",
    )
    parser.add_argument("--model", default=None, help="override PRAHARI_LLM_MODEL")
    parser.add_argument(
        "--bakeoff",
        default=None,
        help="comma-separated model ids to compare on the same suite (G6)",
    )
    parser.add_argument("--json", dest="json_out", default=None, help="write the report as JSON")
    parser.add_argument("--task", default=None, help="run one task id")
    args = parser.parse_args(argv)

    note = _load_env()

    client = _client(args.model)
    if not client.config.configured:
        print(
            "PRAHARI_LLM_API_KEY is not set. The suite evaluates a model; running "
            "it without one would measure nothing. Put the key in server/.env (copy "
            "server/.env.example), or export it in this shell. "
            + (note or "No server/.env found."),
            file=sys.stderr,
        )
        return 2

    variant = Variant(args.variant)

    if args.bakeoff:
        models = [m.strip() for m in args.bakeoff.split(",") if m.strip()]
        rows = await run_bakeoff(
            models,
            llm_factory=_client,
            action_plan_schema=ACTION_PLAN_SCHEMA,
            build_user_prompt=build_user_prompt,
            make_validator=_validator,
            contains_pii=contains_pii,
            variant=variant,
        )
        print(render_bakeoff(rows))
        if args.json_out:
            Path(args.json_out).write_text(
                json.dumps(
                    {"variant": variant.value, "models": [r.report.to_json() for r in rows]},
                    indent=2,
                ),
                encoding="utf-8",
            )
        return 0

    tasks = load_tasks()
    if args.task:
        tasks = [t for t in tasks if t.id == args.task]
        if not tasks:
            print(f"no task with id {args.task}", file=sys.stderr)
            return 2

    report = await run_suite(
        client,
        action_plan_schema=ACTION_PLAN_SCHEMA,
        build_user_prompt=build_user_prompt,
        make_validator=_validator,
        contains_pii=contains_pii,
        variant=variant,
        model=client.config.model,
        tasks=tasks,
    )
    print(report.render())
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(report.to_json(), indent=2), encoding="utf-8")

    # Non-zero on any failure, so a CI job can gate on the suite once it is green.
    # An incomplete run exits 3, distinctly: "the model got things wrong" and "the
    # suite never ran" are different outcomes, and a caller that cannot tell them
    # apart will eventually record the second as the first.
    if not report.complete:
        print(
            "This run did not finish, so it is not a result. Nothing here should be "
            "quoted as a score. Fix the provider error and run it again.",
            file=sys.stderr,
        )
        return 3
    return 0 if report.passed == report.total else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main(sys.argv[1:])))
