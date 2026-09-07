"""
G7-equivalent: the grounder. Given the current SSG (simplified), calls the
LLM and returns a validated ActionPlan.

Post-validation (F7 in IMPLEMENTATION-PLAN.md) is deliberately done here in
Python, separately from the prompt - never trust the model's own claim that
it followed the rules. This mirrors the project's core principle: verify,
don't assume (ARCHITECTURE.md §4.1).
"""
import os
import re
import json
import uuid
from dotenv import load_dotenv
from groq import Groq

from app.schemas import SSGRequest, ActionPlan, PlanAction
from app.agents.prompts import SYSTEM_PROMPT, FEW_SHOT_EXAMPLES

load_dotenv()

MODEL_NAME = "openai/gpt-oss-20b"  # text-only fast path (Tier 1) - see ARCHITECTURE.md §7.1

# A value_ref must look like a redaction token, e.g. "⟦AADHAAR_1⟧".
# Anything else (a real name, a 12-digit number, an email) is a literal-PII
# exfiltration attempt and must be rejected client-side per S5 in RULES.md.
TOKEN_PATTERN = re.compile(r"^\u27e6[A-Z0-9_]+\u27e7$")


class GroundingError(Exception):
    """Raised when the model output cannot be trusted, even after retry."""


def get_client() -> Groq:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise ValueError("GROQ_API_KEY not found in .env")
    return Groq(api_key=api_key)


def build_user_message(ssg: SSGRequest) -> str:
    elements_json = json.dumps(
        [e.model_dump(exclude_none=True) for e in ssg.elements],
        ensure_ascii=False,
    )
    history_json = json.dumps(
        [h.model_dump() for h in ssg.history],
        ensure_ascii=False,
    )
    return f"""GOAL: {ssg.goal}

ELEMENTS:
{elements_json}

HISTORY:
{history_json}"""


def extract_json(raw_text: str) -> dict:
    cleaned = raw_text.strip()
    cleaned = re.sub(r"^```(json)?", "", cleaned).strip()
    cleaned = re.sub(r"```$", "", cleaned).strip()
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        cleaned = match.group()
    return json.loads(cleaned)


def call_model(client: Groq, ssg: SSGRequest) -> dict:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(FEW_SHOT_EXAMPLES)
    messages.append({"role": "user", "content": build_user_message(ssg)})

    response = client.chat.completions.create(
        model=MODEL_NAME,
        messages=messages,
        temperature=0.1,
        reasoning_effort="low",
        max_completion_tokens=1500,
    )

    raw_output = response.choices[0].message.content
    return extract_json(raw_output)


def post_validate(parsed: dict, ssg: SSGRequest) -> list[str]:
    """
    Returns a list of violation strings. Empty list = plan is safe to use.
    This is F7: targets exist, no literal PII, risk not de-escalated.
    """
    violations = []
    valid_ids = {e.id for e in ssg.elements}
    risk_by_id = {e.id: e.client_risk for e in ssg.elements}

    for action in parsed.get("actions", []):
        target = action.get("target")

        # Rule: target must exist in the elements we actually sent
        if target is not None and target not in valid_ids:
            violations.append(f"Action references unknown target '{target}' - rejected.")
            continue

        # Rule: value_ref must be a token, never a literal value
        value_ref = action.get("value_ref")
        if value_ref is not None and not TOKEN_PATTERN.match(value_ref):
            violations.append(
                f"Action on '{target}' has a non-token value_ref '{value_ref}' - "
                f"possible literal-PII exfiltration attempt, rejected."
            )

        # Rule: risk may only escalate, never de-escalate (S2 in RULES.md)
        original_risk = risk_by_id.get(target)
        model_risk = action.get("risk")
        risk_rank = {"low": 0, "medium": 1, "high": 2, None: -1}
        if original_risk and risk_rank.get(model_risk, -1) < risk_rank.get(original_risk, -1):
            violations.append(
                f"Action on '{target}' de-escalated risk from '{original_risk}' "
                f"to '{model_risk}' - rejected."
            )

    return violations


def ground(ssg: SSGRequest) -> ActionPlan:
    """
    Main entry point: SSG in, validated ActionPlan out.
    Raises GroundingError if the model output can't be trusted even after
    stripping violating actions.
    """
    client = get_client()

    try:
        parsed = call_model(client, ssg)
    except (json.JSONDecodeError, AttributeError) as e:
        raise GroundingError(f"Model did not return parseable JSON: {e}")

    violations = post_validate(parsed, ssg)

    # Fail closed: drop any action that violates a rule, keep the rest.
    safe_actions = []
    valid_ids = {e.id for e in ssg.elements}
    for action in parsed.get("actions", []):
        target = action.get("target")
        value_ref = action.get("value_ref")
        is_valid_target = target is None or target in valid_ids
        is_valid_value = value_ref is None or TOKEN_PATTERN.match(value_ref)
        if is_valid_target and is_valid_value:
            safe_actions.append(PlanAction(**action))

    return ActionPlan(
        plan_id=f"p_{uuid.uuid4().hex[:8]}",
        trace_id=ssg.trace_id,
        reasoning=parsed.get("reasoning", ""),
        actions=safe_actions,
        done=parsed.get("done", False),
        confidence=parsed.get("confidence", 0.0),
    ), violations