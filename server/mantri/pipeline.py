"""The MANTRI facade: one screen in, one action plan out.

    screen  ->  injection screen  ->  route  ->  sub-goal  ->  prompt
            ->  model             ->  post-validate        ->  plan | recovery

`app/main.py` calls `plan_step` and does nothing else with reasoning. Everything the
model sees is assembled here, in one place, in a fixed order, so that "what exactly did
we send" has a single answer.

## Order is a security property, not a style choice

The injection screen runs **before** the prompt is built, so its advisory can be placed
in the trusted half. The sub-goal is resolved **before** the grounder prompt, so the
grounder's screen budget is spent on the screen. Post-validation runs **after** every
attempt including the last, so no path exists that returns an unvalidated plan. The
recovery plan is synthesised **without the model**, so the loop can always stop cleanly.

## What this module does NOT do

It does not decide whether the payload was safe to receive: the ingress guard did that,
before this code ran, and a screen that reaches `plan_step` has already been checked for
PII. It does not enforce risk on the client's behalf either. Everything asserted here is
asserted again by HASTA on the user's machine, because a compromised server must not be
able to do harm (ARCHITECTURE.md 11.1).
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .exemplars import as_messages
from .injection import InjectionReport, Verdict, advisory, screen_ssg
from .planner import (
    PlannerConfig,
    SubGoalCache,
    TaskPlan,
    build_planner_prompt,
    needs_replan,
    parse_task_plan,
)
from .prompts import grounder_system_prompt, planner_system_prompt
from .recovery import ask_user_plan, hints_from_history, should_ask_user
from .router import Path, Route, RouterConfig, choose_route, escalate

__all__ = ["MantriConfig", "MantriDecision", "plan_step", "assemble_user_prompt"]


class Completion(Protocol):
    """The slice of `app.llm.client.LlmClient` MANTRI needs.

    A Protocol rather than the class itself: the eval harness and every test in
    `tests/test_mantri_*.py` drive this pipeline with a scripted stand-in, and a
    reasoning layer that can only be exercised against a live paid endpoint is a
    reasoning layer nobody exercises.
    """

    async def complete(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
        validate: Any,
        image_data_url: str | None = ...,
        examples: list[dict[str, Any]] | None = ...,
        model: str | None = ...,
    ) -> Any: ...


@dataclass(frozen=True)
class MantriConfig:
    planner: PlannerConfig = field(default_factory=PlannerConfig)
    router: RouterConfig = field(default_factory=RouterConfig)
    exemplar_limit: int | None = 6
    # Ablatable so the eval harness can measure what the advisory actually buys
    # (`--variant no-advisory`). Shipping default is on.
    include_advisory: bool = True
    # A hostile screen is planned for anyway - refusing to act would let any page
    # disable the agent by printing an attack at it - but it is planned for with the
    # advisory in place and the event recorded.
    refuse_on_hostile: bool = False


@dataclass
class MantriDecision:
    """Everything the server needs to answer, log and measure one step."""

    plan: dict[str, Any]
    route: Route
    injection: InjectionReport
    task_plan: TaskPlan | None
    subgoal_text: str
    attempts: int
    mode: str
    recovered: bool
    planner_called: bool
    replan_reason: str
    latency_ms: int
    # Set when the planner's latency budget was spent before it answered. Counted
    # rather than described: an optimisation that quietly costs a second is one
    # somebody has to be able to see.
    planner_timed_out: bool = False
    # Set when the text fast path produced no groundable plan and the step was retried
    # on the vision model (ticket G4's `escalate`).
    escalated: bool = False

    def to_log(self) -> dict[str, Any]:
        """Value-free by construction: paths, counts and verdicts only."""
        return {
            "route": self.route.path.value,
            "model": self.route.model,
            "route_reason": self.route.reason,
            "injection": self.injection.to_log(),
            "subgoals": len(self.task_plan.subgoals) if self.task_plan else 0,
            "subgoal_index": self.task_plan.cursor if self.task_plan else None,
            "planner_called": self.planner_called,
            "replan": self.replan_reason,
            "attempts": self.attempts,
            "mode": self.mode,
            "recovered": self.recovered,
            "planner_timed_out": self.planner_timed_out,
            "escalated": self.escalated,
            "latency_ms": self.latency_ms,
        }


def assemble_user_prompt(
    base_prompt: str,
    *,
    task_plan: TaskPlan | None,
    injection: InjectionReport,
    history: list[Any] | None,
    request_visual: bool,
    include_advisory: bool = True,
) -> str:
    """Wraps the grounder's screen prompt in MANTRI's per-step context.

    The plan, the security notice and the recovery notes go ABOVE the fenced screen.
    Everything above the fence is ours; everything below it is the page's. Putting a
    recovery note below the fence would let a page that quoted it back appear to be
    issuing one.
    """
    blocks: list[str] = []

    if task_plan is not None and task_plan.active is not None:
        blocks.append(
            "## Plan\n"
            + task_plan.render()
            + "\n\nWork on the step marked [NOW]."
        )

    note = advisory(injection) if include_advisory else ""
    if note:
        blocks.append("## Security\n" + note)

    hints = hints_from_history(history)
    if hints:
        blocks.append(
            "## Recovery\n" + "\n".join("- " + h.text for h in hints)
        )

    if request_visual:
        blocks.append(
            "## Perception\n"
            "The structural description of this screen is incomplete and no screenshot "
            "was attached. Do not guess at what is missing: act only on what is listed, "
            "and set `need_visual: true` so the next step arrives with an image."
        )

    if not blocks:
        return base_prompt
    return "\n\n".join(blocks) + "\n\n" + base_prompt


async def _run_planner(
    ssg: dict[str, Any],
    llm: Completion,
    route: Route,
    contains_pii: Callable[[str], bool] | None,
    *,
    timeout_s: float | None = None,
) -> tuple[TaskPlan | None, bool]:
    """One planner round trip, bounded. Returns `(plan, timed_out)`.

    Failure is survivable, so it is swallowed. If planning fails - bad JSON, a sub-goal
    with a literal in it, the endpoint down - the step continues without a plan. The
    grounder worked without one for the whole of P1 and still does; losing the token
    saving is not worth losing the step.

    The bound is the point: this is the step's *second* round trip, and it is the one
    the user is not waiting for anything visible from. Left unbounded it doubles the
    step on a slow endpoint, which is the whole latency budget spent on an optimisation.
    `timeout_s <= 0` disables the bound, for a test that wants determinism.
    """
    from .planner import PLANNER_SCHEMA

    def validate(raw: dict[str, Any]) -> str | None:
        try:
            parse_task_plan(raw, ssg, contains_pii=contains_pii)
        except ValueError as exc:
            return str(exc)
        return None

    call = llm.complete(
        system=planner_system_prompt(),
        user=build_planner_prompt(ssg),
        schema=PLANNER_SCHEMA,
        validate=validate,
        model=route.model,
    )

    try:
        if timeout_s and timeout_s > 0:
            result = await asyncio.wait_for(call, timeout_s)
        else:
            result = await call
        return parse_task_plan(result.plan, ssg, contains_pii=contains_pii), False
    except (asyncio.TimeoutError, TimeoutError):
        return None, True
    except Exception:  # noqa: BLE001 - see docstring: planning is best-effort
        return None, False


async def plan_step(
    ssg: dict[str, Any],
    *,
    llm: Completion,
    action_plan_schema: dict[str, Any],
    build_user_prompt: Callable[[dict[str, Any]], str],
    make_validator: Callable[[dict[str, Any]], Callable[[dict[str, Any]], str | None]],
    cache: SubGoalCache,
    config: MantriConfig | None = None,
    image_data_url: str | None = None,
    contains_pii: Callable[[str], bool] | None = None,
) -> MantriDecision:
    """Plans one step. Raises only what the caller must turn into a 5xx."""
    cfg = config or MantriConfig()
    started = time.monotonic()

    session_id = str(ssg.get("session_id") or ssg.get("trace_id") or "anonymous")
    history = list(ssg.get("history") or [])

    # 1. injection screen -----------------------------------------------------
    injection = screen_ssg(ssg)

    # 2. route ----------------------------------------------------------------
    route = choose_route(
        ssg, has_image=image_data_url is not None, config=cfg.router
    )

    # 3. sub-goal -------------------------------------------------------------
    cached = cache.get(session_id)
    replan, reason = needs_replan(cached, ssg, config=cfg.planner)
    planner_called = False
    planner_timed_out = False
    task_plan = cached

    if replan:
        planner_called = True
        fresh, planner_timed_out = await _run_planner(
            ssg, llm, route, contains_pii, timeout_s=cfg.planner.timeout_s
        )
        if fresh is not None:
            task_plan = fresh
            cache.put(session_id, fresh)
        elif cached is not None and cached.goal == (ssg.get("goal") or ""):
            # Keep a stale-but-relevant plan rather than dropping to none.
            task_plan = cached
        else:
            task_plan = None

    # A step that reported progress moves the cursor on. Coarse - the grounder does not
    # tell us which sub-goal it advanced - but wrong in the recoverable direction: the
    # prompt tells the model to skip a sub-goal that is already satisfied.
    if (
        task_plan is not None
        and not planner_called
        and history
        and isinstance(history[-1], dict)
        and history[-1].get("outcome") == "advanced"
    ):
        task_plan = task_plan.advance()
        cache.put(session_id, task_plan)

    # 4. prompt ---------------------------------------------------------------
    user_prompt = assemble_user_prompt(
        build_user_prompt(ssg),
        task_plan=task_plan,
        injection=injection,
        history=history,
        request_visual=route.request_visual,
        include_advisory=cfg.include_advisory,
    )

    # 5. model ----------------------------------------------------------------
    validator = make_validator(ssg)

    async def _ground(on: Route) -> Any:
        return await llm.complete(
            system=grounder_system_prompt(),
            user=user_prompt,
            schema=action_plan_schema,
            validate=validator,
            image_data_url=image_data_url if on.attach_image else None,
            examples=as_messages(cfg.exemplar_limit),
            model=on.model,
        )

    escalated = False
    try:
        result = await _ground(route)
    except Exception as exc:  # noqa: BLE001 - re-raised unless it is worth a second look
        why = _worth_looking(exc)
        if why is None or not _can_escalate(route, cfg.router):
            raise
        # The text description named a control the client cannot resolve, or a
        # reference that is not on the screen. That is usually the description being
        # wrong rather than the model being stupid, and looking is the cheapest way to
        # find out (ticket G4, `router.escalate`).
        route = escalate(route, why, config=cfg.router)
        escalated = True
        if route.request_visual:
            # The prompt told the model nothing was missing; on the retry it is.
            user_prompt = assemble_user_prompt(
                build_user_prompt(ssg),
                task_plan=task_plan,
                injection=injection,
                history=history,
                request_visual=True,
                include_advisory=cfg.include_advisory,
            )
        result = await _ground(route)

    plan = dict(result.plan)
    attempts = int(getattr(result, "attempts", 1))
    mode = getattr(getattr(result, "mode", None), "value", "unknown")
    recovered = False

    # 6. recovery -------------------------------------------------------------
    # The model succeeded - the ladder in llm/client.py would have raised otherwise -
    # but "succeeded" can still mean "returned a plan on a page that has refused to
    # move twice". The policy replaces it with a question rather than executing a
    # third identical click.
    if should_ask_user(history, attempts=attempts) and not plan.get("done"):
        target, count = _stall(history)
        plan = ask_user_plan(
            ssg,
            question=(
                "I have tried "
                + str(count)
                + " times and the page has not changed. Would you like me to keep "
                "going, or would you rather take over from here?"
            ),
            options=["Keep going", "I'll take over"],
        )
        recovered = True

    if route.request_visual and not recovered:
        plan.setdefault("need_visual", True)

    return MantriDecision(
        plan=plan,
        route=route,
        injection=injection,
        task_plan=task_plan,
        subgoal_text=task_plan.active.text if task_plan and task_plan.active else "",
        attempts=attempts,
        mode=mode,
        recovered=recovered,
        planner_called=planner_called,
        replan_reason=reason,
        latency_ms=int((time.monotonic() - started) * 1000),
        planner_timed_out=planner_timed_out,
        escalated=escalated,
    )


# Validator complaints that mean "the screen description may be wrong", as opposed to
# "the model wrote bad JSON". Matched on `LlmError.complaint` when the client set one,
# and on the message otherwise - MANTRI does not import the client, so it reads the
# exception structurally rather than by type (see the `Completion` protocol).
_LOOK_AGAIN: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"is not on this screen", re.I), "target was not on the screen"),
    (
        re.compile(r"does not appear on this screen", re.I),
        "reference was not on the screen",
    ),
)


def _worth_looking(exc: Exception) -> str | None:
    """Why this failure might be explained by a screenshot - or None to re-raise.

    A transport failure carries no complaint and matches nothing here, which is the
    behaviour we want: escalating a dead endpoint to a second dead endpoint spends the
    user's latency budget to learn nothing.
    """
    complaint = getattr(exc, "complaint", None)
    text = complaint if isinstance(complaint, str) and complaint else str(exc)
    for pattern, why in _LOOK_AGAIN:
        if pattern.search(text):
            return why
    return None


def _can_escalate(route: Route, config: RouterConfig) -> bool:
    """Whether there is anywhere to escalate *to*.

    Not when we are already on vision, and not when the two models are the same id -
    `RouterConfig.text_model` falls back to the vision model on a single-endpoint
    deployment, and re-asking the same model the same question is a repeat, not a
    retry.
    """
    if route.is_vision:
        return False
    return route.model != config.vision_model


def _stall(history: list[Any]) -> tuple[str | None, int]:
    from .recovery import stalled_on

    return stalled_on(history)


def hostile_and_refused(decision: MantriDecision, config: MantriConfig) -> bool:
    """Whether the step should have been refused outright for hostility.

    Off by default and documented as such: a page that could stop the agent by printing
    an attack at it would be a denial-of-service primitive handed to every website. The
    flag exists because a deployment with a stricter posture may want it.
    """
    return config.refuse_on_hostile and decision.injection.verdict is Verdict.HOSTILE


def route_name(route: Route) -> str:
    return Path(route.path).value
