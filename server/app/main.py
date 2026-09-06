"""
Minimal FastAPI skeleton (F1 in IMPLEMENTATION-PLAN.md), trimmed for a
4-day build: no Redis session store, no SSE streaming, no OTel yet.
Those are additive - this endpoint's request/response shape won't need
to change when they're added later.
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.schemas import SSGRequest, ActionPlan
from app.agents.grounder import ground, GroundingError

app = FastAPI(title="PRAHARI Server (hackathon build)")


class StepResponse(BaseModel):
    plan: ActionPlan
    violations: list[str]  # non-empty means some model actions were dropped


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/agent/step", response_model=StepResponse)
def agent_step(ssg: SSGRequest):
    if ssg.ssg_version != "1.0":
        raise HTTPException(status_code=409, detail="Unsupported ssg_version")

    try:
        plan, violations = ground(ssg)
    except GroundingError as e:
        raise HTTPException(status_code=502, detail=str(e))

    return StepResponse(plan=plan, violations=violations)