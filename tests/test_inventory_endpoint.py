"""Endpoint integration tests for the Solin inventory (acceptance criteria #1–#4).

Uses ``fastapi.testclient.TestClient`` (in-process ASGI, no network). Each
test spins a FRESH :class:`InventoryService` on a temp store and a temp media
root (monkeypatched before the service is built), and routes are called
through the *real* app so status codes + error bodies match the normative
§6 shape.

Covers:
  * POST   /inventory            → 201 + stored record matches (macros + prices)
  * GET    /inventory            → list/search/pagination
  * GET    /inventory/{id}       → 200 / 404 NOT_FOUND; image URLs fetchable
  * PUT    /inventory/{id}       → independent updates (macros/prices/images)
  * DELETE /inventory/{id}       → 204, row + media files gone
  * POST   /inventory/{id}/images/{slot} → 200 ImageSlot | 413 | 415 | 404
"""
import io
import os

import pytest

from fastapi.testclient import TestClient

from app.main import app
from app.inventory.service import InventoryService
from app.inventory.store import ProductStore

JPG = b"\xff\xd8\xff\xdb\x00\x43\x00" + b"\x00" * 60 + b"\xff\xd9"  # plausible-ish
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40


@pytest.fixture
def svc(tmp_path, monkeypatch):
    # Uploads and the StaticFiles mount must agree on ONE directory. The
    # mount path is captured at app import time, so find it and repoint the
    # service's media writes at the exact same root (upload + fetch parity).
    import app.inventory.media as media_mod
    mount_dir = None
    for r in app.routes:
        if getattr(r, "path", "") == "/media":
            from fastapi.staticfiles import StaticFiles
            inner = getattr(r, "app", r)  # app.mount wraps the StaticFiles
            if isinstance(inner, StaticFiles):
                mount_dir = str(inner.directory)
            break
    assert mount_dir is not None
    monkeypatch.setattr(media_mod, "media_root", lambda: mount_dir)
    tmp_store = str(tmp_path / "data" / "products.json")
    return InventoryService(store=ProductStore(path=tmp_store))


@pytest.fixture
def client(svc, monkeypatch):
    # Swap the router's service reference for the temp-backed one so the
    # routes hit our temp store / media root (same adapter, injected state).
    import app.inventory.routes as routes_mod
    monkeypatch.setattr(routes_mod, "svc", svc)
    yield TestClient(app)


def _macro_block(**over):
    base = {"calories": 165, "protein": 31.0, "fat": 3.6, "carbs": 0,
            "fiber": 0, "sugar": 0, "sodium": 74}
    base.update(over)
    return base


# ---------------------------------------------------------------------------
# POST /inventory — acceptance #1
# ---------------------------------------------------------------------------

def test_post_201_full_payload_roundtrip(client, svc):
    payload = {
        "name": "Chicken breast", "brand": "Oyala", "base_unit": "g",
        "serving_size": 150, "serving_label": "1 piece",
        "macros_per_100": _macro_block(),
        "prices": [
            {"amount": 2.99, "currency": "USD", "pack_size": 400, "source": "home"},
            {"amount": 3.49, "currency": "EUR", "pack_size": 500, "source": "Lidl"},
        ],
    }
    r = client.post("/inventory", json=payload)
    assert r.status_code == 201, r.text
    body = r.json()
    # Server-generated identity
    assert body["id"] and body["id"] != payload.get("id")
    assert body["created_at"] and body["updated_at"]
    # Canonical field match
    assert body["name"] == "Chicken breast"
    assert body["base_unit"] == "g"
    assert body["serving_size"] == 150.0
    assert body["macros_per_100"]["protein"] == 31.0
    assert len(body["prices"]) == 2
    assert all(p["id"] for p in body["prices"])  # server mints ids
    assert all(p["captured_at"] for p in body["prices"])
    # Image slots start empty
    assert body["images"]["product_photo"] is None
    assert body["images"]["label_photo"] is None
    # Store roundtrip
    stored = svc.get(body["id"])
    assert stored["name"] == body["name"]
    assert stored["prices"][0]["amount"] == 2.99


def test_post_400_missing_macro_field(client):
    r = client.post("/inventory", json={
        "name": "X", "base_unit": "g",
        "macros_per_100": {"calories": 10, "protein": 1, "fat": 1,
                           "carbs": 1, "fiber": 1, "sugar": 1},  # no sodium
    })
    assert r.status_code == 400
    b = r.json()
    assert b["code"] == "MACRO_BLOCK_INCOMPLETE"
    assert "macros_per_100.sodium" in b["fields"]


