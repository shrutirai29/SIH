"""Ingress PII guard — the Python mirror of the client's L1 pack (ticket F4).

WHY A SERVER-SIDE CHECK ON A SERVER WE CONTROL

Because it turns a silent client bug into a loud, dated, attributable alert
(ARCHITECTURE.md §7.3). It is also the honest answer to "how do you know your
client works?" — the receiving end checks, independently, every time.

It is not defence against a malicious client. A malicious client would simply not
send us the data. It is defence against OUR OWN bugs, which is the failure mode
that actually happens.

DRIFT IS THE REAL RISK

This file duplicates logic that lives in
`packages/kavach/src/detectors/l1-regex/`. Two implementations of one rule set
diverge unless something forces them not to — and ours had already diverged on day
one, missing PHONE_IN, GSTIN and IFSC while the client caught all three. The parity
test in `tests/test_parity.py` runs both packs over a shared fixture corpus and
fails on any disagreement. Do not edit patterns here without editing them there.

The canonical pack is the TypeScript one. This mirrors it.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

# --------------------------------------------------------------------- validators


_VERHOEFF_D = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6),
    (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8),
    (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2),
    (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4),
    (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)

_VERHOEFF_P = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2),
    (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0),
    (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5),
    (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)

_BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_PAN_ENTITY_CODES = frozenset("PCHFATBLJG")
_EMAILISH_TLDS = frozenset(
    {"com", "org", "net", "in", "co", "io", "edu", "gov", "info", "dev"}
)


def verhoeff_validate(value: str) -> bool:
    """True when the final digit is a correct Verhoeff check digit."""
    if not value or not value.isdigit():
        return False
    checksum = 0
    for i, ch in enumerate(reversed(value)):
        checksum = _VERHOEFF_D[checksum][_VERHOEFF_P[i % 8][int(ch)]]
    return checksum == 0


def is_valid_aadhaar(value: str) -> bool:
    compact = re.sub(r"[\s-]", "", value)
    if not re.fullmatch(r"[2-9][0-9]{11}", compact):
        return False
    return verhoeff_validate(compact)


def luhn_validate(value: str) -> bool:
    compact = re.sub(r"[\s-]", "", value)
    if not re.fullmatch(r"[0-9]{2,}", compact):
        return False
    total = 0
    double = False
    for ch in reversed(compact):
        d = int(ch)
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return total % 10 == 0


def is_valid_card_number(value: str) -> bool:
    compact = re.sub(r"[\s-]", "", value)
    return bool(re.fullmatch(r"[0-9]{13,19}", compact)) and luhn_validate(compact)


def is_valid_imei(value: str) -> bool:
    compact = re.sub(r"[\s-]", "", value)
    return bool(re.fullmatch(r"[0-9]{15}", compact)) and luhn_validate(compact)


def is_valid_pan(value: str) -> bool:
    s = value.upper().strip()
    if not re.fullmatch(r"[A-Z]{5}[0-9]{4}[A-Z]", s):
        return False
    return s[3] in _PAN_ENTITY_CODES


def is_valid_gstin(value: str) -> bool:
    s = value.upper().strip()
    if not re.fullmatch(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]", s):
        return False
    if not 1 <= int(s[:2]) <= 38:
        return False
    if not is_valid_pan(s[2:12]):
        return False

    total = 0
    for i, ch in enumerate(s[:14]):
        value_i = _BASE36.index(ch)
        product = value_i * (1 if i % 2 == 0 else 2)
        total += product // 36 + product % 36
    return _BASE36[(36 - total % 36) % 36] == s[14]


def is_valid_ifsc(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]{4}0[A-Z0-9]{6}", value.upper().strip()))


def is_valid_upi_vpa(value: str) -> bool:
    s = value.lower().strip()
    if not re.fullmatch(r"[a-z0-9.\-_]{2,256}@[a-z]{2,64}", s):
        return False
    return s[s.index("@") + 1 :] not in _EMAILISH_TLDS


def is_valid_voter_id(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]{3}[0-9]{7}", value.upper().strip()))


def is_valid_passport_in(value: str) -> bool:
    return bool(re.fullmatch(r"[A-PR-WY][0-9]{7}", value.upper().strip()))


def is_valid_phone_in(value: str) -> bool:
    compact = re.sub(r"[\s-]", "", value)
    return bool(re.fullmatch(r"(?:\+?91)?[6-9][0-9]{9}", compact))


def is_valid_abha(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9]{14}", re.sub(r"[\s-]", "", value)))


def shannon_entropy(s: str) -> float:
    """Bits per character. Gates the generic secret detector."""
    if not s:
        return 0.0
    counts: dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    return -sum(
        (n / len(s)) * math.log2(n / len(s)) for n in counts.values()
    )


# ------------------------------------------------------------------------- pack


@dataclass(frozen=True)
class Pattern:
    cls: str
    regex: re.Pattern[str]
    validate: object | None = None
    confidence: float = 0.9


L1_PATTERNS: tuple[Pattern, ...] = (
    # --- India pack (checksum-validated where the scheme defines one) ---------
    Pattern("AADHAAR", re.compile(r"\b[2-9][0-9]{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b"), is_valid_aadhaar, 0.99),
    Pattern("GSTIN", re.compile(r"\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b"), is_valid_gstin, 0.99),
    Pattern("PAN", re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b"), is_valid_pan, 0.97),
    Pattern("IFSC", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b"), is_valid_ifsc, 0.95),
    # The trailing lookahead mirrors the client's: without it every ordinary email
    # is reported as a payment address.
    Pattern("UPI_VPA", re.compile(r"\b[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,64}\b(?!\.[a-zA-Z])"), is_valid_upi_vpa, 0.9),
    Pattern("ABHA", re.compile(r"\b[0-9]{2}-[0-9]{4}-[0-9]{4}-[0-9]{4}\b"), is_valid_abha, 0.95),
    Pattern("VOTER_ID", re.compile(r"\b[A-Z]{3}[0-9]{7}\b"), is_valid_voter_id, 0.9),
    Pattern("PASSPORT_IN", re.compile(r"\b[A-PR-WY][0-9]{7}\b"), is_valid_passport_in, 0.85),
    Pattern("PHONE_IN", re.compile(r"(?:\+?91[\s-]?)?\b[6-9][0-9]{9}\b"), is_valid_phone_in, 0.9),
    # --- Global ---------------------------------------------------------------
    Pattern("CARD_NUMBER", re.compile(r"\b(?:[0-9][ -]?){13,19}\b"), is_valid_card_number, 0.98),
    Pattern("IMEI", re.compile(r"\b[0-9]{15}\b"), is_valid_imei, 0.9),
    Pattern("EMAIL", re.compile(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}\b"), None, 0.97),
    Pattern(
        "IP",
        re.compile(
            r"\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}"
            r"(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b"
        ),
        None,
        0.85,
    ),
    # --- Secrets --------------------------------------------------------------
    Pattern("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), None, 0.99),
    Pattern("PRIVATE_KEY", re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"), None, 1.0),
    Pattern(
        "API_KEY",
        re.compile(
            r"\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
            r"|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b"
        ),
        lambda raw: shannon_entropy(raw) > 3.5,
        0.95,
    ),
)


@dataclass(frozen=True)
class Match:
    cls: str
    start: int
    end: int
    value: str
    confidence: float


def scan_text(text: str) -> list[Match]:
    """Runs the whole pack. Returns every validated match, sorted by position."""
    out: list[Match] = []
    for pattern in L1_PATTERNS:
        for m in pattern.regex.finditer(text):
            raw = m.group(0)
            if not raw:
                continue
            trimmed = raw.strip()
            if pattern.validate is not None and not pattern.validate(trimmed):  # type: ignore[operator]
                continue
            out.append(Match(pattern.cls, m.start(), m.end(), trimmed, pattern.confidence))
    out.sort(key=lambda m: (m.start, -m.end))
    return out


def contains_pii(text: str) -> bool:
    """Hot path for the ingress check."""
    for pattern in L1_PATTERNS:
        for m in pattern.regex.finditer(text):
            raw = m.group(0)
            if not raw:
                continue
            if pattern.validate is None or pattern.validate(raw.strip()):  # type: ignore[operator]
                return True
    return False


def first_class(text: str) -> str | None:
    """The class of the first thing found, for the 422 detail. Never the value."""
    matches = scan_text(text)
    return matches[0].cls if matches else None
