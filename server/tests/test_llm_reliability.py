"""Audit tests for the 8 LLM failure classes (mocked transport, 0 API credits used)."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.llm.client import DecodeMode, LlmClient, LlmConfig, LlmError
from app.main import app

client = TestClient(app)


def base_ssg(**overrides: Any) -> dict[str, Any]:
    g: dict[str, Any] = {
        "ssg_version": "1.0",
        "session_id": "eph_aabbccdd1122",
        "trace_id": "t_1",
        "step": 0,
        "tier": 1,
        "purpose": "assist-user-task",
        "goal": "Click the submit button",
        "viewport": {"w": 1280, "h": 720, "dpr": 1.0, "scroll_y": 0},
        "page": {"origin_class": "gov.in", "page_type": "form", "sensitivity": "private"},
        "elements": [
            {
                "id": "e1",
                "role": "button",
                "bbox": [0.0, 0.0, 100.0, 30.0],
                "name": "Submit",
                "actionable": ["click"],
            }
        ],
        "redaction_manifest": {
            "policy_id": "in-default-v1",
            "counts": {},
            "methods": {},
            "detectors": ["dom-rules@0.2"],
            "coverage_confidence": 0.8,
        },
    }
    g.update(overrides)
    return g


def make_mock_transport(handler):
    return httpx.MockTransport(handler)


# -----------------------------------------------------------------------------
# Class 1: HTTP 401/403
# -----------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_failure_class_1_auth_error_401_403(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(401, json={"error": {"message": "Invalid API key"}})

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="sk-bad-key"))

    with pytest.raises(LlmError) as exc:
        await llm.complete(system="s", user="u", schema={}, validate=lambda _: None)

    assert "provider returned HTTP 401" in str(exc.value)
    # Exactly 1 call: no pointless retry loop
    assert calls == 1


# -----------------------------------------------------------------------------
# Class 2: HTTP 402 (Payment / Quota exhausted)
# -----------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_failure_class_2_quota_error_402(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(402, json={"error": {"message": "Insufficient credits"}})

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="sk-out-of-credits"))

    with pytest.raises(LlmError) as exc:
        await llm.complete(system="s", user="u", schema={}, validate=lambda _: None)

    assert "provider returned HTTP 402" in str(exc.value)
    # Exactly 1 call: no pointless retries
    assert calls == 1


# -----------------------------------------------------------------------------
# Class 3: HTTP 429 (Rate Limit with backoff)
# -----------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_failure_class_3_rate_limit_429(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(429, json={"error": {"message": "Rate limited"}})

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    # Patch sleep to not wait real seconds during test
    import asyncio
    sleep_mock = pytest.MonkeyPatch()
    async def fast_sleep(_): pass
    monkeypatch.setattr(asyncio, "sleep", fast_sleep)

    llm = LlmClient(LlmConfig(api_key="test-key"))

    with pytest.raises(LlmError) as exc:
        await llm.complete(system="s", user="u", schema={}, validate=lambda _: None)

    assert "provider rate-limited after 3 backoffs" in str(exc.value)
    # Initial attempt + 3 backoff retries = 4 calls total
    assert calls == 4


# -----------------------------------------------------------------------------
# Class 4: HTTP 502/503/504 Transient Server Errors (Bounded Retry)
# -----------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_transient_502_then_success(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0
    async def _noop(_): pass
    monkeypatch.setattr(asyncio, "sleep", _noop)

    valid_plan = {"plan_id": "p_0", "trace_id": "t_1", "done": True, "actions": [{"op": "click", "target": "e1"}]}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(502, json={"error": {"message": "Bad Gateway"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(valid_plan)}}]})

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="test-key"))

    result = await llm.complete(system="s", user="u", schema={"type": "object"}, validate=lambda _: None)
    assert calls == 2
    assert result.plan["actions"] == [{"op": "click", "target": "e1"}]


@pytest.mark.asyncio
async def test_transient_503_then_success(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0
    async def _noop(_): pass
    monkeypatch.setattr(asyncio, "sleep", _noop)

    valid_plan = {"plan_id": "p_0", "trace_id": "t_1", "done": True, "actions": [{"op": "click", "target": "e1"}]}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(503, json={"error": {"message": "Service Unavailable"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(valid_plan)}}]})

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="test-key"))

    result = await llm.complete(system="s", user="u", schema={"type": "object"}, validate=lambda _: None)
    assert calls == 2
    assert result.plan["actions"] == [{"op": "click", "target": "e1"}]


@pytest.mark.asyncio
async def test_transient_504_then_success(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0
    async def _noop(_): pass
    monkeypatch.setattr(asyncio, "sleep", _noop)

    valid_plan = {"plan_id": "p_0", "trace_id": "t_1", "done": True, "actions": [{"op": "click", "target": "e1"}]}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(504, json={"error": {"message": "Gateway Timeout"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(valid_plan)}}]})

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="test-key"))

    result = await llm.complete(system="s", user="u", schema={"type": "object"}, validate=lambda _: None)
    assert calls == 2
    assert result.plan["actions"] == [{"op": "click", "target": "e1"}]


@pytest.mark.asyncio
async def test_persistent_502_bounded_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0
    async def _noop(_): pass
    monkeypatch.setattr(asyncio, "sleep", _noop)

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(502, json={"error": {"message": "Bad Gateway"}})

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="test-key"))

    with pytest.raises(LlmError) as exc:
        await llm.complete(system="s", user="u", schema={}, validate=lambda _: None)

    assert "provider returned HTTP 502" in str(exc.value)
    # Initial attempt + 2 retries = 3 calls total (bounded)
    assert calls == 3


@pytest.mark.asyncio
async def test_server_error_500_fails_fast_no_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500, json={"error": {"message": "Internal Server Error"}})

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="test-key"))

    with pytest.raises(LlmError) as exc:
        await llm.complete(system="s", user="u", schema={}, validate=lambda _: None)

    assert "provider returned HTTP 500" in str(exc.value)
    assert calls == 1



# -----------------------------------------------------------------------------
# Class 5: Network Timeout and Connection Failure
# -----------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_failure_class_5_network_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("Connection timed out", request=request)

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="test-key"))

    with pytest.raises(LlmError) as exc:
        await llm.complete(system="s", user="u", schema={}, validate=lambda _: None)

    assert "provider connection timed out" in str(exc.value)


@pytest.mark.asyncio
async def test_failure_network_connection_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="test-key"))

    with pytest.raises(LlmError) as exc:
        await llm.complete(system="s", user="u", schema={}, validate=lambda _: None)

    assert "provider network error: ConnectError" in str(exc.value)


# -----------------------------------------------------------------------------
# Class 6: Invalid JSON (e.g. "This is not JSON.")
# -----------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_failure_class_6_invalid_json(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "This is definitely not JSON."}}]},
        )

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="test-key"))

    with pytest.raises(LlmError) as exc:
        await llm.complete(system="s", user="u", schema={}, validate=lambda _: None)

    assert "no schema-valid plan after" in str(exc.value)
    # Bounded retry: tried all decode tiers
    assert calls >= 2


# -----------------------------------------------------------------------------
# Class 7: Valid JSON but Invalid ActionPlan (semantic rejection + retry feedback)
# -----------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_failure_class_7_invalid_action_plan_semantic_rejection(monkeypatch: pytest.MonkeyPatch) -> None:
    feedback_seen = []
    attempt = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempt
        attempt += 1
        body = json.loads(request.content.decode("utf-8"))
        messages = body["messages"]
        for m in messages:
            if m["role"] == "user" and "rejected by the schema validator" in m["content"]:
                feedback_seen.append(m["content"])

        if attempt < 3:
            # Model attempts fabricated target e999
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "plan_id": "p_0",
                                        "trace_id": "t_1",
                                        "done": False,
                                        "actions": [{"op": "click", "target": "e999"}],
                                    }
                                )
                            }
                        }
                    ]
                },
            )
        else:
            # On attempt 3, model recovers with valid target e1
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "plan_id": "p_0",
                                        "trace_id": "t_1",
                                        "done": True,
                                        "actions": [{"op": "click", "target": "e1"}],
                                    }
                                )
                            }
                        }
                    ]
                },
            )

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="test-key"))

    def validate(plan: dict[str, Any]) -> str | None:
        target = plan.get("actions", [{}])[0].get("target")
        if target == "e999":
            return "actions[0]: target 'e999' does not exist on screen"
        return None

    result = await llm.complete(
        system="s", user="u", schema={"type": "object"}, validate=validate
    )

    # 1. Model recovered on attempt 3
    assert result.attempts == 3
    assert result.plan["actions"][0]["target"] == "e1"
    # 2. Feedback was fed to the model verbatim
    assert len(feedback_seen) > 0
    assert "target 'e999' does not exist" in feedback_seen[0]


# -----------------------------------------------------------------------------
# Class 8: Valid ActionPlan (Normal path)
# -----------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_failure_class_8_normal_valid_path(monkeypatch: pytest.MonkeyPatch) -> None:
    valid_plan = {
        "plan_id": "p_0",
        "trace_id": "t_1",
        "done": True,
        "actions": [{"op": "click", "target": "e1"}],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(valid_plan)}}]},
        )

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    llm = LlmClient(LlmConfig(api_key="test-key"))

    result = await llm.complete(
        system="s", user="u", schema={"type": "object"}, validate=lambda _: None
    )

    assert result.attempts == 1
    assert result.plan["actions"][0]["target"] == "e1"
    assert result.plan["done"] is True


def test_endpoint_on_network_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("Connection timed out", request=request)

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    from app.main import llm

    with patch.object(llm.config, "api_key", "test-key"):
        tc = TestClient(app, raise_server_exceptions=False)
        resp = tc.post("/v1/agent/step", json=base_ssg())
        assert resp.status_code == 503
        data = resp.json()
        assert data["error"] == "MODEL_UNAVAILABLE"
        assert "timed out" in data["detail"]


def test_endpoint_on_network_connection_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    transport = make_mock_transport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    from app.main import llm

    with patch.object(llm.config, "api_key", "test-key"):
        tc = TestClient(app, raise_server_exceptions=False)
        resp = tc.post("/v1/agent/step", json=base_ssg())
        assert resp.status_code == 503
        data = resp.json()
        assert data["error"] == "MODEL_UNAVAILABLE"
        assert "ConnectError" in data["detail"]
