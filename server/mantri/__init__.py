"""MANTRI - the reasoning layer (EPIC G).

Everything between the ingress guard and the action plan lives here, and nothing else
does. The package imports no FastAPI, opens no socket and holds no request state, so it
can be evaluated offline (`mantri.evals`) and tested with a scripted model.

    injection.py   G5  injection classifier + structural fencing
    router.py      G4  text-fast-path vs vision routing
    planner.py     G3  planner/grounder split, sub-goal cache
    recovery.py    G8  retry hints, ask_user policy, server-built stop plans
    exemplars.py   G2  six schema-valid few-shot exemplars
    prompts/       G1  redaction contract addenda + planner system prompt
    pipeline.py        the facade app/main.py calls
    evals/         G6/G7  task suite, scoring, prompt-variant runner, bake-off

The one dependency on the rest of the server is the PII predicate used to keep literals
out of sub-goals, and it is injected (`contains_pii=`) with a lazy default, so the
package stays importable on its own.
"""

from __future__ import annotations

from .exemplars import EXEMPLARS, Exemplar, as_messages
from .injection import (
    InjectionReport,
    Signal,
    Verdict,
    advisory,
    fence,
    screen_ssg,
    screen_text,
    serialize_untrusted,
)
from .pipeline import MantriConfig, MantriDecision, assemble_user_prompt, plan_step
from .planner import (
    PlannerConfig,
    SubGoal,
    SubGoalCache,
    TaskPlan,
    build_planner_prompt,
    needs_replan,
    page_signature,
    parse_task_plan,
)
from .prompts import grounder_system_prompt, planner_system_prompt
from .recovery import (
    RecoveryHint,
    ask_user_plan,
    fail_plan,
    hint_for_complaint,
    hints_from_history,
    should_ask_user,
    stalled_on,
)
from .router import Path, Route, RouterConfig, choose_route, escalate

__all__ = [
    "EXEMPLARS",
    "Exemplar",
    "InjectionReport",
    "MantriConfig",
    "MantriDecision",
    "Path",
    "PlannerConfig",
    "RecoveryHint",
    "Route",
    "RouterConfig",
    "Signal",
    "SubGoal",
    "SubGoalCache",
    "TaskPlan",
    "Verdict",
    "advisory",
    "as_messages",
    "ask_user_plan",
    "assemble_user_prompt",
    "build_planner_prompt",
    "choose_route",
    "escalate",
    "fail_plan",
    "fence",
    "grounder_system_prompt",
    "hint_for_complaint",
    "hints_from_history",
    "needs_replan",
    "page_signature",
    "parse_task_plan",
    "plan_step",
    "planner_system_prompt",
    "screen_ssg",
    "screen_text",
    "serialize_untrusted",
    "should_ask_user",
    "stalled_on",
]
