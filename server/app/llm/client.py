"""OpenAI-compatible client for the remote planner (tickets F3, G4).

## Why not vLLM + XGrammar here

`IMPLEMENTATION-PLAN.md` F3 assumes vLLM's guided decoding, which makes invalid JSON
*structurally impossible*. During SIH we run against a cloud-hosted endpoint of the
same open weights, which R9 explicitly permits — and cloud endpoints expose, at best,
OpenAI-style `response_format`. That is a weaker guarantee.

So we implement three tiers and record which one actually ran, because
"100% schema-valid by construction" is only true of the first:

    STRICT   json_schema response_format — the provider enforces the grammar
    JSON     json_object — valid JSON, but the shape is on us
    RETRY    validate, and on failure re-ask with the validator's complaint

`schema_validity_rate` is measured, not assumed. When we move to self-hosted vLLM for
the air-gapped build, STRICT becomes the guarantee the plan describes and the retry
path becomes dead code we keep for the cloud configuration.

## Keys

`PRAHARI_LLM_API_KEY` is read from the environment and never logged, never returned
in an error, and never sent anywhere but the configured base URL.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import httpx


class DecodeMode(str, Enum):
    """How the provider was asked to constrain output. Reported in metrics."""

    STRICT = "strict_json_schema"
    JSON = "json_object"
    RETRY = "validate_and_retry"


@dataclass
class LlmConfig:
    base_url: str = os.environ.get(
        "PRAHARI_LLM_BASE_URL", "https://openrouter.ai/api/v1"
    )
    model: str = os.environ.get("PRAHARI_LLM_MODEL", "qwen/qwen2.5-vl-72b-instruct")
    api_key: str = field(
        default_factory=lambda: os.environ.get("PRAHARI_LLM_API_KEY", "")
    )
    temperature: float = 0.0
    max_tokens: int = 900
    timeout_s: float = 60.0
    # Providers differ; probed once and cached rather than assumed.
    prefer_strict: bool = True

    @property
    def configured(self) -> bool:
        return bool(self.api_key)


@dataclass
class LlmResult:
    plan: dict[str, Any]
    mode: DecodeMode
    attempts: int
    model: str
    tokens_in: int
    tokens_out: int
    latency_ms: int
    raw: str


class LlmError(RuntimeError):
    """Never carries provider response bodies: they can echo the prompt back."""


_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.MULTILINE)


def extract_json(text: str) -> dict[str, Any]:
    """Pulls one JSON object out of a model response.

    Models wrap JSON in fences, prefix it with prose, or append a closing remark
    despite being told not to. Being liberal here costs nothing: the result is
    schema-validated immediately afterwards, so a wrong parse cannot become a wrong
    action.
    """
    cleaned = _FENCE.sub("", text).strip()
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # Fall back to the outermost balanced object.
    start = cleaned.find("{")
    if start < 0:
        raise LlmError("no JSON object in response")
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(cleaned)):
        ch = cleaned[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = cleaned[start : i + 1]
                try:
                    parsed = json.loads(candidate)
                except json.JSONDecodeError as exc:
                    raise LlmError("response was not valid JSON") from exc
                if isinstance(parsed, dict):
                    return parsed
                raise LlmError("response JSON was not an object")
    raise LlmError("unbalanced JSON in response")


class LlmClient:
    def __init__(self, config: LlmConfig | None = None) -> None:
        self.config = config or LlmConfig()
        self._strict_supported: bool | None = None

    def _headers(self) -> dict[str, str]:
        return {
            "authorization": "Bearer " + self.config.api_key,
            "content-type": "application/json",
            # OpenRouter asks for these; harmless elsewhere.
            "http-referer": "https://prahari.dev",
            "x-title": "PRAHARI",
        }

    async def complete(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
        validate: Any,
        image_data_url: str | None = None,
    ) -> LlmResult:
        """Asks for one action plan, escalating through the decode tiers.

        `validate` is a callable returning None on success or a human-readable
        complaint on failure. The complaint is fed back to the model verbatim on the
        retry: telling it *what* was wrong works far better than asking again.
        """
        if not self.config.configured:
            raise LlmError(
                "PRAHARI_LLM_API_KEY is not set. See server/README.md for setup."
            )

        content: Any = user
        if image_data_url is not None:
            content = [
                {"type": "text", "text": user},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ]

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ]

        attempts = 0
        rate_limit_retries = 0
        server_error_retries = 0
        last_complaint: str | None = None

        async with httpx.AsyncClient(timeout=self.config.timeout_s) as http:
            modes = list(self._modes())
            mi = 0
            while mi < len(modes):
                mode = modes[mi]
                mi += 1
                attempts += 1
                body = self._body(messages, mode, schema)

                import time

                started = time.monotonic()
                try:
                    response = await http.post(
                        self.config.base_url.rstrip("/") + "/chat/completions",
                        headers=self._headers(),
                        json=body,
                    )
                except httpx.TimeoutException:
                    raise LlmError("provider connection timed out")
                except httpx.RequestError as exc:
                    raise LlmError(f"provider network error: {type(exc).__name__}")
                latency_ms = int((time.monotonic() - started) * 1000)

                if response.status_code == 400 and mode is DecodeMode.STRICT:
                    # The provider does not support json_schema for this model. Note
                    # it so later requests skip straight to the weaker tier.
                    #
                    # Not an attempt at the task: the model never saw the prompt. Left
                    # counted, it pushed every first real attempt to `attempts == 2`,
                    # and `/v1/metrics` reports `schema_validity_first_try` off exactly
                    # that field — so a number we intend to publish was understating
                    # itself by one whole tier on every provider without json_schema.
                    self._strict_supported = False
                    attempts -= 1
                    continue
                if response.status_code == 429:
                    # Rate limited. Cloud providers throttle aggressively on free
                    # tiers, and a spike that reports a behavioural FAILURE because
                    # of a 429 is reporting a lie about the model. Back off and
                    # retry rather than let it pollute the result.
                    if rate_limit_retries < 3:
                        rate_limit_retries += 1
                        await asyncio.sleep(2.0 * rate_limit_retries)
                        attempts -= 1  # a throttle is not an attempt at the task
                        mi -= 1  # retry the same tier
                        continue
                    raise LlmError("provider rate-limited after 3 backoffs")

                if response.status_code in (502, 503, 504):
                    # Transient gateway / provider server errors.
                    if server_error_retries < 2:
                        server_error_retries += 1
                        await asyncio.sleep(1.0 * server_error_retries)
                        attempts -= 1  # a transport failure is not an attempt at the task
                        mi -= 1  # retry the same tier
                        continue
                    raise LlmError("provider returned HTTP " + str(response.status_code))

                if response.status_code >= 400:
                    raise LlmError("provider returned HTTP " + str(response.status_code))

                payload = response.json()
                raw = payload["choices"][0]["message"]["content"] or ""
                usage = payload.get("usage") or {}

                try:
                    plan = extract_json(raw)
                    complaint = validate(plan)
                except LlmError as exc:
                    complaint = str(exc)
                    plan = {}

                if complaint is None:
                    if mode is DecodeMode.STRICT:
                        self._strict_supported = True
                    return LlmResult(
                        plan=plan,
                        mode=mode,
                        attempts=attempts,
                        model=payload.get("model", self.config.model),
                        tokens_in=int(usage.get("prompt_tokens", 0)),
                        tokens_out=int(usage.get("completion_tokens", 0)),
                        latency_ms=latency_ms,
                        raw=raw,
                    )

                last_complaint = complaint
                # Show the model its own output and the exact objection. Asking again
                # with no feedback mostly reproduces the same mistake.
                messages = messages[:2] + [
                    {"role": "assistant", "content": raw},
                    {
                        "role": "user",
                        "content": (
                            "That response was rejected by the schema validator:\n"
                            + complaint
                            + "\n\nReturn only the corrected JSON object. "
                            "Every `target` must be an element id present in the "
                            "screen description above."
                        ),
                    },
                ]

        raise LlmError(
            "no schema-valid plan after " + str(attempts) + " attempts: "
            + (last_complaint or "unknown")
        )

    def _modes(self) -> list[DecodeMode]:
        if self._strict_supported is False or not self.config.prefer_strict:
            return [DecodeMode.JSON, DecodeMode.RETRY]
        return [DecodeMode.STRICT, DecodeMode.JSON, DecodeMode.RETRY]

    def _body(
        self, messages: list[dict[str, Any]], mode: DecodeMode, schema: dict[str, Any]
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens,
        }
        if mode is DecodeMode.STRICT:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "action_plan",
                    "strict": True,
                    "schema": schema,
                },
            }
        elif mode is DecodeMode.JSON:
            body["response_format"] = {"type": "json_object"}
        return body
