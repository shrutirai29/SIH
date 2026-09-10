"""Model bake-off (ticket G6).

Runs the same suite, the same prompt and the same scoring against several models and
prints them side by side. The point is not to find the best model in the abstract - it
is to find out **how much we lose by running the 7B**, because the 7B is what a laptop
or a modest rented GPU can serve, and the submission's air-gapped claim (R9) depends on
being able to run something small.

## Read the per-category table, not the headline

A model that scores 34/40 by passing every easy task and failing all four credential
tasks is worse for this system than one that scores 31/40 and never invents a reference. The
categories are ordered by how much a failure costs the user:

    credential > injection > risk > grounding > reference > recovery > completion

## Cost

Every model in the list runs every task. That is real money on a metered endpoint, and
the run is serial on purpose - a parallel bake-off that trips a provider's rate limit
measures the rate limiter.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

from .harness import SuiteReport, Variant, load_tasks, run_suite

__all__ = ["BakeoffRow", "run_bakeoff", "render_bakeoff"]

CATEGORY_ORDER = (
    "credential",
    "injection",
    "risk",
    "grounding",
    "reference",
    "recovery",
    "perception",
    "completion",
)


@dataclass
class BakeoffRow:
    model: str
    report: SuiteReport
    error: str = ""


async def run_bakeoff(
    models: list[str],
    *,
    llm_factory: Callable[[str], Any],
    action_plan_schema: dict[str, Any],
    build_user_prompt: Callable[[dict[str, Any]], str],
    make_validator: Callable[[dict[str, Any]], Callable[[dict[str, Any]], str | None]],
    contains_pii: Callable[[str], bool],
    variant: Variant = Variant.FULL,
) -> list[BakeoffRow]:
    tasks = load_tasks()
    rows: list[BakeoffRow] = []

    for model in models:
        try:
            report = await run_suite(
                llm_factory(model),
                action_plan_schema=action_plan_schema,
                build_user_prompt=build_user_prompt,
                make_validator=make_validator,
                contains_pii=contains_pii,
                variant=variant,
                model=model,
                tasks=tasks,
            )
            rows.append(BakeoffRow(model=model, report=report))
        except Exception as exc:  # noqa: BLE001 - one dead endpoint must not end the run
            rows.append(
                BakeoffRow(
                    model=model,
                    report=SuiteReport(variant=variant, model=model, results=[]),
                    error=f"{type(exc).__name__}: {exc}",
                )
            )
        # Serial, and paced: providers rate-limit per key, and a 429 scored as a task
        # failure would be a lie about the model (the S-05 lesson).
        await asyncio.sleep(1.0)

    return rows


def render_bakeoff(rows: list[BakeoffRow]) -> str:
    categories = [
        c
        for c in CATEGORY_ORDER
        if any(c in row.report.by_category() for row in rows)
    ]
    header = f"{'model':<38} {'total':>7}  " + "  ".join(f"{c[:6]:>6}" for c in categories)
    lines = [header, "-" * len(header)]

    for row in rows:
        if row.error:
            lines.append(f"{row.model:<38} {'ERROR':>7}  {row.error}")
            continue
        by_cat = row.report.by_category()
        cells = []
        for c in categories:
            ok, total = by_cat.get(c, (0, 0))
            cells.append(f"{ok}/{total:<4}" if total else f"{'-':>6}")
        # A model whose run was cut short has not lost the bake-off; it did not enter
        # it. Printing "12/40" next to a rival's "37/40" invents a comparison, and the
        # bake-off is nothing but the comparison.
        if not row.report.complete:
            lines.append(
                f"{row.model:<38} {'PARTIAL':>7}  "
                f"{row.report.passed}/{len(row.report.scored)} of the tasks that ran; "
                f"{len(row.report.errored)} never did - not comparable"
            )
            continue
        lines.append(
            f"{row.model:<38} {row.report.passed:>3}/{row.report.total:<3}  "
            + "  ".join(cells)
        )

    lines.append("")
    lines.append(
        "Read the credential and injection columns first: a failure there is a leak "
        "risk, not a lost step."
    )
    return "\n".join(lines)
