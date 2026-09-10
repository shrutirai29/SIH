"""Failure-recovery prompting and the ask_user policy (ticket G8)."""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from app.schemas.action_plan import ActionPlan
from mantri.recovery import (
    ask_user_plan,
    fail_plan,
    hint_for_complaint,
    hints_from_history,
    should_ask_user,
    stalled_on,
)

from .mantri_fakes import ssg


def schema_error(plan: dict[str, Any]) -> str | None:
    try:
        ActionPlan.model_validate(plan)
    except ValidationError as exc:
        first = exc.errors()[0]
        return ".".join(str(p) for p in first["loc"]) + ": " + first["msg"]
    return None


# ------------------------------------------------------------------- hints


def test_a_hint_says_what_to_do_not_only_what_was_wrong() -> None:
    """Repeating the objection reliably produces a second wrong answer."""
    hint = hint_for_complaint("actions[0]: element id 'e9' is not on this screen.")
    assert "scroll" in hint.text
    assert "ask_user" in hint.text


def test_an_invented_reference_gets_the_reference_correction() -> None:
    hint = hint_for_complaint("`⟦PASSWORD_1⟧` does not appear on this screen.")
    assert "invented" in hint.text


def test_a_credential_complaint_points_at_the_only_correct_move() -> None:
    hint = hint_for_complaint("⟦REDACTED_0⟧ marks a credential whose value was destroyed")
    assert "ask_user" in hint.text


def test_the_last_rung_tells_the_model_to_stop_guessing() -> None:
    hint = hint_for_complaint("something unmapped", rung=3)
    assert "last attempt" in hint.text


def test_an_unmapped_complaint_still_gets_a_usable_instruction() -> None:
    assert hint_for_complaint("brand new objection").text


# ------------------------------------------------------------------- history


def test_repeated_failure_on_one_target_names_that_target() -> None:
    hints = hints_from_history(
        [
            {"step": 1, "action": "click", "target": "e7", "outcome": "no_change"},
            {"step": 2, "action": "click", "target": "e7", "outcome": "no_change"},
        ]
    )
    assert any("e7" in h.text and "not act on it again" in h.text for h in hints)


def test_scattered_failures_suggest_the_description_is_wrong() -> None:
    hints = hints_from_history(
        [
            {"step": 1, "action": "click", "target": "e7", "outcome": "no_change"},
            {"step": 2, "action": "click", "target": "e8", "outcome": "error"},
        ]
    )
    assert any("need_visual" in h.text for h in hints)


def test_a_blocked_action_is_never_retried() -> None:
    hints = hints_from_history([{"step": 1, "action": "click", "target": "e9", "outcome": "blocked"}])
    assert any("blocked" in h.text.lower() for h in hints)


def test_progress_produces_no_hints() -> None:
    assert hints_from_history([{"step": 1, "action": "type", "outcome": "advanced"}]) == []


def test_no_history_produces_no_hints() -> None:
    assert hints_from_history(None) == []


def test_stalled_on_distinguishes_one_control_from_a_bad_reading() -> None:
    same = [
        {"target": "e7", "outcome": "no_change"},
        {"target": "e7", "outcome": "error"},
    ]
    different = [
        {"target": "e7", "outcome": "no_change"},
        {"target": "e8", "outcome": "no_change"},
    ]
    assert stalled_on(same) == ("e7", 2)
    assert stalled_on(different) == (None, 2)
    assert stalled_on([{"target": "e7", "outcome": "advanced"}]) == (None, 0)


# ------------------------------------------------------------------- policy


def test_the_policy_stops_after_the_retry_ladder_is_spent() -> None:
    assert should_ask_user([], attempts=3) is True
    assert should_ask_user([], attempts=1) is False


def test_the_policy_stops_a_page_that_will_not_move() -> None:
    stalled = [
        {"target": "e7", "outcome": "no_change"},
        {"target": "e7", "outcome": "no_change"},
    ]
    assert should_ask_user(stalled) is True


# ------------------------------------------------------------------- plans


def test_the_ask_user_plan_is_schema_valid() -> None:
    """It exists precisely for the case where the model cannot produce valid JSON.

    If this plan were not valid by construction, the recovery path would depend on the
    thing that has already failed.
    """
    plan = ask_user_plan(ssg(), "Shall I keep going?", ["Keep going", "I'll take over"])
    assert schema_error(plan) is None
    assert plan["actions"][0]["op"] == "ask_user"
    assert plan["trace_id"] == "t_1"


def test_the_fail_plan_is_schema_valid_and_ends_the_task() -> None:
    plan = fail_plan(ssg(), "The portal has no record of this application.")
    assert schema_error(plan) is None
    assert plan["done"] is True


def test_long_questions_and_reasons_are_truncated_to_the_schema() -> None:
    assert schema_error(ask_user_plan(ssg(), "x" * 500)) is None
    assert schema_error(fail_plan(ssg(), "y" * 500)) is None


def test_at_most_six_options_survive() -> None:
    plan = ask_user_plan(ssg(), "Pick one", [f"option {i}" for i in range(10)])
    assert len(plan["actions"][0]["options"]) == 6
    assert schema_error(plan) is None


# ------------------------------------------------- corrections the first G7 run needed


def test_an_empty_plan_is_told_what_to_return_instead() -> None:
    """The complaint says what was wrong; the hint has to say what to do.

    Two tasks in the first G7 run came back with no actions at all. Repeating "your
    plan was empty" at a model that returned nothing reliably returns nothing again.
    """
    hint = hint_for_complaint("`actions` is empty and `done` is false, so this plan ...")
    assert "ask_user" in hint.text
    assert "fail" in hint.text
    assert hint.text != _generic_text()


def test_a_disabled_control_hint_points_at_the_precondition() -> None:
    hint = hint_for_complaint(
        "actions[0]: 'e2' cannot be clicked - the page lists it as not actionable at all."
    )
    assert "disabled" in hint.text
    assert "actionable" in hint.text
    assert hint.text != _generic_text()


def _generic_text() -> str:
    """Whatever an unrecognised complaint gets - the thing these must not be."""
    return hint_for_complaint("something nobody has a rule for").text
