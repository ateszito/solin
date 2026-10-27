"""§15.8 QA acceptance suite — product image upload & compression (t_0595a9ba).

Endpoint-level companion to tests/test_img_pipeline_smoke.py (the dev's
unit-level smoke). Every check here drives the REAL app via TestClient so
HTTP status codes, the C8 error-body shape, the canonical §15.3 messages and
the static media mount are under test — service seams only where §15.8 pins
unit-level proof.

§15.4 harness re-anchor (MANDATORY, honoured): every fixture is BUILT here
(seed-fixed, deterministic) — no committed bytes, nothing reads the stale
10 MiB gate. The five fixture classes the t_0595a9ba task names are all
present: small (small_jpeg, small_webp), oversized (413-shaped 26 MiB blob +
a decodable camera-like JPEG in the (P2, P1) window), unsupported (text,
GIF), corrupt (mid-scan truncated JPEG, pinned on BOTH sides of the P2
split), already-compressed (small_jpeg is under both P2 and P6 and must
store byte-identical).
"""
import io
import logging
import os

import pytest
from PIL import Image

from fastapi.testclient import TestClient

from app.config import Settings
from app.inventory import service as service_mod
from app.inventory import media as media_mod
from app.inventory.service import InventoryService
from app.inventory.store import ProductStore
from app.main import app

# ---------------------------------------------------------------------------
# seed-fixed fixture builders (§15.8 "fixtures committed with the suite": the
# generators are the committed artifact; the bytes are deterministic)
# ---------------------------------------------------------------------------


def _seeded_noise(w, h, seed=19711010):
    """Deterministic per-pixel noise — worst case for the compressor."""
    rng = __import__("random").Random(seed)
    data = rng.randbytes(w * h * 3)
    return Image.frombytes("RGB", (w, h), data)


def _photo_like(w=4032, h=3024):
    """Camera-like source: photo noise + smooth sky band + drawn label text.

    Deterministic (seed-pinned). Sized to land inside the (P2, P1) window —
    strictly above the 307 200 B target, strictly under the 25 MiB gate.
    """
    img = _seeded_noise(w, h)
    sky = Image.new("RGB", (w, 240), (168, 200, 232))
    img.paste(sky, (0, 0))
    return img


def _jpeg_bytes(img, quality=95):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def _camera_jpeg():
    """~8-24 MiB decodable camera-like JPEG (was-413-era shape, §15.8 #4/#5).

    Quality ladder down so the seed-pinned bytes ALWAYS land strictly inside
    the (P2, P1) window regardless of encoder drift — never below target
    (that would skip the compression branch), never above the gate.
    """
    img = _photo_like()
    for q in (95, 85, 75, 65, 55):
        blob = _jpeg_bytes(img, q)
        if 6_000_000 <= len(blob) < 25_435_446:
            return blob
    raise RuntimeError("no camera-like quality reached the (P2,P1) window")


def _truncated_jpeg():
    """Corrupt fixture: real JPEG bytes, cut MID-SCAN (no EOI).

    Sniff-valid and >P2 (so step 4 actually decodes -> must raise ->
    415 per §15.2/§15.3). Also handed whole for the under-P2 control,
    which pins the passthrough-skips-decode branch.
    """
    whole = _jpeg_bytes(_seeded_noise(1200, 900), quality=92)
    cut = len(whole) // 2
    assert cut > 307_200  # the cut copy stays ABOVE P2 => decode gate runs
    return whole, whole[:cut]


@pytest.fixture(scope="module")
def fixtures():
    cam = _camera_jpeg()
    small_jpeg = _jpeg_bytes(_seeded_noise(400, 300), quality=70)
    assert len(small_jpeg) <= 307_200
    buf = io.BytesIO()
    _seeded_noise(400, 300, seed=7).save(buf, "WEBP", quality=70)
    small_webp = buf.getvalue()
    assert len(small_webp) <= 307_200
    gif_buf = io.BytesIO()
    _seeded_noise(64, 64, seed=11).convert("P").save(gif_buf, "GIF")
    corrupt_whole, corrupt_trunc = _truncated_jpeg()
    return {
        "cam": cam,
        "small_jpeg": small_jpeg,
        "small_webp": small_webp,
        "gif": gif_buf.getvalue(),
        "corrupt_whole": corrupt_whole,
        "corrupt_trunc": corrupt_trunc,
        "text": b"hello, I am a plain text file, definitely not an image\n",
        "big413": b"\xff\xd8\xff\xe0" + b"\x00" * (26 * 1024 * 1024),
    }


