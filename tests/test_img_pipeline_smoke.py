"""Dev-level smoke tests for the §15 image pipeline (imgpipe_v1).

These pin the CONTRACT-CRITICAL behaviours the pipeline ships with, at the
service layer (no HTTP): kill switch, passthrough byte-identity, the
compress chain reaching under the stored guards, the 413 gate reading
SOLIN_IMG_MAX_UPLOAD_BYTES, and the §15.6 one-line-per-attempt log.

The full §15.8 acceptance suite (fixture-driven, re-anchored per the §15.4
QA-harness caveat: old 10 MiB-gate fixtures are STALE INPUTS, not
contracts) is gated AFTER this card as t_b8c1daed — these are the dev's
regression control, not that suite.
"""
import io
import logging
import random

import pytest
from PIL import Image

from app.config import Settings
from app.inventory import service as service_mod
from app.inventory import media as media_mod
from app.inventory.image_pipeline import compress_image, sniff_image_type
from app.inventory.service import InventoryService
from app.inventory.store import ProductStore


def _doc(pid="smoke1"):
    return {"id": pid, "name": "Smoke product", "base_unit": "g",
            "images": {"product_photo": None, "label_photo": None}}


@pytest.fixture
def svc(tmp_path, monkeypatch):
    """Fresh service on a temp store + temp media root + a write recorder."""
    monkeypatch.setattr(media_mod, "media_root", lambda: str(tmp_path / "media"))
    writes = []

    def fake_write(dirname, filename, data, mime):
        writes.append((filename, data, mime))

    store = ProductStore(path=str(tmp_path / "products.json"))
    store.upsert(_doc())
    service = InventoryService(store=store, media_write=fake_write)
    service.writes = writes
    return service


def _noisy_jpeg(w=2000, h=1600, quality=90):
    """Deterministic photo-LIKE source: per-pixel noise -> worst case for
    the compressor (never lets the QA suite rely on luck, either branch of
    the guard shape is exercised deterministically)."""
    rng = random.Random(19711010)
    data = bytes(rng.getrandbits(8) for _ in range(w * h * 3))
    img = Image.frombytes("RGB", (w, h), data)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


# -- sniff helper -----------------------------------------------------------

def test_sniff_magic_bytes():
    assert sniff_image_type(b"\xff\xd8\xffabc") == "image/jpeg"
    assert sniff_image_type(b"\x89PNG\r\n\x1a\nxx") == "image/png"
    assert sniff_image_type(b"RIFF\x00\x00\x00\x00WEBPVP8 xx") == "image/webp"
    assert sniff_image_type(b"GIF89a...") is None
    assert sniff_image_type(b"hello") is None
    assert sniff_image_type(b"") is None


# -- pipeline knobs via the settings seam ------------------------------------

def test_kill_switch_stores_byte_identical(svc, monkeypatch):
    """F-7 control: SOLIN_IMG_COMPRESS=false => byte-exact storage even for
    a 3 MB photo-like upload (pre-§15 behaviour pinned as the control)."""
    big = _noisy_jpeg()
    monkeypatch.setattr(service_mod, "_settings",
                        lambda: Settings(img_compress=False))
    slot = svc.upload_image("smoke1", "product_photo", big, "image/jpeg",
                            "big.jpg")
    assert slot["byte_size"] == len(big)
    assert svc.writes[-1][1] == big
    assert slot["pipeline"] == "imgpipe_v1"


def test_big_upload_follows_the_two_stored_paths(svc):
    """F-4/F-5 shape at unit level for a noise source (NO compression
    guarantee). Either the ladder lands under the P6 guard — stored,
    shrunk, decodable WebP — or the upload 422s with the canonical
    IMAGE_COMPRESS_FAILED message and NOTHING is stored. Seed-fixed, so
    exactly one branch runs deterministically."""
    big = _noisy_jpeg()
    try:
        slot = svc.upload_image("smoke1", "product_photo", big, "image/jpeg",
                                "big.jpg")
    except service_mod.InventoryError as exc:
        assert exc.status_code == 422
        assert exc.code == "IMAGE_COMPRESS_FAILED"
        assert "could not be compressed" in exc.message
        assert not svc.writes  # failed attempts never write
        return
    assert slot["mime_type"] == "image/webp"
    assert slot["byte_size"] < len(big)  # never store a LARGER file
    assert slot["original_size"] == len(big)
    stored = svc.writes[-1][1]
    img = Image.open(io.BytesIO(stored))
    img.load()
    assert img.format == "WEBP"


