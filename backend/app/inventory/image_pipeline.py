"""Pure product-image compression pipeline (contract §15, imgpipe_v1).

Isolated here on purpose (t_fd20d685, §15.7): Pillow must NOT leak into
``validation.py`` / ``service.py`` unit-test imports — this module is the
only Pillow importer in the inventory package, so validators stay
Pillow-free where possible and the ladder stays unit-testable in
isolation (mirror of validation.py's house style).

Policy pinned by the blueprint (§15.1):
  P3 stored format after compression = always lossy WebP
  P4 dimension clamp (long edge, LANCZOS) -> quality ladder, each rung at
     scale 1.0, then the whole ladder re-runs after a x0.75 downscale
     (max 2 downscales); the first encode under target wins.
  P5 never store a LARGER file than the upload: if nothing shrank the
     input, revert to the original bytes (mode=reverted).

The module has no HTTP/IO knowledge: callers map exceptions to status
codes (§15.3) and do the actual storage.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from io import BytesIO
from typing import List, Optional

from PIL import Image, UnidentifiedImageError

log = logging.getLogger("solin.media")

#: Pipeline marker for the ImageSlot response (§15.4). Correlation-only;
#: the sha1_8 in the log line is correlation-only too, never a secret.
PIPELINE_VERSION = "imgpipe_v1"

#: Magic-byte signatures sniffed from the payload (§15.2 step 2). A sniff
#: miss — or a sniff that disagrees with the declared content-type — is a
#: 415, regardless of what the client declared.
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def sniff_image_type(data: bytes) -> Optional[str]:
    """Sniff the *actual* container from magic bytes (never the header).

    Returns the canonical mime, or None when the payload is not one of
    the three accepted containers (JPEG / PNG / WebP).
    """
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == _PNG_MAGIC:
        return "image/png"
    # WebP: RIFF????WEBP + VP8 / VP8L / VP8X chunk four-cc.
    if (len(data) >= 16 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
            and data[12:16] in (b"VP8 ", b"VP8L", b"VP8X")):
        return "image/webp"
    return None


class ImageDecodeError(ValueError):
    """Sniff-valid payload that Pillow cannot decode (§15.3 -> 415)."""


@dataclass(frozen=True)
class PipelineConfig:
    """The §15.5 knobs the pipeline itself reads (defaults = §15.1)."""

    target_bytes: int = 307_200
    max_dimension: int = 2048
    quality_ladder: List[int] = field(
        default_factory=lambda: [82, 72, 62, 52])


@dataclass(frozen=True)
class CompressResult:
    """What the pipeline decided to STORE (never larger than the upload)."""

    stored: bytes
    mime: str          # stored container mime (WebP after compression)
    mode: str          # compress | reverted
    quality: Optional[int]


def _encode_webp(img: Image.Image, quality: int) -> bytes:
    buf = BytesIO()
    # method=4: slowest/best compressor — MVP files are stored once and
    # served many times, spend the CPU at write time.
    buf.name = "f.webp"
    img.save(buf, "WEBP", quality=quality, method=4)
    return buf.getvalue()


def compress_image(data: bytes,
                   cfg: Optional[PipelineConfig] = None) -> CompressResult:
    """Run the §15.2 steps 4-5 (decode + clamp + ladder + P5) on ``data``.

    Returns the bytes to store plus the mode/quality used. Raises
    :class:`ImageDecodeError` for a sniff-valid-but-undecodable payload
    (the caller maps that to 415, §15.3). Deliberately does NOT apply the
    P6 guard — the caller decides the 422 shape and stores the result.
    """
    cfg = cfg or PipelineConfig()
    try:
        img = Image.open(BytesIO(data))
        img.load()  # force the decode NOW — truncated payloads must raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ImageDecodeError(f"undecodable payload ({type(exc).__name__})") from exc

    if img.mode != "RGB":
        # "P" palettes and CMYK have no lossy-WebP story; flattening
        # through RGBA onto the RGB floor keeps label backgrounds white.
        img = img.convert("RGBA").convert("RGB")

    # Long-edge clamp (P4 first half): LANCZOS, aspect kept.
    w, h = img.size
    long_edge = max(w, h)
    if long_edge > cfg.max_dimension:
        scale = cfg.max_dimension / long_edge
        img = img.resize(
            (max(1, round(w * scale)), max(1, round(h * scale))),
            Image.LANCZOS,
        )

    # Quality ladder (P4 second half): full ladder at scale 1.0, then the
    # whole ladder re-runs after each x0.75 downscale (2 downscales max).
    # Downscales shrink the CLAMPED working image, not the raw upload.
    # First encode <= target wins (P2 stop rule). ``best`` tracks the
    # smallest encode seen so far for the P5 fallback.
    base_w, base_h = img.size
    current = img
    best: Optional[tuple] = None  # (size, quality, bytes)
    for scale_idx in range(3):
        if scale_idx:
            scale = 0.75 ** scale_idx
            current = img.resize(
                (max(1, round(base_w * scale)), max(1, round(base_h * scale))),
                Image.LANCZOS,
            )
        for q in cfg.quality_ladder:
            encoded = _encode_webp(current, q)
            if best is None or len(encoded) < best[0]:
                best = (len(encoded), q, encoded)
            if len(encoded) <= cfg.target_bytes:
                return CompressResult(encoded, "image/webp", "compress", q)
        if scale_idx == 2:
            break

    # P5: nothing reached the target. The pipeline never stores a LARGER
    # file than the upload — smallest ladder result, or revert to raw.
    assert best is not None
    if best[0] < len(data):
        return CompressResult(best[2], "image/webp", "compress", best[1])
    return CompressResult(data, sniff_image_type(data) or "image/png",
                          "reverted", None)
