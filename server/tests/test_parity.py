"""TS ↔ Python parity for the L1 pack (ticket F4).

The ingress guard is only a real check while it agrees with the client. Two
implementations of one rule set drift unless something forces them not to — and ours
had already drifted on day one, missing PHONE_IN, GSTIN and IFSC that the client
caught. That is the whole argument for this file.

The corpus is generated here and written to a shared fixture file; the TypeScript
side reads the same file and asserts the same verdicts. Neither language owns the
expected answers — they must simply agree.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.guards.ingress_pii import (
    contains_pii,
    is_valid_aadhaar,
    is_valid_card_number,
    is_valid_gstin,
    is_valid_ifsc,
    is_valid_pan,
    is_valid_upi_vpa,
    scan_text,
    verhoeff_validate,
)

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "eval"
    / "fixtures"
    / "parity-corpus.json"
)


def verhoeff_checksum(payload: str) -> int:
    d = (
        (0, 1, 2, 3, 4, 5, 6, 7, 8, 9), (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
        (2, 3, 4, 0, 1, 7, 8, 9, 5, 6), (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
        (4, 0, 1, 2, 3, 9, 5, 6, 7, 8), (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
        (6, 5, 9, 8, 7, 1, 0, 4, 3, 2), (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
        (8, 7, 6, 5, 9, 3, 2, 1, 0, 4), (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
    )
    p = (
        (0, 1, 2, 3, 4, 5, 6, 7, 8, 9), (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
        (5, 8, 0, 3, 7, 9, 6, 1, 4, 2), (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
        (9, 4, 5, 3, 1, 2, 6, 8, 7, 0), (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
        (2, 7, 9, 3, 8, 0, 6, 4, 1, 5), (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
    )
    inv = (0, 4, 3, 2, 1, 5, 6, 7, 8, 9)
    c = 0
    for i, ch in enumerate(reversed(payload)):
        c = d[c][p[(i + 1) % 8][int(ch)]]
    return inv[c]


def build_corpus() -> list[str]:
    """A corpus that exercises the boundaries, not just the happy path.

    Near-misses matter more than valid values: any two implementations agree that
    `2345 6789 0124` is an Aadhaar. They disagree about `234567890123`, about a
    12-digit order number, and about whether `asha@example.com` is a payment address.
    """
    corpus: list[str] = []

    # Valid and near-miss Aadhaars, generated so the check digit is genuinely right.
    for seed in range(200):
        payload = str(23456789012 + seed * 977)[:11].rjust(11, "2")
        valid = payload + str(verhoeff_checksum(payload))
        corpus.append("Aadhaar " + valid)
        corpus.append("Aadhaar " + valid[:-1] + str((int(valid[-1]) + 1) % 10))
        corpus.append(f"{valid[:4]} {valid[4:8]} {valid[8:]}")
        corpus.append(f"{valid[:4]}-{valid[4:8]}-{valid[8:]}")

    # Cards: valid Luhn, broken Luhn, wrong length.
    for base in ("4111111111111111", "5500005555555559", "378282246310005"):
        corpus.append("card " + base)
        corpus.append("card " + base[:-1] + str((int(base[-1]) + 1) % 10))
        corpus.append("card " + base[:12])

    # PAN entity codes: only some fourth characters are real.
    for ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        corpus.append("PAN ABC" + ch + "E1234F")

    # GSTIN: correct check char and every wrong one.
    for ch in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        corpus.append("GSTIN 27AAPFU0939F1Z" + ch)

    # The email/VPA boundary that caused a real precision bug.
    for host in ("gmail.com", "example.com", "okhdfcbank", "ybl", "paytm", "co.in"):
        corpus.append("pay asha.patil@" + host)

    # IFSC, phones, and things that merely look like them.
    for prefix in ("HDFC", "SBIN", "ICIC"):
        corpus.append("IFSC " + prefix + "0001234")
        corpus.append("IFSC " + prefix + "1001234")
    for lead in "0123456789":
        corpus.append("call " + lead + "876543210")

    # Innocuous text that must NOT trip anything: over-redaction is a real cost.
    corpus += [
        "Order number 234567890123 shipped",
        "Invoice 000000000000",
        "The quick brown fox jumps over the lazy dog",
        "Total: 1,23,456.78",
        "Version 1.2.3.4",
        "192.168.1.1",
        "meeting at 10:30 on 2026-09-06",
        "",
        "   ",
    ]

    # Secrets.
    corpus += [
        "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        "-----BEGIN RSA PRIVATE KEY-----",
        "sk-xxxxxxxxxxxxxxxxxxxx",
        "AKIAIOSFODNN7EXAMPLE",
    ]

    return corpus


def test_corpus_is_written_for_the_typescript_side() -> None:
    """Generates the shared fixture. The TS parity test reads exactly this file."""
    corpus = build_corpus()
    verdicts = [
        {
            "text": text,
            "contains_pii": contains_pii(text),
            "classes": sorted({m.cls for m in scan_text(text)}),
        }
        for text in corpus
    ]

    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(
        json.dumps(
            {
                "note": (
                    "GENERATED by server/tests/test_parity.py. The TypeScript parity "
                    "test asserts the same verdicts. Neither side owns the expected "
                    "answers; they must agree (ticket F4)."
                ),
                "count": len(verdicts),
                "cases": verdicts,
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )

    assert len(verdicts) > 800, "corpus should be large enough to catch drift"
    # A corpus where everything is PII, or nothing is, tests nothing.
    positives = sum(1 for v in verdicts if v["contains_pii"])
    assert 0.2 < positives / len(verdicts) < 0.95


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2363", True),
        ("123451", True),
        ("2364", False),
        ("", False),
        ("12a45", False),
    ],
)
def test_verhoeff_vectors(value: str, expected: bool) -> None:
    assert verhoeff_validate(value) is expected


def test_the_precision_fixes_hold_on_this_side_too() -> None:
    # An ordinary email is not a payment address.
    assert is_valid_upi_vpa("asha.patil@example.com") is False
    assert is_valid_upi_vpa("asha.patil@okhdfcbank") is True
    # A 12-digit order number is not an Aadhaar.
    assert is_valid_aadhaar("234567890123") is False
    # PAN's fourth character is an entity code, not a free letter.
    assert is_valid_pan("ABCZE1234F") is False
    assert is_valid_pan("ABCPE1234F") is True
    # IFSC's fifth character must be zero.
    assert is_valid_ifsc("HDFC1001234") is False
    # GSTIN check character.
    assert is_valid_gstin("27AAPFU0939F1ZA") is False
    # Luhn.
    assert is_valid_card_number("4111111111111112") is False
