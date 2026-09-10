"""The request path (tickets F1, F3, F7).

Runs with no API key. Everything up to the model call is testable without one, and
that is where the guards live.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.llm.client import DecodeMode, LlmClient, LlmConfig, LlmError, extract_json
from app.main import app, llm

client = TestClient(app)

REAL_AADHAAR = "234567890124"  # Verhoeff-valid


def ssg(**over: Any) -> dict[str, Any]:
    g: dict[str, Any] = {
        "ssg_version": "1.0",
        "session_id": "eph_aabbccdd1122",
        "trace_id": "t_1",
        "step": 0,
        "tier": 1,
        "purpose": "assist-user-task",
        "goal": "Apply for the scheme",
        "viewport": {"w": 1280, "h": 720, "dpr": 1, "scroll_y": 0},
        "page": {"origin_class": "gov.in", "page_type": "form", "sensitivity": "private"},
        "elements": [
            {
                "id": "e1",
                "role": "textbox",
                "bbox": [0, 0, 200, 30],
                "name": "Aadhaar number",
                "value": "⟦AADHAAR_1⟧",
                "actionable": ["type"],
            }
        ],
        "redaction_manifest": {
            "policy_id": "in-default-v1",
            "counts": {"AADHAAR": 1},
            "methods": {"placeholder": 1},
            "detectors": ["dom-rules@0.2"],
            "coverage_confidence": 0.8,
        },
    }
    g.update(over)
    return g


def test_health_reports_configuration_honestly() -> None:
    body = client.get("/v1/health").json()
    assert body["status"] == "ok"
    assert "1.0" in body["ssg_versions"]
    # Never claims a model is loaded when none is.
    assert body["llm_configured"] is (body["model"] != "not configured")


def test_models_endpoint_does_not_overstate() -> None:
    body = client.get("/v1/models").json()
    assert "R9" in body["note"]


def test_unknown_contract_major_is_refused() -> None:
    r = client.post("/v1/agent/step", json=ssg(ssg_version="2.0"))
    assert r.status_code == 409
    assert r.json()["error"] == "VERSION_MISMATCH"


def test_schema_violation_is_refused_without_echoing_the_value() -> None:
    bad = ssg()
    bad["elements"][0]["id"] = "not-an-element-id"
    r = client.post("/v1/agent/step", json=bad)
    assert r.status_code == 400
    detail = r.json()["detail"]
    # RULES.md P9: the path, never the offending value.
    assert "not-an-element-id" not in detail


def test_unknown_field_is_refused() -> None:
    # additionalProperties:false is a privacy control: an unknown field is a field
    # nobody redacted (RULES.md P7).
    r = client.post("/v1/agent/step", json={**ssg(), "notes": "free text"})
    assert r.status_code == 400


@pytest.mark.parametrize(
    ("label", "value"),
    [
        ("aadhaar", REAL_AADHAAR),
        ("email", "asha.patil@example.com"),
        ("phone", "9876543210"),
        ("pan", "ABCPE1234F"),
        ("ifsc", "HDFC0001234"),
        ("card", "4111 1111 1111 1111"),
    ],
)
def test_ingress_guard_refuses_unredacted_pii(label: str, value: str) -> None:
    """The check that makes the client's correctness verifiable by the receiver."""
    leaky = ssg()
    leaky["elements"][0]["value"] = value
    r = client.post("/v1/agent/step", json=leaky)
    assert r.status_code == 422, label
    body = r.json()
    assert body["error"] == "REDACTOR_FAILURE"
    # The class, never the value.
    assert value not in json.dumps(body)


def test_ingress_guard_catches_pii_anywhere_in_the_payload() -> None:
    # Not just in fields we thought to check: the sweep is over the serialised bytes.
    for mutate in (
        lambda g: g["page"].update({"title": "Inbox — asha@example.com"}),
        lambda g: g.update(
            {"text_blocks": [{"id": "t1", "bbox": [0, 0, 1, 1], "source": "dom",
                              "text": "call 9876543210"}]}
        ),
        lambda g: g.update({"goal": "verify " + REAL_AADHAAR}),
    ):
        g = ssg()
        mutate(g)
        assert client.post("/v1/agent/step", json=g).status_code == 422


