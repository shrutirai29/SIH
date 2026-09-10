"""Text-fast-path routing (ticket G4).

Two models sit behind MANTRI: a vision-language model that can look at a screenshot,
and a text model that cannot. The text model is 2-3x faster and materially cheaper,
and on a DOM-rich page it loses nothing, because the client already told us the roles,
names and values of every element. Vision earns its cost only when the structural
description is *known to be incomplete*.

So this module answers one question per step - text or vision - and it answers it from
evidence the client already sends, not from a guess:

* `tier`               the client's own Adaptive Perception Controller decision
* `attachment`         whether a redacted screenshot actually arrived
* `page.page_type`     canvas apps, media and PDFs have no useful DOM
* `coverage_confidence`  how much of the screen the client believes it understood
* `unexplained_pixel_ratio`  how much of it no element accounted for
* `history`            two steps of no progress means the description is not enough

## The asymmetry that matters

Routing *down* to text when vision was needed costs a wasted step. Routing *up* to
vision when text would have done costs latency and money. Neither is a privacy event -
the payload is identical either way, because the screenshot was redacted before the
guard cleared it. That is why this file is allowed to be a heuristic while
`egress-guard` is not.

## Requesting vision you do not have

The server cannot take a screenshot; only the client can. When the evidence says vision
is needed and no image is attached, the route says so (`request_visual`), the pipeline
sets `need_visual: true` on the returned plan, and the client escalates on the next
step. The current step still runs on text - a step that returns nothing is worse than a
step that returns a scroll.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

__all__ = ["Path", "Route", "RouterConfig", "choose_route"]


class Path(str, Enum):
    TEXT_FAST = "text_fast"
    VISION = "vision"


@dataclass(frozen=True)
class RouterConfig:
    """Model ids and thresholds.

    Defaults come from the environment so a bake-off (G6) can vary them without a
    code change. `text_model` falling back to `vision_model` is deliberate: a single
    configured endpoint must keep working, just without the fast path's saving.
    """

    # Read at construction, not at import, for the same reason as `LlmConfig`: an
    # entry point that loads a `.env` runs after this module is imported.
    vision_model: str = field(
        default_factory=lambda: os.environ.get(
            "PRAHARI_LLM_MODEL", "qwen/qwen2.5-vl-72b-instruct"
        )
    )
    text_model: str = field(
        default_factory=lambda: os.environ.get(
            "PRAHARI_LLM_TEXT_MODEL", os.environ.get("PRAHARI_LLM_MODEL", "")
        )
    )
    low_coverage: float = 0.6
    high_unexplained: float = 0.25
    stall_steps: int = 2

    def resolved_text_model(self) -> str:
        return self.text_model or self.vision_model


@dataclass(frozen=True)
class Route:
    path: Path
    model: str
    reason: str
    attach_image: bool
    request_visual: bool

    @property
    def is_vision(self) -> bool:
        return self.path is Path.VISION


_NO_DOM_PAGE_TYPES = frozenset({"canvas_app", "media", "pdf"})
_STALLED_OUTCOMES = frozenset({"no_change", "error", "blocked"})


def _stalled(history: list[Any], threshold: int) -> bool:
    """True when the last `threshold` steps all failed to move the page.

    Consecutive, not cumulative: a task that recovered after one bad step is not
    stalled, and counting cumulatively would drag every long task onto the vision
    path near the end.
    """
    if threshold <= 0 or len(history) < threshold:
        return False
    tail = history[-threshold:]
    return all(
        isinstance(h, dict) and h.get("outcome") in _STALLED_OUTCOMES for h in tail
    )


def choose_route(
    ssg: dict[str, Any],
    *,
    has_image: bool = False,
    config: RouterConfig | None = None,
) -> Route:
    """Picks the path for one step. Pure: same SSG in, same route out."""
    cfg = config or RouterConfig()

    page = ssg.get("page") or {}
    manifest = ssg.get("redaction_manifest") or {}
    history = list(ssg.get("history") or [])

    page_type = page.get("page_type")
    tier = ssg.get("tier")

    # `coverage_confidence` is required by the manifest schema, but a defaulted 1.0
    # would let a malformed manifest buy itself the cheap path. Absent means unknown,
    # and unknown means we do not get to claim high coverage.
    coverage = manifest.get("coverage_confidence")
    unexplained = manifest.get("unexplained_pixel_ratio")

    reasons: list[str] = []

    # An attached screenshot is the client's own escalation decision, taken with
    # signals the server cannot see, and paid for in capture, redaction and bytes on
    # the wire. Routing it to a text model would throw all of that away and answer
    # from the very description the client had already judged insufficient.
    if has_image:
        reasons.append("client attached a redacted screenshot")
    if page_type in _NO_DOM_PAGE_TYPES:
        reasons.append(f"page_type={page_type} has no useful DOM")
    if tier == 2:
        reasons.append("client chose tier 2")
    if isinstance(coverage, (int, float)) and coverage < cfg.low_coverage:
        reasons.append(f"coverage_confidence={coverage} below {cfg.low_coverage}")
    if coverage is None:
        reasons.append("coverage_confidence absent")
    if isinstance(unexplained, (int, float)) and unexplained > cfg.high_unexplained:
        reasons.append(
            f"unexplained_pixel_ratio={unexplained} above {cfg.high_unexplained}"
        )
    if _stalled(history, cfg.stall_steps):
        reasons.append(f"{cfg.stall_steps} consecutive steps without progress")

    if not reasons:
        return Route(
            path=Path.TEXT_FAST,
            model=cfg.resolved_text_model(),
            reason="structural description is complete enough",
            attach_image=False,
            request_visual=False,
        )

    return Route(
        path=Path.VISION,
        model=cfg.vision_model,
        reason="; ".join(reasons),
        attach_image=has_image,
        # Ask for a screenshot next step only when we needed one and did not get one.
        request_visual=not has_image,
    )


def escalate(route: Route, why: str, config: RouterConfig | None = None) -> Route:
    """The route to retry on after a failure that vision might explain.

    Used by the recovery ladder: a plan whose target did not exist is often a page the
    text description got wrong, and looking is the cheapest way to find out.
    """
    cfg = config or RouterConfig()
    if route.is_vision:
        return route
    return Route(
        path=Path.VISION,
        model=cfg.vision_model,
        reason=f"escalated: {why}",
        attach_image=route.attach_image,
        request_visual=not route.attach_image,
    )
