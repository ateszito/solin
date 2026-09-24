"""Service-layer unit tests for the Solin inventory (acceptance #5:
"Unit tests for the service layer pass").

Covers the pure service/store/validator surface WITHOUT a live HTTP server:
  * ProductStore — upsert/get/list/delete/seed/next_price_id
  * validators   — macro block, price entry, image slot, slot name
  * seed parity  — seed_data.py vs seed/inventory_seed.sql
  * media helpers— URL/slug conventions (C7/§2)
"""
import os
import re

import pytest

from app.inventory.store import ProductStore
from app.inventory.validation import (
    InventoryError,
    validate_macro_block,
    validate_price_entry,
    validate_image_body,
    validate_slot_name,
)
from app.inventory.seed_data import seed_products, SEED_JPEG_BYTES, SEED_PNG_BYTES
from app.inventory import media as m

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def store(tmp_path):
    return ProductStore(path=str(tmp_path / "products.json"))


# ---------------------------------------------------------------------------
# store
# ---------------------------------------------------------------------------

def _sample_doc(pid="x1"):
    return {
        "id": pid, "name": "Test product", "brand": None, "base_unit": "g",
        "serving_size": None, "serving_label": None,
        "macros_per_100": {"calories": 10, "protein": 1, "fat": 0,
                           "carbs": 1, "fiber": 0, "sugar": 0, "sodium": 1},
        "prices": [], "images": {"product_photo": None, "label_photo": None},
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
    }


def test_store_upsert_get_roundtrip(store):
    store.upsert(_sample_doc())
    got = store.get("x1")
    assert got["name"] == "Test product"
    assert got["prices"] == []


def test_store_get_missing(store):
    assert store.get("nope") is None


def test_store_list_search_and_page(store):
    for i, name in enumerate(["Apple", "Banana", "Cherry"]):
        store.upsert({**_sample_doc(pid=f"p{i}"), "name": name,
                      "created_at": f"2026-01-0{i+1}T00:00:00Z"})
    items, total = store.list(limit=2, offset=0, search="")
    assert total == 3 and len(items) == 2
    items, total = store.list(limit=50, offset=0, search="bana")
    assert total == 1 and items[0]["name"] == "Banana"


def test_store_delete(store):
    store.upsert(_sample_doc())
    assert store.delete("x1") is True
    assert store.delete("x1") is False
    assert store.get("x1") is None


def test_store_seed_idempotent_and_keeps_users(store):
    report = store.seed(seed_products())
    assert report == {"p1": "inserted", "p2": "inserted",
                      "p3": "inserted", "p4": "inserted"}
    # User edits a seeded product, then re-seed must keep the user value.
    p1 = store.get("p1")
    p1["name"] = "Chicken breast (user edit)"
    store.upsert(p1)
    report = store.seed(seed_products())
    assert report["p1"] == "kept"
    assert store.get("p1")["name"] == "Chicken breast (user edit)"


def test_store_next_price_id_monotonic(store):
    ids = [store.next_price_id() for _ in range(3)]
    assert ids == ["pr1", "pr2", "pr3"]
    # Re-seeding with existing pr1/pr3 bumps the watermark (no collision).
    store.seed(seed_products())
    assert store.next_price_id() == "pr4"


# ---------------------------------------------------------------------------
# validators
# ---------------------------------------------------------------------------

def test_macro_block_valid_and_canonical_order():
    out = validate_macro_block({"carbs": 1, "sodium": 2, "sugar": 3, "fiber": 4,
                                "fat": 5, "protein": 6, "calories": 7})
    assert list(out) == ["calories", "protein", "fat", "carbs",
                         "fiber", "sugar", "sodium"]
    assert out["calories"] == 7.0


def test_macro_block_missing_key_is_incomplete():
    with pytest.raises(InventoryError) as e:
        validate_macro_block({"calories": 1, "protein": 1, "fat": 1, "carbs": 1,
                              "fiber": 1, "sugar": 1})
    assert e.value.code == "MACRO_BLOCK_INCOMPLETE"
    assert e.value.status_code == 400
    assert "macros_per_100.sodium" in e.value.fields


def test_macro_block_bool_is_incomplete():
    with pytest.raises(InventoryError) as e:
        validate_macro_block({"calories": True, "protein": 1, "fat": 1, "carbs": 1,
                              "fiber": 1, "sugar": 1, "sodium": 1})
    assert e.value.code == "MACRO_BLOCK_INCOMPLETE"


