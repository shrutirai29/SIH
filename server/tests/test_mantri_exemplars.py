"""Few-shot exemplars (ticket G2).

The load-bearing test in this file is the first one. An exemplar that violates the
action schema teaches the model to violate it, and it teaches that far more effectively
than the prose telling it not to - a demonstration outweighs a rule. Every assistant
turn is therefore validated against the same generated Pydantic model the server uses
to reject the live plan.
"""

from __future__ import annotations

import json

import pytest

from app.guards.ingress_pii import contains_pii
from app.schemas.action_plan import ActionPlan
from mantri.exemplars import EXEMPLARS, as_messages


@pytest.mark.parametrize("exemplar", EXEMPLARS, ids=lambda e: e.name)
def test_every_exemplar_is_schema_valid(exemplar) -> None:
    ActionPlan.model_validate(exemplar.assistant)


@pytest.mark.parametrize("exemplar", EXEMPLARS, ids=lambda e: e.name)
def test_no_exemplar_contains_a_literal_identifier(exemplar) -> None:
    """We demonstrate the rule we state: references, never values."""
    blob = json.dumps(exemplar.assistant, ensure_ascii=False) + exemplar.user
    assert not contains_pii(blob)


@pytest.mark.parametrize("exemplar", EXEMPLARS, ids=lambda e: e.name)
def test_every_exemplar_references_only_ids_it_was_shown(exemplar) -> None:
    """An exemplar that acts on an unlisted id demonstrates the worst failure mode."""
    shown = set(json.dumps(exemplar.user))  # cheap containment check below
    del shown
    for action in exemplar.assistant.get("actions", []):
        target = action.get("target")
        if isinstance(target, str):
            assert f'"id": "{target}"' in exemplar.user


@pytest.mark.parametrize("exemplar", EXEMPLARS, ids=lambda e: e.name)
def test_every_exemplar_uses_only_references_it_was_shown(exemplar) -> None:
    for action in exemplar.assistant.get("actions", []):
        ref = action.get("value_ref")
        if isinstance(ref, str):
            assert ref in exemplar.user


def test_the_six_behaviours_are_all_present() -> None:
    assert {e.name for e in EXEMPLARS} == {
        "fill_reference",
        "stop_before_risk",
        "credential",
        "absent_target",
        "injection",
        "completion",
    }


def test_the_credential_exemplar_never_resolves_a_destroyed_credential() -> None:
    """This is the S-05 failure written down as a demonstration."""
    credential = next(e for e in EXEMPLARS if e.name == "credential")
    refs = [a.get("value_ref") for a in credential.assistant["actions"]]
    assert not any(isinstance(r, str) and r.startswith("⟦REDACTED") for r in refs)
    assert any(a["op"] == "ask_user" for a in credential.assistant["actions"])


def test_the_risk_exemplar_does_not_chain_past_a_high_risk_action() -> None:
    risky = next(e for e in EXEMPLARS if e.name == "stop_before_risk")
    assert len(risky.assistant["actions"]) == 1
    assert risky.assistant["actions"][0]["risk"] == "high"


def test_the_injection_exemplar_ignores_the_page_and_says_so() -> None:
    injected = next(e for e in EXEMPLARS if e.name == "injection")
    assert "ignoring it" in injected.assistant["reasoning"]
    assert all(a["op"] != "navigate" for a in injected.assistant["actions"])


def test_messages_alternate_user_and_assistant() -> None:
    messages = as_messages()
    assert len(messages) == 2 * len(EXEMPLARS)
    assert [m["role"] for m in messages[:4]] == ["user", "assistant", "user", "assistant"]


def test_a_tight_budget_keeps_the_most_important_examples() -> None:
    """Trimming from the end preserves the redaction contract and the risk boundary."""
    trimmed = as_messages(limit=2)
    assert len(trimmed) == 4
    assert "AADHAAR_1" in trimmed[0]["content"]


def test_a_zero_limit_disables_few_shot_entirely() -> None:
    """The `no-exemplars` ablation must actually ablate."""
    assert as_messages(limit=0) == []


def test_exemplar_inputs_look_like_real_inputs() -> None:
    """An exemplar shaped unlike the live prompt teaches the wrong expectations."""
    for exemplar in EXEMPLARS:
        assert "<untrusted_page_content>" in exemplar.user
        assert exemplar.user.strip().endswith("Respond with one JSON action plan and nothing else.")
