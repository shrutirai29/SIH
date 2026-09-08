"""Tests for the server-side image sanity guard (ticket F5)."""

from __future__ import annotations

import struct

import pytest

from app.guards.image_sanity import check_image_sanity

# ---- helpers ----------------------------------------------------------------

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _make_png(
    width: int = 100,
    height: int = 100,
    bit_depth: int = 8,
    color_type: int = 6,
) -> bytes:
    """Builds a minimal valid PNG header (signature + IHDR chunk)."""
    sig = _PNG_MAGIC
    ihdr_data = struct.pack(">II", width, height) + bytes([bit_depth, color_type, 0, 0, 0])
    ihdr_len = struct.pack(">I", 13)
    ihdr_type = b"IHDR"
    ihdr_crc = b"\x00\x00\x00\x00"  # CRC not validated by our guard
    return sig + ihdr_len + ihdr_type + ihdr_data + ihdr_crc


# ---- tests ------------------------------------------------------------------


class TestCheckImageSanity:
    def test_valid_png(self) -> None:
        result = check_image_sanity(_make_png())
        assert result.ok is True
        assert result.detail == ""

    def test_valid_png_large_dimensions(self) -> None:
        result = check_image_sanity(_make_png(1920, 1080))
        assert result.ok is True

    def test_empty_data(self) -> None:
        result = check_image_sanity(b"")
        assert result.ok is False
        assert "empty" in result.detail

    def test_too_small(self) -> None:
        result = check_image_sanity(b"\x89PNG\r\n\x1a\n\x00")
        assert result.ok is False
        assert "too small" in result.detail

    def test_wrong_magic_bytes(self) -> None:
        # JPEG magic
        data = b"\xff\xd8\xff" + b"\x00" * 100
        result = check_image_sanity(data)
        assert result.ok is False
        assert "magic bytes" in result.detail

    def test_wrong_first_chunk(self) -> None:
        # Valid PNG signature but first chunk is not IHDR
        sig = _PNG_MAGIC
        chunk = struct.pack(">I", 13) + b"tEXt" + b"\x00" * 17
        result = check_image_sanity(sig + chunk)
        assert result.ok is False
        assert "IHDR" in result.detail

    def test_wrong_ihdr_length(self) -> None:
        sig = _PNG_MAGIC
        chunk = struct.pack(">I", 10) + b"IHDR" + b"\x00" * 17
        result = check_image_sanity(sig + chunk)
        assert result.ok is False
        assert "length" in result.detail

    def test_dimensions_too_small(self) -> None:
        result = check_image_sanity(_make_png(width=4, height=4))
        assert result.ok is False
        assert "too small" in result.detail

    def test_dimensions_too_large(self) -> None:
        result = check_image_sanity(_make_png(width=20000, height=20000))
        assert result.ok is False
        assert "too large" in result.detail

    def test_invalid_color_type(self) -> None:
        result = check_image_sanity(_make_png(color_type=5))
        assert result.ok is False
        assert "color type" in result.detail

    def test_invalid_bit_depth_for_color_type(self) -> None:
        # Color type 2 (truecolor) only allows bit depth 8 or 16.
        result = check_image_sanity(_make_png(bit_depth=4, color_type=2))
        assert result.ok is False
        assert "bit depth" in result.detail

    def test_max_file_size_exceeded(self) -> None:
        # 11 MB of zeros with valid PNG header
        large = _make_png() + b"\x00" * (11 * 1024 * 1024)
        result = check_image_sanity(large)
        assert result.ok is False
        assert "too large" in result.detail

    def test_grayscale_valid(self) -> None:
        result = check_image_sanity(_make_png(color_type=0, bit_depth=8))
        assert result.ok is True

    def test_indexed_valid(self) -> None:
        result = check_image_sanity(_make_png(color_type=3, bit_depth=4))
        assert result.ok is True

    def test_never_raises(self) -> None:
        """Even with garbage input, check_image_sanity must never raise."""
        garbage_inputs = [
            b"\x89PNG" + b"\xff" * 5,
            b"\x00" * 100,
            b"\x89PNG\r\n\x1a\n" + b"\x00" * 5,  # Too short for IHDR
        ]
        for data in garbage_inputs:
            result = check_image_sanity(data)
            # Must return a result, not raise.
            assert isinstance(result.ok, bool)