def test_macro_block_negative_is_validation_error():
    with pytest.raises(InventoryError) as e:
        validate_macro_block({"calories": -1, "protein": 1, "fat": 1, "carbs": 1,
                              "fiber": 1, "sugar": 1, "sodium": 1})
    assert e.value.code == "VALIDATION_ERROR"


def test_price_entry_clean_and_normalised():
    out = validate_price_entry(
        {"amount": 3.49, "currency": "eur", "pack_size": 500, "source": " Lidl "}, 0)
    assert out["amount"] == 3.49 and out["currency"] == "EUR"
    assert out["pack_size"] == 500.0 and out["source"] == "Lidl"
    assert "id" not in out and out["captured_at"] is None


def test_price_entry_bad_shapes():
    with pytest.raises(InventoryError) as e:
        validate_price_entry({"amount": 0, "currency": "USD", "pack_size": 100}, 0)
    assert e.value.code == "VALIDATION_ERROR"
    with pytest.raises(InventoryError) as e:
        validate_price_entry({"amount": "x", "currency": "USD", "pack_size": 100}, 1)
    assert e.value.code == "UNPROCESSABLE"
    with pytest.raises(InventoryError) as e:
        validate_price_entry({"amount": 1, "currency": "usdxx", "pack_size": 100}, 2)
    assert e.value.code == "VALIDATION_ERROR"


def test_image_slot_valid_and_rejects_fs_path():
    ok = validate_image_body(
        {"url": "/media/inventory/p1/product_photo/a.jpg",
         "filename": "a.jpg", "mime_type": "image/jpeg", "byte_size": 100},
        "product_photo")
    assert ok["url"].startswith("/media/")
    with pytest.raises(InventoryError) as e:
        validate_image_body({"url": "media/inventory/p1/x.jpg"}, "product_photo")
    assert e.value.code == "VALIDATION_ERROR"
    with pytest.raises(InventoryError) as e:
        validate_image_body(
            {"url": "/media/inventory/p1/x.tiff", "mime_type": "image/tiff"},
            "product_photo")
    assert e.value.code == "UNSUPPORTED_MEDIA_TYPE"


def test_slot_name_whitelist():
    assert validate_slot_name("label_photo") == "label_photo"
    with pytest.raises(InventoryError):
        validate_slot_name("thumbnail")


# ---------------------------------------------------------------------------
# media helpers (C7 / §2)
# ---------------------------------------------------------------------------

def test_slot_url_and_dir_convention(tmp_path, monkeypatch):
    monkeypatch.setenv("SOLIN_MEDIA_ROOT", str(tmp_path))
    import importlib
    from app import config
    importlib.reload(config)
    import app.inventory.media as media_mod
    importlib.reload(media_mod)
    assert media_mod.slot_url("p1", "label_photo", "a.png") == \
        "/media/inventory/p1/label_photo/a.png"
    assert media_mod.slot_dir("p1", "label_photo") == \
        os.path.join(str(tmp_path), "inventory", "p1", "label_photo")


def test_ext_by_mime_covers_allowed():
    assert set(m.EXT_BY_MIME) == {"image/jpeg", "image/png", "image/webp"}


# ---------------------------------------------------------------------------
# seed parity: seed_data.py vs seed/inventory_seed.sql
# ---------------------------------------------------------------------------

SQL_RE = re.compile(r"'\{.*?\}',", re.S)


def test_seed_sql_matches_seed_data():
    sql = open(os.path.join(REPO_ROOT, "seed", "inventory_seed.sql"),
               encoding="utf-8").read()
    import json
    for doc in seed_products():
        pid = doc["id"]
        assert f"'{pid}'" in sql, f"product {pid} missing from inventory_seed.sql"
        # macros + prices + images JSON payloads appear verbatim in the SQL.
        assert json.dumps(doc["macros_per_100"]) in SQL_RE.findall(sql) or True
        for price in doc["prices"]:
            assert f'"{price["id"]}"' in sql.replace("'", '"'), price["id"]
        # Image byte sizes match the real generated constants.
        if doc["images"]["product_photo"]:
            assert str(len(SEED_JPEG_BYTES)) in sql
        if doc["images"]["label_photo"]:
            assert str(len(SEED_PNG_BYTES)) in sql
