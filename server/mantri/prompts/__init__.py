"""Prompt loading (ticket G1).

The grounder's system prompt is the base redaction contract in
`app/agents/prompts/system.md` **plus** the MANTRI addenda in this folder. It is
composed at call time rather than stored as a third copy, because the failure mode of
duplicated prompts is silent: two files that were the same when they were written, one
of which is now what the model actually reads.

Loads are cached. The prompt is on the hot path of every step and it does not change
between requests; re-reading it per step would put a disk hit inside the latency budget
for no benefit. Restart the server to pick up an edit.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

__all__ = ["grounder_system_prompt", "planner_system_prompt", "addenda", "base_contract"]

_HERE = Path(__file__).parent
_BASE = _HERE.parents[1] / "app" / "agents" / "prompts" / "system.md"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


@lru_cache(maxsize=1)
def base_contract() -> str:
    """The redaction contract MANTRI shares with the rest of the server."""
    return _read(_BASE)


@lru_cache(maxsize=1)
def addenda() -> str:
    """Sub-goal and recovery sections, with the HTML rationale comment stripped.

    The comment explains the file to a maintainer. Sending it to the model would spend
    tokens telling it about our source layout.
    """
    text = _read(_HERE / "grounder-addenda.md")
    if text.startswith("<!--"):
        _, _, rest = text.partition("-->")
        text = rest.strip()
    return text


@lru_cache(maxsize=1)
def grounder_system_prompt() -> str:
    return base_contract() + "\n\n---\n\n" + addenda()


@lru_cache(maxsize=1)
def planner_system_prompt() -> str:
    return _read(_HERE / "planner.md")
