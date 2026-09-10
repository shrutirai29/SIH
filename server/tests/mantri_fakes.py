"""A scripted stand-in for the model, shared by the MANTRI tests.

The pipeline's whole job is what happens *around* a model call: what we put in front of
it, what we do with what comes back, and what we do when it is wrong. All of that is
testable without a network, and it should be - a reasoning layer whose tests need a
paid endpoint is a reasoning layer that gets tested once.

`ScriptedLlm` records every call, so a test can assert on the prompt that was actually
assembled, which is the only way to prove the fence, the advisory and the sub-goal block
ended up where they were supposed to.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Call:
    system: str
    user: str
    examples: list[dict[str, Any]] | None
    image_data_url: str | None
    model: str | None


@dataclass
class Result:
    plan: dict[str, Any]
    attempts: int = 1
    mode: Any = None


class _Mode:
    value = "scripted"


@dataclass
class ScriptedLlm:
    """Returns queued plans in order; repeats the last one when the queue runs dry."""

    plans: list[dict[str, Any]] = field(default_factory=list)
    calls: list[Call] = field(default_factory=list)
    attempts: int = 1
    raise_on_call: Exception | None = None
    # Set to run the pipeline's own validator over each scripted plan, so a test can
    # prove post-validation rejects what it claims to reject.
    enforce_validator: bool = False
    # Errors raised by the *grounder* calls, one per call, in order; `None` means that
    # call succeeds. This is how a test drives the escalation path, which only exists
    # because the first grounder call can fail in a way a second one might not.
    grounder_errors: list[Exception | None] = field(default_factory=list)
    # Seconds the *planner* call takes. The planner runs under a latency budget, and a
    # budget nobody has seen expire is a budget nobody should quote.
    planner_delay_s: float = 0.0

    async def complete(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
        validate: Any,
        image_data_url: str | None = None,
        examples: list[dict[str, Any]] | None = None,
        model: str | None = None,
    ) -> Result:
        self.calls.append(
            Call(
                system=system,
                user=user,
                examples=examples,
                image_data_url=image_data_url,
                model=model,
            )
        )
        if self.raise_on_call is not None:
            raise self.raise_on_call

        is_grounder = examples is not None
        if not is_grounder and self.planner_delay_s:
            await asyncio.sleep(self.planner_delay_s)
        if is_grounder and self.grounder_errors:
            index = sum(1 for c in self.calls if c.examples is not None) - 1
            if index < len(self.grounder_errors):
                error = self.grounder_errors[index]
                if error is not None:
                    raise error

        index = min(len(self.calls) - 1, len(self.plans) - 1) if self.plans else -1
        plan = dict(self.plans[index]) if self.plans else {}

        if self.enforce_validator and validate is not None:
            complaint = validate(plan)
            if complaint is not None:
                raise AssertionError("scripted plan was rejected: " + complaint)

        return Result(plan=plan, attempts=self.attempts, mode=_Mode())

    @property
    def last(self) -> Call:
        return self.calls[-1]

    @property
    def grounder_call(self) -> Call:
        """The last call carrying exemplars - the planner never sends any."""
        for call in reversed(self.calls):
            if call.examples is not None:
                return call
        return self.calls[-1]


def ssg(**overrides: Any) -> dict[str, Any]:
    """A minimal, well-formed screen. Overrides replace whole top-level keys."""
    base: dict[str, Any] = {
        "ssg_version": "1.0",
        "session_id": "abc123",
        "trace_id": "t_1",
        "step": 0,
        "tier": 1,
        "goal": "Fill in the application form",
        "page": {
            "origin_class": "gov.in",
            "page_type": "form",
            "sensitivity": "private",
        },
        "viewport": {"w": 1280, "h": 900, "scroll_y": 0, "doc_h": 1400},
        "elements": [
            {
                "id": "e1",
                "role": "textbox",
                "name": "Aadhaar Number",
                "value": "⟦AADHAAR_1⟧",
                "bbox": [10, 10, 200, 40],
                "actionable": ["type", "clear"],
            },
            {
                "id": "e2",
                "role": "button",
                "name": "Continue",
                "bbox": [10, 60, 120, 40],
                "actionable": ["click"],
            },
        ],
        "text_blocks": [],
        "history": [],
        "redaction_manifest": {
            "policy_id": "gov",
            "counts": {"AADHAAR": 1},
            "methods": {"placeholder": 1},
            "detectors": ["l1-regex"],
            "coverage_confidence": 0.9,
            "unexplained_pixel_ratio": 0.02,
        },
    }
    base.update(overrides)
    return base


def plan(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "plan_id": "p_0",
        "trace_id": "t_1",
        "reasoning": "fill the field",
        "actions": [
            {"op": "type", "target": "e1", "value_ref": "⟦AADHAAR_1⟧", "risk": "safe"}
        ],
        "done": False,
        "confidence": 0.9,
    }
    base.update(overrides)
    return base
