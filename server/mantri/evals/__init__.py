"""MANTRI evaluation (tickets G6, G7).

    harness.py   the task suite, the scoring, the prompt-variant runner
    bakeoff.py   the same suite across several models, side by side
    tasks.json   the tasks themselves

Run it:

    python -m mantri.evals                       # full variant, configured model
    python -m mantri.evals --variant no-exemplars
    python -m mantri.evals --bakeoff qwen/qwen2.5-vl-7b-instruct,qwen/qwen2.5-vl-72b-instruct

Everything here needs `PRAHARI_LLM_API_KEY`, because a prompt evaluation against a
stubbed model measures the stub. The one exception is the harness's own test, which
drives it with a scripted model on purpose - to prove the harness can fail.
"""

from __future__ import annotations

from .harness import (
    SuiteReport,
    Task,
    TaskResult,
    Variant,
    config_for_variant,
    load_tasks,
    run_suite,
)

__all__ = [
    "SuiteReport",
    "Task",
    "TaskResult",
    "Variant",
    "config_for_variant",
    "load_tasks",
    "run_suite",
]