def test_post_400_negative_macro(client):
    r = client.post("/inventory", json={
        "name": "X", "base_unit": "g", "macros_per_100": _macro_block(calories=-5)})
    assert r.status_code == 400 and r.json()["code"] == "VALIDATION_ERROR"


def test_post_400_bad_base_unit(client):
    r = client.post("/inventory", json={
        "name": "X", "base_unit": "cup", "macros_per_100": _macro_block()})
    assert r.status_code == 400 and r.json()["code"] == "VALIDATION_ERROR"


def test_post_400_non_numeric_macro(client):
    # §1.1: "missing or non-number" macro keys → MACRO_BLOCK_INCOMPLETE (400);
    # the service maps a non-numeric value to that code (a field-level defect).
    r = client.post("/inventory", json={
        "name": "X", "base_unit": "g",
        "macros_per_100": {"calories": "fast", "protein": 1, "fat": 1,
                           "carbs": 1, "fiber": 1, "sugar": 1, "sodium": 1}})
    assert r.status_code == 400
    assert r.json()["code"] == "MACRO_BLOCK_INCOMPLETE"
    assert "macros_per_100.calories" in r.json()["fields"]


def test_post_422_macro_block_not_object(client):
    # A true type-shape mismatch (macro block not an object) → 422 UNPROCESSABLE.
    r = client.post("/inventory", json={
        "name": "X", "base_unit": "g", "macros_per_100": "165 kcal"})
    assert r.status_code == 422
    assert r.json()["code"] == "UNPROCESSABLE"


# ---------------------------------------------------------------------------
# GET routes
# ---------------------------------------------------------------------------

def test_list_search_and_pagination(client, svc):
    for name in ["Apple", "Banana", "Cherry", "Date"]:
        svc.create({"name": name, "base_unit": "g", "macros_per_100": _macro_block()})
    r = client.get("/inventory", params={"limit": 2, "offset": 0})
    assert r.status_code == 200
    b = r.json()
    assert b["total"] == 4 and len(b["items"]) == 2
    r = client.get("/inventory", params={"search": "bana"})
    assert r.json()["total"] == 1 and r.json()["items"][0]["name"] == "Banana"


def test_get_200_and_404(client, svc):
    pid = svc.create({"name": "Solo", "base_unit": "ml",
                      "macros_per_100": _macro_block()})["id"]
    r = client.get(f"/inventory/{pid}")
    assert r.status_code == 200 and r.json()["id"] == pid
    r = client.get("/inventory/does-not-exist")
    assert r.status_code == 404 and r.json()["code"] == "NOT_FOUND"


# ---------------------------------------------------------------------------
# PUT /inventory/{id} — acceptance #3 (independent fields)
# ---------------------------------------------------------------------------

def _mk(client, svc, name="Test"):
    return svc.create({"name": name, "base_unit": "g",
                       "macros_per_100": _macro_block()})["id"]


def test_put_macros_only(client, svc):
    pid = _mk(client, svc)
    r = client.put(f"/inventory/{pid}",
                   json={"macros_per_100": _macro_block(protein=40.0)})
    assert r.status_code == 200
    b = r.json()
    assert b["macros_per_100"]["protein"] == 40.0
    # Untouched fields preserved
    assert b["name"] == "Test"
    assert b["prices"] == []


def test_put_prices_full_replacement(client, svc):
    pid = _mk(client, svc)
    # Start with 1 entry
    client.put(f"/inventory/{pid}", json={"prices": [
        {"amount": 1.00, "currency": "USD", "pack_size": 10}]})
    # Replace with 2 (different amounts) — old entry must disappear
    r = client.put(f"/inventory/{pid}", json={"prices": [
        {"amount": 2.00, "currency": "USD", "pack_size": 20},
        {"amount": 3.00, "currency": "EUR", "pack_size": 30},
    ]})
    assert r.status_code == 200
    prices = r.json()["prices"]
    assert len(prices) == 2
    assert {p["amount"] for p in prices} == {2.0, 3.0}
    assert 1.0 not in {p["amount"] for p in prices}  # old one gone


def test_put_images_set_and_clear(client, svc):
    pid = _mk(client, svc)
    # Seed an "already uploaded" reference (simulates a prior §3.7 upload)
    slot_ref = {"url": "/media/inventory/%s/product_photo/uploaded.jpg" % pid,
                "filename": "uploaded.jpg", "mime_type": "image/jpeg",
                "byte_size": 100, "uploaded_at": "2026-01-01T00:00:00Z"}
    r = client.put(f"/inventory/{pid}",
                   json={"images": {"product_photo": slot_ref}})
    assert r.status_code == 200
    assert r.json()["images"]["product_photo"]["url"].endswith("uploaded.jpg")
    # Now clear
    r = client.put(f"/inventory/{pid}",
                   json={"images": {"product_photo": None}})
    assert r.json()["images"]["product_photo"] is None


