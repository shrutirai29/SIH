"""Failure-recovery prompting and the ask_user policy (ticket G8).

Two kinds of failure reach MANTRI, and they need opposite treatments.

**The model produced a bad plan.** Post-validation caught it and we are about to ask
again. Asking again with the same prompt is close to useless - the model will usually
produce the same thing. What works is telling it exactly what was wrong *and what to do
instead*, which is why `hint_for_complaint` maps each validator complaint to a
corrective instruction rather than repeating the objection.

**The plan was fine and the page did not move.** The client reports `no_change`,
`error` or `blocked` in history. The model cannot see why - it never sees the page, only
our description of it - so the hint has to name the specific loop it is in.

## The ladder, and why it ends where it does

    attempt 1   plain prompt
    attempt 2   prompt + the specific complaint and its correction
    attempt 3   prompt + complaint + "prefer scroll/wait; ask_user is acceptable"
    give up     the server synthesises an ask_user plan itself

The last rung is the one that matters. A model that has failed three times on a
government portal is not going to succeed on the fourth, and every extra attempt is
another chance to emit something the client has to refuse. Handing the user a question
is a *correct* outcome, not a failure to plan - and synthesising it server-side means
that outcome does not itself depend on the model finally producing valid JSON.

`ask_user` plans are built here rather than in the model, so they are always
schema-valid, always carry the right `trace_id`, and never carry a value.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

__all__ = [
    "RecoveryHint",
    "hint_for_complaint",
    "hints_from_history",
    "stalled_on",
    "should_ask_user",
    "ask_user_plan",
    "fail_plan",
]


@dataclass(frozen=True)
class RecoveryHint:
    text: str
    rung: int


# Complaint -> correction. The keys are substrings of the complaints
# `agents/grounder.make_validator` produces; each value says what to do instead,
# because "that was wrong" without "do this" reliably produces a second wrong answer.
_CORRECTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"is not on this screen", re.I),
        "You referenced an element id that does not exist. Use only ids from the "
        "elements list you were given. If the control you want is not listed, it is "
        "off-screen: emit a `scroll` action instead, or `ask_user` if scrolling has "
        "already failed.",
    ),
    (
        re.compile(r"does not appear on this screen", re.I),
        "You invented a reference. References are not names you can construct - they "
        "are given to you in element values. Use one that is present, or `ask_user`.",
    ),
    (
        re.compile(r"marks a credential", re.I),
        "That reference is a destroyed credential: nothing on this machine or any "
        "other can resolve it. The only correct move is `ask_user` asking the person "
        "to enter it themselves.",
    ),
    (
        re.compile(r"looks like a real personal identifier", re.I),
        "Never write personal data as a literal `value`. Use `value_ref` with a "
        "reference shown on screen. If no reference holds what you need, `ask_user`.",
    ),
    (
        re.compile(r"may raise risk but never lower it", re.I),
        "Restate the action with a risk at least as high as the client's. Lowering "
        "risk does not make the action run - it only makes the plan invalid.",
    ),
    (
        re.compile(r"`actions` is empty", re.I),
        "You returned no actions and did not mark the task done, which spends the "
        "step and leaves the screen exactly as it was. Pick the single control that "
        "moves the task forward. If none can, that is still an answer: `ask_user` "
        "with a plain question, or `fail` with a reason.",
    ),
    (
        re.compile(r"cannot be (click|type|select)ed|not actionable at all", re.I),
        "The page says that control cannot do what you asked - a disabled button is "
        "usually waiting on something above it, like a required field or an unticked "
        "declaration. Do that first: act on an element whose `actionable` list "
        "contains the op you want.",
    ),
    (
        re.compile(r"At most 3 actions", re.I),
        "Return at most three actions. Do the first step only; you will see the "
        "result and can continue on the next turn.",
    ),
)

_GENERIC = (
    "Your previous answer was rejected. Read the objection, fix exactly that, and "
    "return the corrected JSON object only."
)

_STALL_OUTCOMES = frozenset({"no_change", "error", "blocked"})


def hint_for_complaint(complaint: str, *, rung: int = 2) -> RecoveryHint:
    """Turns a validator complaint into a corrective instruction."""
    for pattern, correction in _CORRECTIONS:
        if pattern.search(complaint):
            text = correction
            break
    else:
        text = _GENERIC

    if rung >= 3:
        text += (
            " This is your last attempt. If you are unsure, do not guess a target - "
            "emit `ask_user` with a plain question, or `scroll` to look further."
        )
    return RecoveryHint(text=text, rung=rung)


def stalled_on(history: list[Any], *, window: int = 2) -> tuple[str | None, int]:
    """The target the last `window` steps kept failing on, and how many times.

    Returns `(None, 0)` when the tail shows progress. A repeated failure on the *same*
    target is a different problem from failures scattered across the page: the first is
    a control that does not do what we think, the second is a page we are reading
    wrong, and the hints below say so separately.
    """
    tail = [h for h in history[-window:] if isinstance(h, dict)]
    if len(tail) < window:
        return None, 0
    if not all(h.get("outcome") in _STALL_OUTCOMES for h in tail):
        return None, 0

    targets = {h.get("target") for h in tail}
    if len(targets) == 1:
        only = tail[0].get("target")
        return (only if isinstance(only, str) else None), len(tail)
    return None, len(tail)


def hints_from_history(history: list[Any] | None) -> list[RecoveryHint]:
    """Hints derived from what actually happened on the page, not from the model."""
    history = list(history or [])
    if not history:
        return []

    hints: list[RecoveryHint] = []
    target, count = stalled_on(history)

    if count >= 2 and target:
        hints.append(
            RecoveryHint(
                text=(
                    f"The last {count} attempts acted on '{target}' and the page did "
                    "not change. Do not act on it again. Either the control needs "
                    "something else first (a required field above it, a checkbox), or "
                    "it is not the right control. Try a different element, scroll to "
                    "look for one, or ask the user."
                ),
                rung=2,
            )
        )
    elif count >= 2:
        hints.append(
            RecoveryHint(
                text=(
                    f"The last {count} steps made no progress on different elements. "
                    "The screen description may be incomplete: prefer `scroll` or "
                    "`wait` over another click, and set `need_visual: true`."
                ),
                rung=2,
            )
        )

    last = history[-1]
    if isinstance(last, dict) and last.get("outcome") == "blocked":
        hints.append(
            RecoveryHint(
                text=(
                    "The last action was blocked by the user or by a client-side risk "
                    "gate. Do not retry it. Blocked means a human said no, or would "
                    "have to say yes first - plan around it or ask."
                ),
                rung=2,
            )
        )

    return hints


def should_ask_user(history: list[Any] | None, *, attempts: int = 1) -> bool:
    """Policy: when the server stops asking the model and asks the person.

    Either the model has burned the retry ladder on this step, or the page has refused
    to move twice in a row. Both mean the next model call is unlikely to be different.
    """
    if attempts >= 3:
        return True
    _, count = stalled_on(list(history or []))
    return count >= 2


def _envelope(ssg: dict[str, Any]) -> dict[str, Any]:
    step = ssg.get("step", 0)
    return {
        "plan_id": f"p_{step}_recovery",
        "trace_id": ssg.get("trace_id", "t_0"),
    }


def ask_user_plan(ssg: dict[str, Any], question: str, options: list[str] | None = None) -> dict[str, Any]:
    """A schema-valid plan that hands control back to the person.

    Built by the server, so it exists even when the model cannot produce valid JSON at
    all - which is exactly the situation in which we most need to stop cleanly.
    """
    action: dict[str, Any] = {"op": "ask_user", "question": question[:300]}
    if options:
        action["options"] = [o[:64] for o in options[:6]]

    return {
        **_envelope(ssg),
        "reasoning": "The server stopped the loop and asked the user (recovery policy G8).",
        "actions": [action],
        "done": False,
        "confidence": 0.0,
    }


def fail_plan(ssg: dict[str, Any], reason: str) -> dict[str, Any]:
    """A schema-valid plan that says, honestly, that this cannot be done.

    `reason` is written by us, never echoed from page content: an attacker who can
    choose the failure text can put an instruction in front of the user.
    """
    return {
        **_envelope(ssg),
        "reasoning": "The server ended the task (recovery policy G8).",
        "actions": [{"op": "fail", "reason": reason[:300]}],
        "done": True,
        "confidence": 0.0,
    }
