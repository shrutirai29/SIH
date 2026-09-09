"""MANTRI — the PRAHARI planning server (ticket F1).

Request path, in order, and none of it is optional:

    schema validate  ->  INGRESS GUARD  ->  injection screen  ->  prompt
                     ->  model          ->  post-validate     ->  plan

The ingress guard is the interesting one. It runs the same PII pack the client runs,
on a server we control, against data the client swears is clean. It is not defence
against a hostile client — a hostile client would simply not send us anything. It is
defence against our own bugs, which is the failure mode that actually occurs, and it
is the honest answer to "how do you know your redactor works": the receiver checks,
independently, every time.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.agents.grounder import build_user_prompt, make_validator, system_prompt
from app.guards.ingress_pii import contains_pii, first_class
from app.llm.client import LlmClient, LlmError
from app.schemas.action_plan import ActionPlan
from app.schemas.ssg import SanitizedScreenGraph

SUPPORTED_SSG_MAJOR = "1"

_SCHEMA_DIR = Path(__file__).resolve().parents[2] / "packages" / "ssg" / "schema"
ACTION_PLAN_SCHEMA: dict[str, Any] = json.loads(
    (_SCHEMA_DIR / "action-plan-v1.json").read_text(encoding="utf-8")
)

app = FastAPI(title="MANTRI", version="0.1.0")

# The extension is the only caller and it sends from an extension origin, which is
# opaque. There is no cookie, no session, and nothing to protect with SOP here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

llm = LlmClient()

# Measured, never assumed (see llm/client.py). Reported at /v1/metrics.
_stats = {
    "requests": 0,
    "plans": 0,
    "schema_first_try": 0,
    "retries": 0,
    "redactor_failures": 0,
    "by_mode": {},
}


def _plan_schema_validate(plan: dict[str, Any]) -> str | None:
    """Validates against the generated Pydantic model, returning a readable complaint.

    The complaint text goes back to the model on a retry, so it is phrased for a
    reader rather than a log.
    """
    try:
        ActionPlan.model_validate(plan)
    except ValidationError as exc:
        first = exc.errors()[0]
        location = ".".join(str(p) for p in first["loc"])
        return f"{location or 'plan'}: {first['msg']}"
    return None


@app.get("/v1/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "ssg_versions": ["1.0"],
        "model": llm.config.model if llm.config.configured else "not configured",
        "llm_configured": llm.config.configured,
    }


@app.get("/v1/models")
async def models() -> dict[str, Any]:
    """Reports honestly what is loaded, so the UI never overstates the system."""
    return {
        "planner": llm.config.model if llm.config.configured else None,
        "base_url": llm.config.base_url,
        "configured": llm.config.configured,
        "note": (
            "Cloud-hosted open weights (R9 permits this during SIH). The offline "
            "docker compose serves the same weights via vLLM."
        ),
    }


@app.get("/v1/metrics")
async def metrics() -> dict[str, Any]:
    total = _stats["plans"] or 1
    return {
        **_stats,
        "schema_validity_first_try": round(_stats["schema_first_try"] / total, 4),
    }


@app.post("/v1/agent/step")
async def agent_step(request: Request) -> Response:
    _stats["requests"] += 1
    started = time.monotonic()

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            {"error": "SSG_INVALID", "detail": "body is not JSON"}, status_code=400
        )

    # ---- version -----------------------------------------------------------
    version = str(body.get("ssg_version", ""))
    if version.split(".")[0] != SUPPORTED_SSG_MAJOR:
        return JSONResponse(
            {"error": "VERSION_MISMATCH", "detail": "unsupported ssg_version"},
            status_code=409,
        )

    # ---- schema ------------------------------------------------------------
    try:
        SanitizedScreenGraph.model_validate(body)
    except ValidationError as exc:
        first = exc.errors()[0]
        return JSONResponse(
            {
                "error": "SSG_INVALID",
                # Path only. The value is exactly what we must not echo.
                "detail": ".".join(str(p) for p in first["loc"]) + ": " + first["msg"],
            },
            status_code=400,
        )

    # ---- ★ INGRESS GUARD ★ -------------------------------------------------
    raw = json.dumps(body, ensure_ascii=False)
    if contains_pii(raw):
        cls = first_class(raw)
        _stats["redactor_failures"] += 1
        # Loud, dated, attributable. Never the value (RULES.md P9).
        print(
            "[ingress-guard] REDACTOR_FAILURE class="
            + str(cls)
            + " trace="
            + str(body.get("trace_id")),
            flush=True,
        )
        return JSONResponse(
            {"error": "REDACTOR_FAILURE", "detail": "class=" + str(cls)},
            status_code=422,
        )

    if not llm.config.configured:
        return JSONResponse(
            {
                "error": "MODEL_UNAVAILABLE",
                "detail": "PRAHARI_LLM_API_KEY is not set",
            },
            status_code=503,
        )

    # ---- plan --------------------------------------------------------------
    try:
        result = await llm.complete(
            system=system_prompt(),
            user=build_user_prompt(body),
            schema=ACTION_PLAN_SCHEMA,
            validate=make_validator(body, _plan_schema_validate),
        )
    except LlmError as exc:
        return JSONResponse(
            {"error": "MODEL_UNAVAILABLE", "detail": str(exc)}, status_code=503
        )

    plan = dict(result.plan)
    # The client correlates on trace_id; a model that omits or invents one would
    # otherwise strand the step.
    plan["trace_id"] = body.get("trace_id", "t_0")
    plan.setdefault("plan_id", "p_" + str(body.get("step", 0)))

    _stats["plans"] += 1
    if result.attempts == 1:
        _stats["schema_first_try"] += 1
    else:
        _stats["retries"] += result.attempts - 1
    _stats["by_mode"][result.mode.value] = _stats["by_mode"].get(result.mode.value, 0) + 1

    print(
        "[step] trace={} step={} tier={} elements={} -> {} ({}, {} attempt(s), {}ms)".format(
            body.get("trace_id"),
            body.get("step"),
            body.get("tier"),
            len(body.get("elements", [])),
            ",".join(a.get("op", "?") for a in plan.get("actions", [])),
            result.mode.value,
            result.attempts,
            int((time.monotonic() - started) * 1000),
        ),
        flush=True,
    )

    return JSONResponse(plan)


def main() -> None:
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("PRAHARI_HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8081")),
        log_level="info",
    )


if __name__ == "__main__":
    main()
