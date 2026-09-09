"""Tests for screenshot/vision wiring into /v1/agent/step (Ticket F5)."""

from __future__ import annotations

import base64
import struct
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.llm.client import DecodeMode, LlmResult
from app.main import app, llm
from tests.test_image_sanity import _make_png

client = TestClient(app)


def base_ssg(**overrides: Any) -> dict[str, Any]:
    g: dict[str, Any] = {
        "ssg_version": "1.0",
        "session_id": "eph_aabbccdd1122",
        "trace_id": "t_1",
        "step": 0,
        "tier": 1,
        "purpose": "assist-user-task",
        "goal": "Apply for the scheme",
        "viewport": {"w": 1280, "h": 720, "dpr": 1.0, "scroll_y": 0},
        "page": {"origin_class": "gov.in", "page_type": "form", "sensitivity": "private"},
        "elements": [
            {
                "id": "e1",
                "role": "textbox",
                "bbox": [0.0, 0.0, 200.0, 30.0],
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
    g.update(overrides)
    return g


def dummy_llm_result() -> LlmResult:
    return LlmResult(
        plan={
            "plan_id": "p_0",
            "trace_id": "t_1",
            "done": True,
            "actions": [{"op": "click", "target": "e1"}],
        },
        mode=DecodeMode.STRICT,
        attempts=1,
        model="test-model",
        tokens_in=10,
        tokens_out=10,
        latency_ms=100,
        raw="{}",
    )


def test_text_only_request_passes_null_image_data_url() -> None:
    """Test 1: Request with no screenshot passes image_data_url=None to llm.complete()."""
    mock_complete = AsyncMock(return_value=dummy_llm_result())

    with (
        patch.object(llm.config, "api_key", "test-key"),
        patch("app.main.llm.complete", mock_complete),
    ):
        resp = client.post("/v1/agent/step", json=base_ssg())
        assert resp.status_code == 200
        mock_complete.assert_called_once()
        _, kwargs = mock_complete.call_args
        assert kwargs["image_data_url"] is None


def test_valid_screenshot_passes_image_data_url_with_mime_prefix() -> None:
    """Test 2: Request with a valid tiny PNG passes image_data_url='data:image/png;base64,...'."""
    png_bytes = _make_png(100, 100)
    b64_png = base64.b64encode(png_bytes).decode("ascii")

    ssg_payload = base_ssg(
        attachment={
            "screenshot": {
                "format": "png",
                "w": 100,
                "h": 100,
                "redacted": True,
                "data": b64_png,
            }
        }
    )

    mock_complete = AsyncMock(return_value=dummy_llm_result())

    with (
        patch.object(llm.config, "api_key", "test-key"),
        patch("app.main.llm.complete", mock_complete),
    ):
        resp = client.post("/v1/agent/step", json=ssg_payload)
        assert resp.status_code == 200
        mock_complete.assert_called_once()
        _, kwargs = mock_complete.call_args
        assert kwargs["image_data_url"] is not None
        assert kwargs["image_data_url"].startswith("data:image/png;base64,")
        # Verify base64 decodes back to original PNG
        extracted_b64 = kwargs["image_data_url"].split("base64,")[1]
        assert base64.b64decode(extracted_b64) == png_bytes


def test_invalid_screenshot_rejected_without_calling_llm() -> None:
    """Test 3: Malformed image bytes are rejected with 422 and LLM is not called."""
    bad_bytes = b"not_a_valid_png_content_at_all"
    b64_bad = base64.b64encode(bad_bytes).decode("ascii")

    ssg_payload = base_ssg(
        attachment={
            "screenshot": {
                "format": "png",
                "w": 100,
                "h": 100,
                "redacted": True,
                "data": b64_bad,
            }
        }
    )

    mock_complete = AsyncMock(return_value=dummy_llm_result())

    with (
        patch.object(llm.config, "api_key", "test-key"),
        patch("app.main.llm.complete", mock_complete),
    ):
        resp = client.post("/v1/agent/step", json=ssg_payload)
        assert resp.status_code == 422
        body = resp.json()
        assert body["error"] == "IMAGE_INVALID"
        mock_complete.assert_not_called()


def test_oversized_screenshot_rejected() -> None:
    """Test 4: Screenshot exceeding size limit (10MB) is rejected with 422."""
    # Create fake oversized PNG bytes (> 10MB) starting with valid magic
    oversized_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * (10 * 1024 * 1024 + 10)
    b64_oversized = base64.b64encode(oversized_bytes).decode("ascii")

    ssg_payload = base_ssg(
        attachment={
            "screenshot": {
                "format": "png",
                "w": 100,
                "h": 100,
                "redacted": True,
                "data": b64_oversized,
            }
        }
    )

    mock_complete = AsyncMock(return_value=dummy_llm_result())

    with (
        patch.object(llm.config, "api_key", "test-key"),
        patch("app.main.llm.complete", mock_complete),
    ):
        resp = client.post("/v1/agent/step", json=ssg_payload)
        assert resp.status_code == 422
        body = resp.json()
        assert body["error"] == "IMAGE_INVALID"
        assert "too large" in body["detail"]
        mock_complete.assert_not_called()
