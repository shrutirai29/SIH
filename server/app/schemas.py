"""
Simplified SSG (Sanitized Screen Graph) and Action Plan schemas.

This is a deliberately trimmed-down subset of packages/ssg/schema/ssg-v1.json
and action-plan-v1.json for a 4-day hackathon build. Full fields like
visual_regions, text_blocks (OCR), and redaction_manifest are owned by
PRV/EXT and can be added here later without breaking this contract -
this schema is additive-safe by design (new optional fields only).
"""
from typing import Optional, Literal
from pydantic import BaseModel, Field


class ElementState(BaseModel):
    focused: bool = False
    disabled: bool = False
    required: bool = False
    invalid: bool = False


class SSGElement(BaseModel):
    id: str  # e.g. "e17"
    role: str  # e.g. "textbox", "button"
    tag: Optional[str] = None
    name: str  # accessible name, e.g. "Aadhaar Number"
    value: Optional[str] = None  # may contain a redaction token like "⟦AADHAAR_1⟧"
    placeholder: Optional[str] = None
    state: ElementState = Field(default_factory=ElementState)
    actionable: list[str] = Field(default_factory=list)  # e.g. ["type", "click"]
    client_risk: Optional[Literal["low", "medium", "high"]] = None
    risk_reason: Optional[str] = None


class HistoryStep(BaseModel):
    step: int
    action: str
    target: str
    outcome: str


class SSGRequest(BaseModel):
    ssg_version: str = "1.0"
    trace_id: str
    step: int
    goal: str
    page_type: Optional[str] = None  # e.g. "form"
    elements: list[SSGElement]
    history: list[HistoryStep] = Field(default_factory=list)


class PlanAction(BaseModel):
    op: Literal["click", "type", "scroll", "clear", "wait"]
    target: Optional[str] = None  # element id this action applies to
    value_ref: Optional[str] = None  # a TOKEN like "⟦AADHAAR_1⟧", never a literal
    risk: Optional[Literal["low", "medium", "high"]] = None
    reason: Optional[str] = None


class ActionPlan(BaseModel):
    plan_id: str
    trace_id: str
    reasoning: str
    actions: list[PlanAction]
    done: bool
    confidence: float