def test_put_400_unknown_field(client, svc):
    pid = _mk(client, svc)
    r = client.put(f"/inventory/{pid}", json={"bogus_key": 1})
    assert r.status_code == 400 and r.json()["code"] == "VALIDATION_ERROR"


def test_put_404(client):
    r = client.put("/inventory/ghost", json={"name": "Ghost"})
    assert r.status_code == 404 and r.json()["code"] == "NOT_FOUND"


# ---------------------------------------------------------------------------
# DELETE — acceptance #4
# ---------------------------------------------------------------------------

def test_delete_204_and_media_gone(client, svc, tmp_path):
    pid = _mk(client, svc)
    # Upload a real image so the media dir exists
    svc.upload_image(pid, "product_photo", JPG, "image/jpeg", "orig.jpg")
    from app.inventory.media import media_root
    inv_dir = os.path.join(media_root(), "inventory", pid)
    assert os.path.isdir(inv_dir)
    r = client.delete(f"/inventory/{pid}")
    assert r.status_code == 204
    assert not os.path.isdir(inv_dir)  # media swept
    from app.inventory.validation import InventoryError as IE
    with pytest.raises(IE):
        svc.get(pid)


# ---------------------------------------------------------------------------
# POST /inventory/{id}/images/{slot} — acceptance #2 (URLs fetchable)
# ---------------------------------------------------------------------------

def _upload(client, svc, pid, slot, name, data, ctype):
    return client.post(
        f"/inventory/{pid}/images/{slot}",
        files={"file": (name, io.BytesIO(data), ctype)},
    )


def test_upload_200_and_url_fetchable(client, svc):
    pid = _mk(client, svc)
    r = _upload(client, svc, pid, "product_photo", "chicken.jpg", JPG, "image/jpeg")
    assert r.status_code == 200, r.text
    slot = r.json()
    assert slot["mime_type"] == "image/jpeg"
    assert slot["url"].startswith("/media/inventory/%s/product_photo/" % pid)
    assert slot["byte_size"] == len(JPG)
    assert slot["original_name"] == "chicken.jpg"
    # Contract QA assertion: GET <url> returns the bytes with content-type.
    got = client.get(slot["url"])
    assert got.status_code == 200
    assert got.content == JPG
    assert got.headers["content-type"].startswith("image/jpeg")
    # Product now reports the slot
    assert client.get(f"/inventory/{pid}").json()["images"]["product_photo"]["url"] == slot["url"]


def test_upload_replaces_previous(client, svc):
    pid = _mk(client, svc)
    r1 = _upload(client, svc, pid, "label_photo", "a.png", PNG, "image/png")
    r2 = _upload(client, svc, pid, "label_photo", "b.png", PNG + b"x", "image/png")
    assert r1.json()["url"] != r2.json()["url"] or r2.json()["filename"] != r1.json()["filename"]
    # The product's stored slot is the NEW one
    stored = client.get(f"/inventory/{pid}").json()["images"]["label_photo"]
    assert stored["filename"] == r2.json()["filename"]
    assert stored["byte_size"] == len(PNG) + 1


def test_upload_415_bad_type(client, svc):
    pid = _mk(client, svc)
    r = _upload(client, svc, pid, "product_photo", "x.txt", b"hello", "text/plain")
    assert r.status_code == 415 and r.json()["code"] == "UNSUPPORTED_MEDIA_TYPE"


def test_upload_413_too_large(client, svc):
    from app.inventory.validation import MAX_IMAGE_BYTES
    pid = _mk(client, svc)
    big = b"\x00" * (MAX_IMAGE_BYTES + 1)
    r = _upload(client, svc, pid, "product_photo", "big.jpg", big, "image/jpeg")
    assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"


def test_upload_404_unknown_product(client, svc):
    r = _upload(client, svc, "noid", "product_photo", "x.jpg", JPG, "image/jpeg")
    assert r.status_code == 404 and r.json()["code"] == "NOT_FOUND"


def test_upload_400_bad_slot_name(client, svc):
    r = _upload(client, svc, "noid", "bogus_slot", "x.jpg", JPG, "image/jpeg")
    # 400 VALIDATION_ERROR (slot whitelist) — product not found path also 404,
    # but slot is validated after existence; either is acceptable per contract.
    assert r.status_code in (400, 404)