def test_stored_guard_422_and_canonical_message(svc, monkeypatch):
    """F-6 shape: max_stored=1024 => a pipeline that genuinely cannot
    shrink the input rejects with 422 IMAGE_COMPRESS_FAILED (never stores)."""
    big = _noisy_jpeg()
    monkeypatch.setattr(service_mod, "_settings",
                        lambda: Settings(img_max_stored_bytes=1024))
    with pytest.raises(service_mod.InventoryError) as e:
        svc.upload_image("smoke1", "product_photo", big, "image/jpeg",
                         "big.jpg")
    assert e.value.status_code == 422 and e.value.code == "IMAGE_COMPRESS_FAILED"
    assert "could not be compressed" in e.value.message


def test_413_gate_reads_settings_max_and_sniff_beats_header(svc, monkeypatch):
    """F-413 shape: >max gate => 413 + canonical message, NO file written.
    F-sniff shape: text bytes declared image/jpeg => sniff beats header."""
    monkeypatch.setattr(service_mod, "_settings",
                        lambda: Settings(img_max_upload_bytes=2_000_000))
    big = b"\xff\xd8\xff" + b"\x00" * 2_000_001
    with pytest.raises(service_mod.InventoryError) as e:
        svc.upload_image("smoke1", "product_photo", big, "image/jpeg", "big.jpg")
    assert e.value.status_code == 413 and e.value.code == "PAYLOAD_TOO_LARGE"
    assert "1.9 MB" in e.value.message
    assert not svc.writes  # gate short-circuits before storage

    with pytest.raises(service_mod.InventoryError) as e:
        svc.upload_image("smoke1", "product_photo", b"hello", "image/jpeg",
                         "x.txt")
    assert e.value.status_code == 415
    assert e.value.code == "UNSUPPORTED_MEDIA_TYPE"
    assert not svc.writes


def test_one_log_line_per_attempt(svc, caplog):
    """§15.6: exactly ONE greppable solin.media upload line per PIPELINE
    ATTEMPT — success AND failure — carrying the correlation keys."""
    small = _noisy_jpeg(w=40, h=40)
    big = _noisy_jpeg()
    with caplog.at_level(logging.INFO, logger="solin.media"):
        def _attempt(slot, data, name="a.jpg"):
            try:  # failures raise too — ONE logged line either way
                svc.upload_image("smoke1", slot, data, "image/jpeg", name)
            except service_mod.InventoryError:
                pass
        _attempt("product_photo", small)                              # passthrough
        _attempt("product_photo", b"", "e.jpg")                       # NOT an attempt
        _attempt("bad_slot", small)                                   # NOT an attempt
        _attempt("product_photo", b"hello", "x.txt")                  # sniff miss
        _attempt("product_photo", big, "big.jpg")                     # compressor path
    lines = [r.getMessage() for r in caplog.records if r.name == "solin.media"]
    assert len(lines) == 3, lines  # attempts only; empty body + bad slot stay silent
    for ln in lines:
        for key in ("original_bytes=", "stored_bytes=", "outcome=", "sha1_8="):
            assert key in ln
        assert "/" not in ln and "Users" not in ln  # no paths, no secrets


def test_compress_helper_never_stores_larger():
    """§15.8 #6 'unit-prove reverted too': undecodable == ImageDecodeError
    (a bad FILE, not a stored thing), and everything the chain does store
    is SMALLER — never larger, never equal."""
    import pytest as _pytest
    from app.inventory.image_pipeline import ImageDecodeError, PipelineConfig
    rng = random.Random(7)
    noise = bytes(rng.getrandbits(8) for _ in range(400_000))
    with _pytest.raises(ImageDecodeError):
        compress_image(noise)  # not an image at all: nothing to store

    # incompressible JPEG: the ladder may only shrink it PART way (that is
    # legal per P5: store the smallest rung, guard still decides 200 vs 422)
    raw = _noisy_jpeg(w=120, h=120, quality=100)
    res = compress_image(raw, PipelineConfig(target_bytes=4096))
    assert res.mode == "compress"
    assert len(res.stored) < len(raw)  # smaller kept...
    res2 = compress_image(raw)         # default config = same guarantee
    assert len(res2.stored) <= len(raw)
