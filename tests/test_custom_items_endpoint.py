"""HTTP-level coverage for custom "egyéb" items (spec §11, task t_5721a2dd).

POST /api/v1/inventory/macros/count with items[] carrying type:"custom"
rows — the wire shape. Pins:
  * 200 happy paths (mixed paired+custom, custom-only batch);
  * per_ingredient custom row = source:"custom" + verbatim macros + r2 cost;
  * invalid custom anywhere in items[] → 400 CUSTOM_ITEM_INVALID with the
    exact bad-field list (raised BEFORE aggregation — mixed batch too,
    never a partial "excluded and counted" result);
  * zero-valid batch → 400 VALIDATION_ERROR (never 200-of-zeros);
  * cross-currency custom cost excluded from total_cost (display-only on
    the row) with per-row + top-level CROSS_CURRENCY_EXCLUDED warnings;
  * A3 regression through the wire: paired-only batch unchanged.

Run:  .venv/bin/python -m pytest tests/test_custom_items_endpoint.py -q
"""
import json
import os

import pytest
from fastapi.testclient import TestClient

from app.inventory.routes import router  # noqa: F401 — package wiring guard
from app.inventory.service import InventoryService
from app.inventory.store import ProductStore

ROOT = os.path.dirname(os.path.abspath(__file__))
URL = "/api/v1/inventory/macros/count"

A2_CUSTOM = {
    "type": "custom", "name": "Chilipehely", "quantity": 5, "unit": "g",
    "price": 0.35, "currency": "USD",
    "macros": {"calories": 15.90, "protein": 0.67, "fat": 0.87, "carbs": 2.83,
               "fiber": 1.36, "sugar": 2.10, "sodium": 1.50},
}


@pytest.fixture()
def client(tmp_path):
    """TestClient over a temp store seeded with the §5.2 PORTIONS products."""
    with open(os.path.join(ROOT, "fixtures", "PORTIONS.json"),
              encoding="utf-8") as fh:
        fx = json.load(fh)
    store_path = tmp_path / "products.json"
    store_path.write_text(
        json.dumps({"products": fx["engine_inputs"]["products"], "price_seq": 0},
                   ensure_ascii=False), encoding="utf-8")
    import app.inventory.routes as routes_mod

    svc = InventoryService(store=ProductStore(path=str(store_path)))
    import app.main as main_mod

    monkey_patch_target = routes_mod
    original = monkey_patch_target.svc
    monkey_patch_target.svc = svc
    try:
        with TestClient(main_mod.app) as c:
            yield c
    finally:
        monkey_patch_target.svc = original


def paired_only():
    with open(os.path.join(ROOT, "fixtures", "PORTIONS.json"),
              encoding="utf-8") as fh:
        return json.load(fh)["engine_inputs"]["ingredients"]


def test_happy_mixed_batch_full_math(client):
    """§11.6 A2 through the wire: custom row counts in totals; its USD cost
    joins total_cost (sum-of-rounded §4.2); 4 dp totals + per_portion split
    + per_portion_cost = r2(2.40/4) = 0.60."""
    items = paired_only() + [dict(A2_CUSTOM)]
    r = client.post(URL, json={"items": items, "portions": 4})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["totals"] == {"calories": 783.30, "protein": 70.57,
                              "fat": 18.97, "carbs": 81.63, "fiber": 3.46,
                              "sugar": 2.20, "sodium": 151.50}
    assert body["total_cost"] == {"amount": 2.40, "currency": "USD"}
    assert body["per_portion"] == {"calories": 195.83, "protein": 17.64,
                                   "fat": 4.74, "carbs": 20.41, "fiber": 0.87,
                                   "sugar": 0.55, "sodium": 37.88}
    assert body["per_portion_cost"] == {"amount": 0.60, "currency": "USD"}
    row = body["per_ingredient"][3]          # AFTER paired rows (A2)
    assert row["source"] == "custom" and row["product_id"] is None
    assert row["quantity"] == 5 and row["unit"] == "g"
    assert row["cost"] == 0.35               # r2(price), as entered
    assert row["macros"]["calories"] == 15.90    # VERBATIM, not per-100g
    assert row["warnings"] == []