def test_a_clean_payload_reaches_the_model_stage() -> None:
    # With no key configured that stage answers 503 — which is itself the proof that
    # the guards let a clean payload through rather than refusing everything.
    orig_key = llm.config.api_key
    try:
        llm.config.api_key = ""
        r = client.post("/v1/agent/step", json=ssg())
        assert r.status_code == 503
        assert r.json()["error"] == "MODEL_UNAVAILABLE"
    finally:
        llm.config.api_key = orig_key


# ------------------------------------------------------- decode + retry tiers


def test_extract_json_survives_the_ways_models_wrap_output() -> None:
    expected = {"plan_id": "p", "actions": []}
    for raw in (
        json.dumps(expected),
        "```json\n" + json.dumps(expected) + "\n```",
        "```\n" + json.dumps(expected) + "\n```",
        "Here is the plan:\n" + json.dumps(expected),
        json.dumps(expected) + "\n\nLet me know if you need anything else.",
    ):
        assert extract_json(raw) == expected


def test_extract_json_handles_braces_inside_strings() -> None:
    obj = {"reasoning": "the value is {not json}", "actions": []}
    assert extract_json(json.dumps(obj)) == obj


def test_extract_json_rejects_non_objects() -> None:
    for raw in ("[]", "null", "not json at all", ""):
        with pytest.raises(LlmError):
            extract_json(raw)


def _fake_provider(responses: list[str]) -> httpx.MockTransport:
    """Answers with a scripted sequence, so the retry ladder can be driven."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        # A provider that does not support json_schema answers 400, which must make
        # the client fall back rather than fail the request.
        fmt = body.get("response_format", {}).get("type")
        if fmt == "json_schema":
            return httpx.Response(400, json={"error": "unsupported"})

        i = min(calls["n"], len(responses) - 1)
        calls["n"] += 1
        return httpx.Response(
            200,
            json={
                "model": "fake",
                "choices": [{"message": {"content": responses[i]}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            },
        )

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_retries_with_the_validator_complaint_and_recovers(monkeypatch) -> None:
    """The fallback that makes cloud endpoints usable without guided decoding."""
    good = json.dumps(
        {"plan_id": "p_0", "trace_id": "t_1", "actions": [{"op": "wait"}], "done": False}
    )
    transport = _fake_provider(['{"actions": "not an array"}', good])

    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)

    llm = LlmClient(LlmConfig(api_key="test-key"))
    seen: list[str] = []

    def validate(plan: dict[str, Any]) -> str | None:
        if not isinstance(plan.get("actions"), list):
            complaint = "`actions` must be an array."
            seen.append(complaint)
            return complaint
        return None

    result = await llm.complete(
        system="s", user="u", schema={"type": "object"}, validate=validate
    )

    assert result.plan["actions"] == [{"op": "wait"}]
    # Two calls: the strict attempt 400s and is skipped, then json, then retry.
    assert result.attempts >= 2
    assert result.mode is not DecodeMode.STRICT
    # The complaint was produced, which is what gets fed back to the model.
    assert seen == ["`actions` must be an array."]


@pytest.mark.asyncio
async def test_gives_up_rather_than_returning_an_invalid_plan(monkeypatch) -> None:
    transport = _fake_provider(['{"actions": "still wrong"}'])
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)

    llm = LlmClient(LlmConfig(api_key="test-key"))
    with pytest.raises(LlmError):
        await llm.complete(
            system="s",
            user="u",
            schema={"type": "object"},
            validate=lambda _p: "still wrong",
        )


@pytest.mark.asyncio
async def test_refuses_to_call_without_a_key() -> None:
    llm = LlmClient(LlmConfig(api_key=""))
    with pytest.raises(LlmError) as exc:
        await llm.complete(system="s", user="u", schema={}, validate=lambda _p: None)
    assert "PRAHARI_LLM_API_KEY" in str(exc.value)


def test_api_key_never_appears_in_an_error() -> None:
    llm = LlmClient(LlmConfig(api_key="sk-or-supersecret-value"))
    headers = llm._headers()
    assert headers["authorization"].endswith("supersecret-value")
    # But the config's repr, which could reach a log, must not spill it.
    assert "supersecret" not in str(LlmError("provider returned HTTP 500"))
