"""The eval harness (ticket G7) - tested by making it fail.

A harness nobody has seen fail is a harness nobody should quote. ADR-0004 was written
about exactly this: the canary audit reported a truthful `0/60 leaked` that proved
nothing, because the measurement could be satisfied by doing nothing.

So these tests do not check that a good model passes. They check that:

* a model that ignores the screen is scored as failing;
* the two always-on checks (literal PII, unknown targets) fire even on tasks that did
  not ask for them;
* the suite itself is well formed - every task's checks are ones the scorer implements,
  which is the other way a suite goes quietly vacuous.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.agents.grounder import build_user_prompt, make_validator
from app.main import ACTION_PLAN_SCHEMA, _plan_schema_validate
from mantri.evals import Variant, config_for_variant, load_tasks, run_suite
from mantri.evals.harness import score
from mantri.injection import screen_ssg
from mantri.router import choose_route

from .mantri_fakes import ScriptedLlm

TASKS = load_tasks()

# Every check key the scorer knows about. A task using anything else would silently
# never be enforced.
IMPLEMENTED_CHECKS = {
    "expect_ops",
    "forbid_ops",
    "expect_target",
    "forbid_target",
    "expect_value_ref",
    "forbid_value_ref_prefix",
    "forbid_invented_refs",
    "forbid_literal_digits",
    "max_actions",
    "expect_risk_at_least",
    "expect_done",
    "expect_need_visual",
    "expect_route",
    "expect_injection_flagged",
    "expect_injection_at_most",
    "expect_risk_at_most",
    "expect_fence_intact",
    "targets_must_exist",
}


def validator(screen: dict[str, Any]):
    return make_validator(screen, _plan_schema_validate)


async def _run(llm: ScriptedLlm, variant: Variant = Variant.FULL, tasks=None):
    return await run_suite(
        llm,
        action_plan_schema=ACTION_PLAN_SCHEMA,
        build_user_prompt=build_user_prompt,
        make_validator=validator,
        contains_pii=lambda text: "234156789012" in text.replace(" ", ""),
        variant=variant,
        model="scripted",
        tasks=tasks,
    )


# ------------------------------------------------------------------ the suite


def test_the_suite_loads_and_every_task_states_why_it_exists() -> None:
    assert len(TASKS) == 40, "G7 asks for 40; quote the denominator you actually have"
    assert len({t.id for t in TASKS}) == len(TASKS)
    for task in TASKS:
        assert task.why, f"{task.id} has no rationale"
        assert task.checks, f"{task.id} asserts nothing"


def test_every_check_a_task_names_is_one_the_scorer_implements() -> None:
    for task in TASKS:
        unknown = set(task.checks) - IMPLEMENTED_CHECKS
        assert not unknown, f"{task.id} uses unimplemented checks: {unknown}"


def test_the_categories_cover_the_behaviours_that_matter() -> None:
    categories = {t.category for t in TASKS}
    assert {
        "credential",
        "injection",
        "risk",
        "grounding",
        "reference",
        "multi_step",
        "failure",
    } <= categories


def test_a_task_cannot_ask_for_something_the_screen_does_not_contain() -> None:
    """The other way a suite goes vacuous: a check nothing could ever satisfy.

    `expect_target: "e9"` on a screen with no `e9` is not a hard task, it is a task
    that fails every model for a reason that has nothing to do with the model. These
    are the assertions a hand-written JSON suite needs and a scorer cannot make.
    """
    ops = {
        "click", "type", "select", "scroll", "key",
        "navigate", "wait", "extract", "ask_user", "done", "fail",
    }
    for task in TASKS:
        ids = {el["id"] for el in task.ssg.get("elements", [])}
        checks = task.checks
        assert task.goal == task.ssg.get("goal"), f"{task.id}: goal disagrees with its screen"
        for key in ("expect_target", "forbid_target"):
            if key in checks:
                assert checks[key] in ids, f"{task.id}: {key} names an element that is not there"
        for key in ("expect_ops", "forbid_ops"):
            unknown = set(checks.get(key, [])) - ops
            assert not unknown, f"{task.id}: {key} names ops the schema has no rule for: {unknown}"
        if "expect_target" in checks:
            assert checks["expect_target"] != checks.get("forbid_target")
        if "expect_value_ref" in checks:
            blob = json.dumps(
                {k: v for k, v in task.ssg.items() if k != "history"}, ensure_ascii=False
            )
            assert checks["expect_value_ref"] in blob, f"{task.id}: that reference is not on the screen"


def test_the_injection_and_route_expectations_match_what_the_code_actually_says() -> None:
    """Both are decided before the model answers, so a wrong one is an authoring bug.

    Running them here rather than only inside a suite run means a rule change that
    silently reclassifies a task shows up as a failing test, not as a model regression.
    """
    ranked = {"clean": 0, "suspicious": 1, "hostile": 2}
    for task in TASKS:
        checks = task.checks
        verdict = screen_ssg(task.ssg).verdict.value
        if "expect_injection_flagged" in checks:
            assert ranked[verdict] >= ranked[checks["expect_injection_flagged"]], (
                f"{task.id}: classifier says {verdict}"
            )
        if "expect_injection_at_most" in checks:
            assert ranked[verdict] <= ranked[checks["expect_injection_at_most"]], (
                f"{task.id}: classifier says {verdict}"
            )
        if "expect_route" in checks:
            assert choose_route(task.ssg).path.value == checks["expect_route"], (
                f"{task.id}: the router disagrees with the task"
            )


# ------------------------------------------------------------------ scoring


async def test_a_model_that_clicks_blindly_fails_most_of_the_suite() -> None:
    """The control that proves the suite discriminates."""
    lazy = ScriptedLlm(
        plans=[{"plan_id": "p", "trace_id": "t_1", "actions": [{"op": "click", "target": "e1"}], "done": False}]
    )
    report = await _run(lazy)
    assert report.passed < report.total / 2


def _stalled(task) -> bool:
    """Tasks whose history already triggers the server-side recovery policy."""
    history = task.ssg.get("history") or []
    return len(history) >= 2 and all(
        h.get("outcome") in {"no_change", "error", "blocked"} for h in history[-2:]
    )


async def test_an_empty_plan_passes_nothing_that_asked_for_an_action() -> None:
    """A plan that does nothing must not be scored as harmless."""
    idle = ScriptedLlm(plans=[{"plan_id": "p", "trace_id": "t_1", "actions": [], "done": False}])
    tasks = [t for t in TASKS if "expect_ops" in t.checks and not _stalled(t)]
    report = await _run(idle, tasks=tasks)
    assert report.passed == 0


async def test_recovery_answers_correctly_even_when_the_model_returns_nothing() -> None:
    """The one place an empty model answer still scores: and it should.

    On `absent-02` the page has refused to move twice, so the recovery policy replaces
    whatever the model said with a server-built `ask_user` - which is the behaviour the
    task is asking for. The plan is correct precisely because it did not come from the
    model.
    """
    idle = ScriptedLlm(plans=[{"plan_id": "p", "trace_id": "t_1", "actions": [], "done": False}])
    task = next(t for t in TASKS if t.id == "absent-02")
    report = await _run(idle, tasks=[task])
    assert report.passed == 1
    assert report.results[0].plan["actions"][0]["op"] == "ask_user"


async def test_a_literal_identifier_fails_a_task_that_never_asked_about_pii() -> None:
    task = next(t for t in TASKS if t.id == "fill-01")
    failures = score(
        task,
        {
            "actions": [
                {"op": "type", "target": "e1", "value": "2341 5678 9012"},
                {"op": "type", "target": "e1", "value_ref": "⟦AADHAAR_1⟧"},
            ]
        },
        route="text_fast",
        prompt="",
        contains_pii=lambda text: "234156789012" in text.replace(" ", ""),
    )
    assert any("literal" in f for f in failures)


def test_an_unknown_target_fails_even_when_the_task_did_not_ask() -> None:
    task = next(t for t in TASKS if t.id == "fill-01")
    failures = score(
        task,
        {"actions": [{"op": "click", "target": "e99"}]},
        route="text_fast",
        prompt="",
        contains_pii=lambda _: False,
    )
    assert any("not on the screen" in f for f in failures)


def test_an_invented_reference_fails() -> None:
    task = next(t for t in TASKS if t.id == "cred-01")
    failures = score(
        task,
        {"actions": [{"op": "type", "target": "e2", "value_ref": "⟦PASSWORD_1⟧"}]},
        route="text_fast",
        prompt="",
        contains_pii=lambda _: False,
    )
    assert any("invented" in f for f in failures)


def test_a_correct_plan_scores_clean() -> None:
    """The harness must also be able to pass, or it measures nothing either."""
    task = next(t for t in TASKS if t.id == "fill-01")
    failures = score(
        task,
        {"actions": [{"op": "type", "target": "e1", "value_ref": "⟦AADHAAR_1⟧", "risk": "safe"}]},
        route="text_fast",
        prompt="",
        contains_pii=lambda _: False,
    )
    assert failures == []


# ------------------------------------------------------------------ variants


def test_ablations_actually_ablate() -> None:
    """Every variant, not most of them: an ablation that ablates nothing reports a
    delta of zero and gets quoted as "the advisory makes no difference"."""
    assert config_for_variant(Variant.NO_EXEMPLARS).exemplar_limit == 0
    assert config_for_variant(Variant.NO_PLANNER).planner.enabled is False
    assert config_for_variant(Variant.NO_ADVISORY).include_advisory is False
    assert config_for_variant(Variant.FULL).exemplar_limit == 6
    assert config_for_variant(Variant.FULL).include_advisory is True
    assert config_for_variant(Variant.FULL).planner.enabled is True


@pytest.mark.parametrize("variant", list(Variant))
async def test_every_variant_runs(variant: Variant) -> None:
    llm = ScriptedLlm(
        plans=[{"plan_id": "p", "trace_id": "t_1", "actions": [{"op": "click", "target": "e1"}], "done": False}]
    )
    report = await _run(llm, variant=variant, tasks=TASKS[:3])
    assert report.total == 3
    assert report.render()
    assert report.to_json()["variant"] == variant.value


async def test_tasks_are_not_mutated_across_runs() -> None:
    """Two variants must see the same suite, or the comparison means nothing."""
    before = [dict(t.ssg) for t in TASKS]
    llm = ScriptedLlm(plans=[{"plan_id": "p", "trace_id": "t_1", "actions": [], "done": False}])
    await _run(llm)
    await _run(llm, variant=Variant.NO_EXEMPLARS)
    assert [dict(t.ssg) for t in TASKS] == before


# ------------------------------------------------------------------ the oracle


async def test_every_task_in_the_suite_can_actually_be_passed() -> None:
    """The counterpart to the failing control: 40/40 for a hand-written right answer.

    A task nothing can satisfy is invisible in a suite run - it looks exactly like a
    model weakness, and it drags the number G7 reports. The only way to find one is to
    answer it, so `tests/mantri_oracle.py` answers all forty.
    """
    from .mantri_oracle import ORACLE, SERVER_ANSWERS

    assert set(ORACLE) | SERVER_ANSWERS == {t.id for t in TASKS}

    failed: list[str] = []
    for task in TASKS:
        answer = ORACLE.get(task.id)
        llm = ScriptedLlm(
            plans=[answer if answer is not None else {"plan_id": "p", "trace_id": "t_1", "actions": [], "done": False}],
            # The answer key must also be a plan HASTA would accept, or it is not an
            # answer - it is a plan the client refuses.
            enforce_validator=answer is not None,
        )
        report = await _run(llm, tasks=[task])
        result = report.results[0]
        if not result.passed:
            failed.append(f"{task.id}: {result.error or '; '.join(result.failures)}")

    assert not failed, "tasks no correct plan can pass:\n" + "\n".join(failed)


# ------------------------------------------- a run that did not happen is not a result
#
# The first metered run of this suite exhausted the account's credit at task 13. The
# harness printed "12/40 tasks passed (30%)" - a plausible-looking score for a run in
# which 28 tasks never reached a model. That is the vacuous metric ADR-0004 was written
# about, produced by the harness written to catch it. These tests are the fix.


class _BrokeLlm(ScriptedLlm):
    """Answers `ok_for` tasks, then refuses the way a metered provider refuses."""

    def __init__(self, ok_for: int, **kw) -> None:
        super().__init__(**kw)
        self.ok_for = ok_for

    async def complete(self, **kw):  # type: ignore[override]
        if sum(1 for c in self.calls if c.examples is not None) >= self.ok_for:
            raise RuntimeError("provider returned HTTP 402")
        return await super().complete(**kw)


def _good_llm(ok_for: int) -> _BrokeLlm:
    from .mantri_oracle import ORACLE

    return _BrokeLlm(ok_for=ok_for, plans=[ORACLE["fill-01"]])


async def test_tasks_the_provider_never_served_are_not_counted_as_failures() -> None:
    report = await _run(_good_llm(ok_for=2), tasks=TASKS[:6])

    assert report.complete is False
    assert len(report.scored) == 2
    assert len(report.errored) == 4
    # The rate divides by what ran, not by what was asked for: scoring a model out of
    # 6 when it was only ever asked twice is a claim about four answers it never gave.
    assert report.rate == pytest.approx(report.passed / len(report.scored))
    assert report.rate != pytest.approx(report.passed / report.total)


async def test_an_incomplete_run_refuses_to_print_a_percentage() -> None:
    text = (await _run(_good_llm(ok_for=2), tasks=TASKS[:6])).render()

    assert "NOT A RESULT" in text
    assert "never reached the model" in text
    assert "(33%)" not in text and "tasks passed" not in text


async def test_an_incomplete_run_reports_a_null_rate_in_json() -> None:
    """The JSON is what gets read months later, by someone who was not here."""
    blob = (await _run(_good_llm(ok_for=2), tasks=TASKS[:6])).to_json()

    assert blob["complete"] is False
    assert blob["rate"] is None
    assert blob["scored"] == 2 and blob["errored"] == 4
    assert "402" in blob["aborted"]


async def test_the_run_stops_instead_of_retrying_an_account_that_cannot_pay() -> None:
    """39 more identical refusals cost time and money and tell nobody anything."""
    llm = _good_llm(ok_for=2)
    report = await _run(llm, tasks=TASKS[:10])

    # Two answered, the third refused (and raised before it was recorded). Without the
    # guard this would be ten.
    grounder_calls = sum(1 for c in llm.calls if c.examples is not None)
    assert grounder_calls == 2, "should stop at the first account-level refusal"
    assert len(report.results) == 10, "the tasks it never got to are still reported"
    assert report.results[-1].error.startswith("not attempted")


async def test_a_complete_run_still_reports_normally() -> None:
    """The guard must not make an honest run look broken."""
    report = await _run(_good_llm(ok_for=99), tasks=[TASKS[0]])

    assert report.complete is True
    assert report.to_json()["rate"] == 1.0
    assert "NOT A RESULT" not in report.render()
    assert "1/1 tasks passed" in report.render()


async def test_a_partial_run_is_not_tabled_against_a_complete_one() -> None:
    """The bake-off is nothing but the comparison, so a non-entrant must not look
    like a loser: "12/40" beside "37/40" invents a result for a model that was asked
    twelve questions."""
    from mantri.evals.bakeoff import BakeoffRow, render_bakeoff

    complete = await _run(_good_llm(ok_for=99), tasks=TASKS[:3])
    partial = await _run(_good_llm(ok_for=1), tasks=TASKS[:3])
    text = render_bakeoff(
        [BakeoffRow(model="whole", report=complete), BakeoffRow(model="cut-off", report=partial)]
    )

    cut_off = next(line for line in text.splitlines() if line.startswith("cut-off"))
    assert "PARTIAL" in cut_off
    assert "not comparable" in cut_off
    # "1/3" is the shape of the fabricated comparison: a score out of a suite the
    # model was never asked. The complete row may print it; this one may not.
    assert "1/3" not in cut_off
    assert any(line.startswith("whole") and "1/3" in line for line in text.splitlines())


def test_every_module_in_the_package_actually_parses() -> None:
    """A syntax error in `__main__.py` once passed the whole suite.

    Nothing imports the CLI - the tests drive `run_suite` directly - so a broken
    `python -m mantri.evals` was invisible to 261 green tests and visible to the first
    person who tried to run an eval. Compiling every file is cheap and closes that gap
    for every module the tests happen not to import.
    """
    import compileall
    import pathlib

    package = pathlib.Path(__file__).resolve().parent.parent / "mantri"
    assert compileall.compile_dir(str(package), quiet=2, force=True), (
        "a module in mantri/ does not compile"
    )
