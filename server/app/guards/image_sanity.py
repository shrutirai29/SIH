"""Server-side image sanity check (ticket F5).

WHY A SERVER-SIDE IMAGE CHECK

Same principle as the ingress text guard: the server must not trust the client's
claim that an image is safe. This module performs structural validation on any
image attachment the client sends alongside the SSG payload.

WHAT IT CHECKS

1. PNG magic bytes — the blob is actually a PNG, not a renamed JPEG/BMP/script.
2. Minimum dimensions — a 1x1 pixel "screenshot" is either a bug or an evasion.
3. Maximum file size — caps at 10 MB to prevent resource exhaustion.
4. IHDR chunk validation — the first chunk after the signature must be IHDR with
   sane width/height/bit-depth values.

WHAT IT DOES NOT CHECK

It does NOT re-run PII detection on the image. That would require a VLM on the
server, which is a Phase 5 feature. This guard catches structural attacks and
transmission errors, not semantic leaks. Semantic image safety remains the
client's responsibility via the pixel redaction module.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass


@dataclass(frozen=True)
class ImageCheckResult:
    ok: bool
    detail: str = ""


# PNG signature: 8 bytes.
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# Limits.
_MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
_MIN_WIDTH = 16
_MIN_HEIGHT = 16
_MAX_WIDTH = 16384
_MAX_HEIGHT = 16384


def check_image_sanity(data: bytes) -> ImageCheckResult:
    """Validates an image attachment is a structurally sound PNG.

    Returns ImageCheckResult(ok=True) if valid, or (ok=False, detail=...)
    with a safe-to-log reason if not. Never raises.
    """
    try:
        return _check(data)
    except Exception as exc:
        # Fail-closed: a check that crashes is not a check that passed.
        return ImageCheckResult(ok=False, detail=f"check crashed: {type(exc).__name__}")


def _check(data: bytes) -> ImageCheckResult:
    # 1. Size limits.
    if len(data) == 0:
        return ImageCheckResult(ok=False, detail="empty image data")
    if len(data) > _MAX_FILE_SIZE:
        return ImageCheckResult(
            ok=False, detail=f"image too large: {len(data)} bytes (max {_MAX_FILE_SIZE})"
        )
    if len(data) < 33:
        # 8 (sig) + 25 (minimum IHDR chunk: 4 len + 4 type + 13 data + 4 crc)
        return ImageCheckResult(ok=False, detail="image too small to be valid PNG")

    # 2. PNG magic bytes.
    if data[:8] != _PNG_MAGIC:
        return ImageCheckResult(ok=False, detail="not a valid PNG (magic bytes mismatch)")

    # 3. IHDR chunk validation.
    # Bytes 8-11: chunk length (must be 13 for IHDR).
    chunk_len = struct.unpack(">I", data[8:12])[0]
    if chunk_len != 13:
        return ImageCheckResult(ok=False, detail=f"IHDR chunk length is {chunk_len}, expected 13")

    # Bytes 12-15: chunk type (must be b'IHDR').
    chunk_type = data[12:16]
    if chunk_type != b"IHDR":
        return ImageCheckResult(
            ok=False, detail=f"first chunk is {chunk_type!r}, expected IHDR"
        )

    # IHDR data: width (4) + height (4) + bit_depth (1) + color_type (1) + ...
    width = struct.unpack(">I", data[16:20])[0]
    height = struct.unpack(">I", data[20:24])[0]
    bit_depth = data[24]
    color_type = data[25]

    if width < _MIN_WIDTH or height < _MIN_HEIGHT:
        return ImageCheckResult(
            ok=False,
            detail=f"image too small: {width}x{height} (min {_MIN_WIDTH}x{_MIN_HEIGHT})",
        )

    if width > _MAX_WIDTH or height > _MAX_HEIGHT:
        return ImageCheckResult(
            ok=False,
            detail=f"image too large: {width}x{height} (max {_MAX_WIDTH}x{_MAX_HEIGHT})",
        )

    # Valid bit depths per color type.
    valid_depths: dict[int, set[int]] = {
        0: {1, 2, 4, 8, 16},      # grayscale
        2: {8, 16},                 # truecolor
        3: {1, 2, 4, 8},           # indexed
        4: {8, 16},                 # grayscale + alpha
        6: {8, 16},                 # truecolor + alpha
    }

    if color_type not in valid_depths:
        return ImageCheckResult(ok=False, detail=f"invalid color type: {color_type}")

    if bit_depth not in valid_depths[color_type]:
        return ImageCheckResult(
            ok=False,
            detail=f"invalid bit depth {bit_depth} for color type {color_type}",
        )

    return ImageCheckResult(ok=True)