# ---------------------------------------------------------------------------
# per-test harness (same shape as test_inventory_endpoint.py)
# ---------------------------------------------------------------------------


@pytest.fixture
def svc(tmp_path, monkeypatch):
    """Fresh service, REAL media writes, upload+fetch share ONE root.

    Same anchor as test_inventory_endpoint.py: uploads write into the
    StaticFiles mount captured from the real app, so GET <url> serves the
    stored bytes (upload + fetch parity, §15.4).
    """
    mount_dir = None
    for r in app.routes:
        if getattr(r, "path", "") == "/api/v1/media":
            from fastapi.staticfiles import StaticFiles
            inner = getattr(r, "app", r)
            if isinstance(inner, StaticFiles):
                mount_dir = str(inner.directory)
            break
    assert mount_dir is not None
    monkeypatch.setattr(media_mod, "media_root", lambda: mount_dir)
    tmp_store = str(tmp_path / "data" / "products.json")
    return InventoryService(store=ProductStore(path=tmp_store))


@pytest.fixture
def client(svc, monkeypatch):
    import app.inventory.routes as routes_mod
    monkeypatch.setattr(routes_mod, "svc", svc)
    yield TestClient(app)


def _mk(client, svc):
    payload = {"name": "QA product", "base_unit": "g", "serving_size": 150,
               "macros_per_100": {"calories": 165, "protein": 31.0, "fat": 3.6,
                                  "carbs": 0, "fiber": 0, "sugar": 0,
                                  "sodium": 74}}
    r = client.post("/api/v1/inventory", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _upload(client, pid, slot, name, data, ctype="application/octet-stream"):
    return client.post(f"/api/v1/inventory/{pid}/images/{slot}",
                       files={"file": (name, io.BytesIO(data), ctype)})



# ---------------------------------------------------------------------------
# §15.8 acceptance checks (QA layer, real HTTP through the app)
# ---------------------------------------------------------------------------

CANON_TOO_LARGE = ("The picture is too large (max 25.0 MB). Take a new "
                   "photo or pick a smaller file.")
CANON_UNREADABLE = "This file is not a readable JPEG, PNG or WebP picture."
CANON_FAILED = ("This picture could not be compressed. Take a new photo of "
                "the product, or pick a smaller file.")


def _stored_leaves(svc, pid, slot):
    d = os.path.join(media_mod.media_root(), "inventory", pid, slot)
    return os.listdir(d) if os.path.isdir(d) else []


def _stored_bytes(svc, pid, slot, leaf):
    p = os.path.join(media_mod.media_root(), "inventory", pid, slot, leaf)
    with open(p, "rb") as fh:
        return fh.read()


# -- F-413 (§15.8 #1): > P1 gate -> 413, canonical msg, NO file written ----


def test_f413_oversized_rejects_413_with_canonical_message(client, svc,
                                                            fixtures):
    pid = _mk(client, svc)
    r = _upload(client, pid, "product_photo", "big.jpg", fixtures["big413"],
                "image/jpeg")
    assert r.status_code == 413, r.text
    body = r.json()
    assert body["code"] == "PAYLOAD_TOO_LARGE"
    # canonical §15.3 string, verbatim (the SPA renders it unmodified)
    assert body["message"] == CANON_TOO_LARGE
    # gate short-circuits BEFORE any storage (§15.2 step 1)
    assert _stored_leaves(svc, pid, "product_photo") == []
    # the product stays usable: slot still empty, doc intact
    g = client.get(f"/api/v1/inventory/{pid}")
    assert g.status_code == 200
    assert g.json()["images"]["product_photo"] is None


# -- F-sniff (§15.8 #2): magic bytes beat the declared header --------------


def test_fsniff_text_declared_jpeg_is_415(client, svc, fixtures):
    """The §15.2 hole that used to pass validation.py: text-as-jpeg."""
    pid = _mk(client, svc)
    r = _upload(client, pid, "product_photo", "notes.txt", fixtures["text"],
                "image/jpeg")
    assert r.status_code == 415, r.text
    assert r.json()["code"] == "UNSUPPORTED_MEDIA_TYPE"
    assert r.json()["message"] == CANON_UNREADABLE
    assert _stored_leaves(svc, pid, "product_photo") == []


def test_fsniff_real_gif_is_415_and_sniff_precedes_passthrough(client, svc,
                                                                fixtures):
    """A valid GIF UNDER P2 proves sniff runs BEFORE the passthrough
    shortcut (step 2 before step 3) — otherwise it would store as-is."""
    pid = _mk(client, svc)
    r = _upload(client, pid, "product_photo", "clip.gif", fixtures["gif"],
                "image/gif")
    assert r.status_code == 415
    assert r.json()["code"] == "UNSUPPORTED_MEDIA_TYPE"
    # undeclared content-type (octet-stream = undeclared) ALSO 415s:
    # the sniff trusts magic bytes, not the header (§15.2 step 2).
    r2 = _upload(client, pid, "label_photo", "clip.gif", fixtures["gif"])
    assert r2.status_code == 415
    assert r2.json()["code"] == "UNSUPPORTED_MEDIA_TYPE"
    assert _stored_leaves(svc, pid, "product_photo") == []
    assert _stored_leaves(svc, pid, "label_photo") == []


# -- F-passthrough (§15.8 #3): <= P2 stores byte-identical, container kept --


def test_fpassthrough_small_jpeg_byte_identical(client, svc, fixtures):
    pid = _mk(client, svc)
    assert len(fixtures["small_jpeg"]) <= 307_200  # P5 input class
    r = _upload(client, pid, "product_photo", "p1.jpg", fixtures["small_jpeg"],
                "image/jpeg")
    assert r.status_code == 200, r.text
    slot = r.json()
    assert slot["byte_size"] == len(fixtures["small_jpeg"])
    assert slot["original_size"] == len(fixtures["small_jpeg"])
    assert slot["mime_type"] == "image/jpeg"  # container NOT re-encoded
    assert slot["filename"].endswith(".jpg")
    assert slot["pipeline"] == "imgpipe_v1"
    # GET on the returned url streams the STORED artifact, byte-identical
    got = client.get(slot["url"])
    assert got.status_code == 200
    assert got.content == fixtures["small_jpeg"]
    assert got.headers["content-type"].startswith("image/jpeg")
    # on-disk copy under the slot dir is byte-identical too
    assert slot["filename"] in _stored_leaves(svc, pid, "product_photo")
    assert _stored_bytes(svc, pid, "product_photo",
                        slot["filename"]) == fixtures["small_jpeg"]


def test_fpassthrough_small_webp_container_kept(client, svc, fixtures):
    """§15.4: passthrough keeps the ORIGINAL container (image/webp here)."""
    pid = _mk(client, svc)
    r = _upload(client, pid, "product_photo", "p.webp", fixtures["small_webp"],
                "image/webp")
    assert r.status_code == 200, r.text
    slot = r.json()
    assert slot["mime_type"] == "image/webp"
    assert slot["byte_size"] == len(fixtures["small_webp"])
    got = client.get(slot["url"])
    assert got.content == fixtures["small_webp"]


# -- corrupt payload (§15.2 step 4 + §15.3): a bad FILE is a 415 ------------


def test_fcorrupt_truncated_jpeg_above_target_is_415(client, svc, fixtures):
    """Sniff-valid but UNDECODABLE, bigger than P2 -> 415 (not 500): a
    corrupt image is a bad file, not a server failure. Nothing stored."""
    pid = _mk(client, svc)
    assert len(fixtures["corrupt_trunc"]) > 307_200  # > P2 => decode runs
    r = _upload(client, pid, "product_photo", "broken.jpg",
                fixtures["corrupt_trunc"], "image/jpeg")
    assert r.status_code == 415, r.text
    assert r.json()["code"] == "UNSUPPORTED_MEDIA_TYPE"
    assert r.json()["message"] == CANON_UNREADABLE
    assert _stored_leaves(svc, pid, "product_photo") == []


def test_fcorrupt_under_target_stores_byte_identical(client, svc, fixtures):
    """Pinned design (NOT a defect): the passthrough shortcut skips decode
    (§15.2 step 3 BEFORE step 4), so a corrupt payload UNDER P2 stores
    as-is. Pinned here so a future 'validate everything' refactor cannot
    silently flip this branch."""
    pid = _mk(client, svc)
    small_corrupt = fixtures["corrupt_whole"][:200_000]  # sniff-valid < P2
    r = _upload(client, pid, "product_photo", "trunc.jpg", small_corrupt,
                "image/jpeg")
    assert r.status_code == 200, r.text
    assert r.json()["byte_size"] == len(small_corrupt)
    got = client.get(r.json()["url"])
    assert got.content == small_corrupt


# -- F-big / F-phone (§15.8 #4/#5): oversized -> compressed to target ------


def test_fbig_camera_like_compresses_under_target(client, svc, fixtures):
    """The task's headline clause: 'oversized images are compressed to the
    configured target'. Seed-fixed camera-like JPEG (4032x3024, seed-
    pinned quality so it lands strictly INSIDE the (P2, P1) window)."""
    pid = _mk(client, svc)
    cam = fixtures["cam"]
    assert 307_200 < len(cam) < 26_214_400  # oversized, but INSIDE the gate
    r = _upload(client, pid, "product_photo", "IMG_4032.jpg", cam,
                "image/jpeg")
    assert r.status_code == 200, r.text
    slot = r.json()
    assert slot["mime_type"] == "image/webp"      # P3: stored container
    assert slot["byte_size"] <= 307_200            # P2: reached the target
    assert slot["original_size"] == len(cam)
    # ratio >= 20:1 on a camera-like source (§15.8 #4, pinned with margin)
    assert slot["original_size"] >= 20 * slot["byte_size"]
    # the stored artifact DECODES and the long edge was clamped to 2048 (P4)
    stored = _stored_bytes(svc, pid, "product_photo", slot["filename"])
    assert len(stored) == slot["byte_size"]
    img = Image.open(io.BytesIO(stored))
    img.load()
    assert img.format == "WEBP"
    assert max(img.size) <= 2048 + 1  # clamp + round tolerance
    # GET parity: url serves the SAME compressed bytes
    got = client.get(slot["url"])
    assert got.content == stored
    assert got.headers["content-type"].startswith("image/webp")


# -- F-kill (§15.8 #7): SOLIN_IMG_COMPRESS=false = pre-§15 control ---------


def test_fkill_switch_stores_byte_identical(client, svc, monkeypatch,
                                            fixtures):
    """Kill switch ON = exact pre-§15 behaviour: sniff-passing uploads <= P1
    store byte-identical (no re-encode), the cascade would skip decode."""
    monkeypatch.setattr(service_mod, "_settings",
                        lambda: Settings(img_compress=False))
    pid = _mk(client, svc)
    r = _upload(client, pid, "product_photo", "cam.jpg", fixtures["cam"],
                "image/jpeg")
    assert r.status_code == 200, r.text
    slot = r.json()
    # bytes stored EXACTLY as uploaded (the §15 pipeline never ran)
    assert slot["byte_size"] == len(fixtures["cam"])
    assert slot["mime_type"] == "image/jpeg"  # declared type trusted (P7)
    got = client.get(slot["url"])
    assert got.content == fixtures["cam"]


def test_fkill_switch_keeps_413_gate(client, svc, monkeypatch, fixtures):
    """P7's exception: the 413 gate still reads SOLIN_IMG_MAX_UPLOAD_BYTES
    under the kill switch (25 MiB, not the dead 10 MiB constant)."""
    monkeypatch.setattr(service_mod, "_settings",
                        lambda: Settings(img_compress=False))
    pid = _mk(client, svc)
    r = _upload(client, pid, "product_photo", "big.jpg", fixtures["big413"],
                "image/jpeg")
    assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"


# -- F-fail (§15.8 #6): stored guard -> 422 + unit-level never-larger ------


def test_fguard_422_when_guard_tightened(client, svc, monkeypatch, fixtures):
    """SOLIN_IMG_MAX_STORED_BYTES=1024: input the pipeline genuinely
    cannot shrink below the guard -> 422 IMAGE_COMPRESS_FAILED, canonical
    message, NOTHING stored (the doc slot stays empty)."""
    monkeypatch.setattr(service_mod, "_settings",
                        lambda: Settings(img_max_stored_bytes=1024))
    pid = _mk(client, svc)
    r = _upload(client, pid, "product_photo", "cam.jpg", fixtures["cam"],
                "image/jpeg")
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["code"] == "IMAGE_COMPRESS_FAILED"
    assert body["message"] == CANON_FAILED
    assert _stored_leaves(svc, pid, "product_photo") == []
    # and the product remains usable after the failed attempt
    g = client.get(f"/api/v1/inventory/{pid}")
    assert g.status_code == 200
    assert g.json()["images"]["product_photo"] is None


def test_pipeline_never_stores_larger_unit(fixtures):
    """§15.8 #6 second half, unit level: compress_image's result is NEVER
    larger than the upload (P5), on every fixture class that reaches it."""
    from app.inventory.image_pipeline import compress_image, ImageDecodeError

    for blob in (fixtures["corrupt_trunc"],):
        with pytest.raises(ImageDecodeError):
            compress_image(blob)
    res = compress_image(fixtures["cam"])
    assert len(res.stored) < len(fixtures["cam"])
    assert res.stored[:4] == b"RIFF"  # P3 container


# -- F-log (§15.8 #8): ONE solin.media upload line per attempt --------------


def test_flog_one_line_per_attempt_with_correlation_fields(client, svc,
                                                            caplog, fixtures):
    pid = _mk(client, svc)
    with caplog.at_level(logging.INFO, logger="solin.media"):
        _upload(client, pid, "product_photo", "a.jpg", fixtures["small_jpeg"],
                "image/jpeg")                       # passthrough -> stored
        _upload(client, pid, "product_photo", "cam.jpg", fixtures["cam"],
                "image/jpeg")                        # compress -> stored
        _upload(client, pid, "product_photo", "big.jpg", fixtures["big413"],
                "image/jpeg")                        # gate -> too_large
        _upload(client, pid, "product_photo", "x.txt", fixtures["text"],
                "image/jpeg")                        # sniff -> bad_type
        # NOT attempts (stayed silent pre-§15 too): empty body, bad slot
        _upload(client, pid, "product_photo", "e.jpg", b"", "image/jpeg")
        _upload(client, pid, "bogus_slot", "a.jpg", fixtures["small_jpeg"],
                "image/jpeg")
    lines = [rec.getMessage() for rec in caplog.records
             if rec.name == "solin.media"]
    assert len(lines) == 4, lines          # 4 pipeline ATTEMPTS, no more
    for ln in lines:
        assert "upload product_id=" in ln  # greppable marker, key=value form
        for key in ("original_bytes=", "stored_bytes=", "mode=", "q=",
                    "outcome=", "dur_ms=", "sha1_8="):
            assert key in ln, ln
    outcomes = [ln.split("outcome=")[1].split()[0] for ln in lines]
    assert outcomes == ["stored", "stored", "too_large", "bad_type"]
    # no secrets, no absolute paths, no EXIF-ish payloads (§15.6)
    joined = "\n".join(lines)
    assert "Users" not in joined and "media" not in joined
    assert "/" not in joined and "\\" not in joined


# -- product usability AFTER compression (t_0595a9ba clause + §15.4) --------


def test_product_creation_and_edit_usable_after_compression(client, svc,
                                                             fixtures):
    """Create -> compressed upload -> doc roundtrip -> PUT that ROUNDS
    THE IMAGE through validation (§15.4: the two new ImageSlot keys must
    be accepted) -> slot dir + macronutrient block intact."""
    pid = _mk(client, svc)
    macronutrient_before = svc.get(pid)["macros_per_100"]
    r = _upload(client, pid, "product_photo", "cam.jpg", fixtures["cam"],
                "image/jpeg")
    assert r.status_code == 200, r.text
    slot = r.json()
    assert slot["pipeline"] == "imgpipe_v1"
    assert slot["original_size"] == len(fixtures["cam"])
    # GET the product: images slot is now populated, doc shape unchanged
    g = client.get(f"/api/v1/inventory/{pid}").json()
    assert g["images"]["product_photo"]["filename"] == slot["filename"]
    assert g["images"]["product_photo"]["pipeline"] == "imgpipe_v1"
    assert g["images"]["product_photo"]["original_size"] == slot["original_size"]
    # PUT body that echoes the upload response back (§15.4 roundtrip):
    # validate_image_body must ACCEPT original_size + pipeline, not 422.
    r2 = client.put(f"/api/v1/inventory/{pid}", json={
        "name": "QA product re-named",
        "images": {"product_photo": dict(slot)},
    })
    assert r2.status_code == 200, r2.text
    doc = client.get(f"/api/v1/inventory/{pid}").json()
    assert doc["name"] == "QA product re-named"
    assert doc["images"]["product_photo"]["pipeline"] == "imgpipe_v1"
    assert doc["images"]["product_photo"]["byte_size"] == slot["byte_size"]
    # macronutrient block survived the compressed-upload + PUT chain
    assert doc["macros_per_100"] == macronutrient_before
    # the slot dir stayed exactly ONE file across re-upload-free edits
    assert _stored_leaves(svc, pid, "product_photo") == [slot["filename"]]
    # GET still serves the stored artifact after the doc roundtrip
    assert client.get(slot["url"]).content == _stored_bytes(
        svc, pid, "product_photo", slot["filename"])


# -- undeclared type parity (dev decision: '' / octet-stream TRUST sniff) ---


def test_undeclared_content_type_roundtrip(client, svc, fixtures):
    """SPA FormData sends Blobs typed image/jpeg or octet-stream; both
    must keep working (sniff trust, developer notes §15.4 re-anchor)."""
    pid = _mk(client, svc)
    # undeclared: octet-stream + REAL webp bytes -> sniff trusts, passthrough
    r = _upload(client, pid, "product_photo", "x", fixtures["small_webp"],
                "application/octet-stream")
    assert r.status_code == 200, r.text
    slot = r.json()
    assert slot["mime_type"] == "image/webp"  # stored container from sniff
    assert client.get(slot["url"]).content == fixtures["small_webp"]
    # empty declared type with JPEG-magic junk -> sniff hit still stores
    r2 = _upload(client, pid, "label_photo", "blob",
                 b"\xff\xd8\xff\xe0" + b"\x11" * (180 * 1024), "")
    assert r2.status_code == 200, r2.text
    assert r2.json()["mime_type"] == "image/jpeg"


# -- F-slot (§15.8 #9): re-upload replaces; DELETE cascades BOTH slots ------


def test_fslot_reupload_replaces_and_delete_cascades(client, svc, fixtures):
    """The §15 pipeline must not eat the §3.5/§3.7 storage invariants."""
    pid = _mk(client, svc)
    r1 = _upload(client, pid, "product_photo", "a.jpg", fixtures["small_jpeg"],
                 "image/jpeg")
    r2 = _upload(client, pid, "product_photo", "b.jpg", fixtures["cam"],
                 "image/jpeg")  # triggers the compress branch too
    assert r1.status_code == 200 and r2.status_code == 200, r2.text
    # disk: only the NEW leaf remains in the slot dir (last-write-wins)
    leaves = _stored_leaves(svc, pid, "product_photo")
    assert r2.json()["filename"] in leaves
    assert r1.json()["filename"] not in leaves
    # slot JSON: the doc carries only the new slot object
    doc = client.get(f"/api/v1/inventory/{pid}").json()
    assert doc["images"]["product_photo"]["filename"] == r2.json()["filename"]
    # DELETE cascades BOTH slot dirs (§3.5 unchanged): fill the label slot,
    # delete, assert the whole per-product media dir is swept.
    assert _upload(client, pid, "label_photo", "l.jpg", fixtures["small_jpeg"],
                  "image/jpeg").status_code == 200
    inv_dir = os.path.join(media_mod.media_root(), "inventory", pid)
    assert os.path.isdir(inv_dir)
    assert client.delete(f"/api/v1/inventory/{pid}").status_code == 204
    assert not os.path.isdir(inv_dir)  # row + BOTH slot dirs swept