def test_custom_only_batch(client):
    """R2 end-to-end: a batch with ONLY a custom row computes; the currency
    comes from the row (omitted currency would default to HUF, never USD)."""
    r = client.post(URL, json={"items": [dict(A2_CUSTOM)]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_cost"] == {"amount": 0.35, "currency": "USD"}
    assert body["totals"]["calories"] == pytest.approx(15.90)
    assert body["per_ingredient"][0]["source"] == "custom"
    # omitted currency → HUF default (R1/R2 bullet)
    r2 = client.post(URL, json={"items": [{"type": "custom", "name": "Só",
                                            "price": 500}]})
    assert r2.json()["total_cost"] == {"amount": 500, "currency": "HUF"}


def test_huf_repeat_custom_excluded(client):
    """A2 currency-split repeat: same row with 1.20 HUF ≠ USD base →
    cost EXCLUDED from total_cost (2.05 USD) + per-row and top-level
    CROSS_CURRENCY_EXCLUDED; display-only cost still on the row."""
    huf = dict(A2_CUSTOM, price=1.20, currency="HUF")
    r = client.post(URL, json={"items": paired_only() + [huf]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_cost"] == {"amount": 2.05, "currency": "USD"}
    row = body["per_ingredient"][3]
    assert "CROSS_CURRENCY_EXCLUDED" in row["warnings"]
    assert {"code": "CROSS_CURRENCY_EXCLUDED", "product_id": "Chilipehely"} \
        in body["warnings"]
    assert row["cost"] == 1.20               # displayed, NOT summed


def test_invalid_custom_400_before_aggregation(client):
    """R3 server half: same violations the client pre-rejects → 400
    CUSTOM_ITEM_INVALID with fields = the bad-field list. A MIXED batch
    (paired rows that WOULD count) refuses with the same 400 — never a
    partial "excluded the bad row and counted the rest" 200."""
    bad = {"type": "custom", "name": "Tบางอย่าง", "price": -5,
           "macros": {"fat": 2, "sodium": 3.333}}
    r = client.post(URL, json={"items": paired_only() + [bad]})
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["code"] == "CUSTOM_ITEM_INVALID"
    assert set(body.get("fields", [])) == {"price", "sodium"}
    # single-row refusal too (price <= 0)
    r2 = client.post(URL, json={"items": [{"type": "custom", "name": "X",
                                            "price": 0}]})
    assert r2.status_code == 400
    assert r2.json()["code"] == "CUSTOM_ITEM_INVALID"
    assert r2.json()["fields"] == ["price"]


def test_zero_valid_batch_refused_not_zeros(client):
    """§11.4 count guard: non-empty items[] but zero computable rows →
    400 VALIDATION_ERROR, never 200-with-zeros (the §3.6 rule extended to
    custom). An empty-name custom row is invalid → CUSTOM_ITEM_INVALID."""
    r = client.post(URL, json={"items": [{"type": "custom",
                                            "name": "Valami"}]})
    assert r.status_code == 400, r.text      # computable rows = 0
    assert r.json()["code"] == "VALIDATION_ERROR"
    r2 = client.post(URL, json={"items": [{"type": "custom", "name": ""}]})
    assert r2.status_code == 400
    assert r2.json()["code"] == "CUSTOM_ITEM_INVALID"   # empty name = invalid
    assert r2.json()["fields"] == ["name"]


def test_paired_only_batch_still_byte_identical(client):
    """A3 regression guard (wire): paired-only stays exactly as before the
    custom feature — including the seeded cross-currency HUF row exclusions
    and the unresolved-temporary row (PRODUCT_NOT_FOUND + zero macros)."""
    r = client.post(URL, json={"items": paired_only()})
    assert r.status_code == 200, r.text
    body = r.json()
    with open(os.path.join(ROOT, "fixtures", "PORTIONS.json"),
              encoding="utf-8") as fh:
        fx = json.load(fh)
    assert body["totals"] == fx["expected_totals"]
    assert body["total_cost"] == fx["expected_total_cost"]
    # p1 USD (active seed price), p2/p3 HUF → excluded, temporary HUF →
    # PRODUCT_NOT_FOUND — the pre-change warnings contract, untouched.
    assert body["warnings"] == fx["expected_warnings"]
