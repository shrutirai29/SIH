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

import base64
import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

# The prompt itself now comes from `mantri.prompts`, which composes this contract with
# MANTRI's sub-goal and recovery sections (ticket G1).
from app.agents.grounder import build_user_prompt, make_validator
from app.guards.ingress_pii import contains_pii, first_class
from app.guards.image_sanity import check_image_sanity
from app.llm.client import LlmClient, LlmError
from app.schemas.action_plan import ActionPlan
from app.schemas.ssg import SanitizedScreenGraph
from mantri import MantriConfig, SubGoalCache, plan_step

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

# MANTRI's reasoning layer (EPIC G). The cache is process-local and TTL-bounded; it
# becomes the Redis session store when F6 lands, which is why nothing else reaches
# into it.
mantri_config = MantriConfig()
subgoal_cache = SubGoalCache(mantri_config.planner)

# Measured, never assumed (see llm/client.py). Reported at /v1/metrics.
_stats: dict[str, Any] = {
    "requests": 0,
    "plans": 0,
    "schema_first_try": 0,
    "retries": 0,
    "redactor_failures": 0,
    "by_mode": {},
    # MANTRI (EPIC G). Counted, not claimed: the injection tally is what lets us say
    # how often a real page attacks the agent instead of guessing.
    "by_route": {},
    "planner_calls": 0,
    "injection_suspicious": 0,
    "injection_hostile": 0,
    "recovered_to_ask_user": 0,
    # The two costs MANTRI is allowed to incur on the user's latency budget: a planner
    # call that ran out of budget, and a step retried on the vision model because the
    # text description did not ground. Both are counted so the budget argument can be
    # settled with numbers when H6 lands.
    "planner_timeouts": 0,
    "escalated_to_vision": 0,
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


@app.get("/demo")
async def demo_portal() -> Response:
    """Serves the test government portal locally over standard HTTP.

    This avoids Chrome file:// scheme restrictions on unpacked extensions.
    """
    portal_file = (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "eval"
        / "fixtures"
        / "demo-portal.html"
    )
    if not portal_file.exists():
        return JSONResponse({"error": "PORTAL_NOT_FOUND"}, status_code=404)
    return Response(content=portal_file.read_bytes(), media_type="text/html")


@app.get("/v1/metrics")
async def metrics() -> dict[str, Any]:
    total = _stats["plans"] or 1
    return {
        **_stats,
        "schema_validity_first_try": round(_stats["schema_first_try"] / total, 4),
    }


@app.post("/v1/image/verify")
async def verify_image(request: Request) -> Response:
    """Validates an uploaded screenshot PNG is structurally sound.

    Accepts raw PNG bytes in the request body. Returns 200 if valid, 422 if not.
    This is the server-side half of the image safety pipeline (ticket F5).
    """
    body = await request.body()
    result = check_image_sanity(body)
    if result.ok:
        return JSONResponse({"ok": True})
    return JSONResponse(
        {"error": "IMAGE_INVALID", "detail": result.detail},
        status_code=422,
    )


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

    # ---- image sanity guard (ticket F5) ------------------------------------
    image_data_url: str | None = None
    attachment = body.get("attachment")
    if attachment and isinstance(attachment, dict):
        raw_img = (
            attachment.get("data")
            or (attachment.get("screenshot", {}).get("data") if isinstance(attachment.get("screenshot"), dict) else None)
            or attachment.get("data_url")
            or (attachment.get("screenshot", {}).get("data_url") if isinstance(attachment.get("screenshot"), dict) else None)
        )
        if raw_img:
            if isinstance(raw_img, bytes):
                img_bytes = raw_img
                b64_part = base64.b64encode(img_bytes).decode("ascii")
                mime = "image/png"
            elif isinstance(raw_img, str):
                if raw_img.startswith("data:"):
                    header, _, b64_part = raw_img.partition(",")
                    mime = header.split(";")[0].replace("data:", "").strip() or "image/png"
                else:
                    b64_part = raw_img
                    mime = "image/png"
                try:
                    img_bytes = base64.b64decode(b64_part)
                except Exception:
                    return JSONResponse(
                        {"error": "IMAGE_INVALID", "detail": "failed to decode base64 image data"},
                        status_code=422,
                    )
            else:
                return JSONResponse(
                    {"error": "IMAGE_INVALID", "detail": "unsupported image data type"},
                    status_code=422,
                )

            # Validate structural sanity
            sanity = check_image_sanity(img_bytes)
            if not sanity.ok:
                return JSONResponse(
                    {"error": "IMAGE_INVALID", "detail": sanity.detail},
                    status_code=422,
                )

            image_data_url = f"data:{mime};base64,{b64_part.strip()}"

    if not llm.config.configured:
        return JSONResponse(
            {
                "error": "MODEL_UNAVAILABLE",
                "detail": "PRAHARI_LLM_API_KEY is not set",
            },
            status_code=503,
        )

    # ---- plan (MANTRI, EPIC G) ---------------------------------------------
    #
    # Injection screen, routing, sub-goal, prompt assembly, recovery: all of it lives
    # in `mantri/` and none of it lives here. This handler's remaining job is the HTTP
    # envelope and the metrics.
    try:
        decision = await plan_step(
            body,
            llm=llm,
            action_plan_schema=ACTION_PLAN_SCHEMA,
            build_user_prompt=build_user_prompt,
            make_validator=lambda ssg: make_validator(ssg, _plan_schema_validate),
            cache=subgoal_cache,
            config=mantri_config,
            image_data_url=image_data_url,
            contains_pii=contains_pii,
        )
    except LlmError as exc:
        return JSONResponse(
            {"error": "MODEL_UNAVAILABLE", "detail": str(exc)}, status_code=503
        )

    plan = dict(decision.plan)
    # The client correlates on trace_id; a model that omits or invents one would
    # otherwise strand the step.
    plan["trace_id"] = body.get("trace_id", "t_0")
    plan.setdefault("plan_id", "p_" + str(body.get("step", 0)))

    _stats["plans"] += 1
    if decision.attempts == 1:
        _stats["schema_first_try"] += 1
    else:
        _stats["retries"] += decision.attempts - 1
    _stats["by_mode"][decision.mode] = _stats["by_mode"].get(decision.mode, 0) + 1

    route_name = decision.route.path.value
    _stats["by_route"][route_name] = _stats["by_route"].get(route_name, 0) + 1
    if decision.planner_called:
        _stats["planner_calls"] += 1
    if decision.injection.verdict.value == "hostile":
        _stats["injection_hostile"] += 1
    elif decision.injection.verdict.value == "suspicious":
        _stats["injection_suspicious"] += 1
    if decision.recovered:
        _stats["recovered_to_ask_user"] += 1
    if decision.planner_timed_out:
        _stats["planner_timeouts"] += 1
    if decision.escalated:
        _stats["escalated_to_vision"] += 1

    # The injection verdict is logged as families and field paths, never as the text
    # that matched (mantri/injection.py explains why).
    print(
        "[step] trace={} step={} tier={} elements={} -> {} ({}, {} attempt(s), {}ms) "
        "mantri={}".format(
            body.get("trace_id"),
            body.get("step"),
            body.get("tier"),
            len(body.get("elements", [])),
            ",".join(a.get("op", "?") for a in plan.get("actions", [])),
            decision.mode,
            decision.attempts,
            int((time.monotonic() - started) * 1000),
            json.dumps(decision.to_log(), ensure_ascii=False),
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
