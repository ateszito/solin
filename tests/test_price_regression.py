"""Regression tests for recipe price calculation (t_15b93d31).

Background (t_8cd7a3d5 / t_09753c3f / t_160c4eaf / t_f56beded): the inflated
1,224,260 HUF shown for recipe r1 (kolbász + csirkemell + parmezán) was NOT
an engine bug — the six dev price rows stored whole-pack amounts with
pack_size=1.0, so cost = amount/pack_size x qty priced per-gram. After the
data fix (true pack weights 250/650 g) the same recipe totals 2,338.64 HUF
and Parmezán 40 g = 479.84 Ft.

These tests pin BOTH sides of that boundary:
  * the CORRECTED behaviour (pack_size = true pack mass) must keep yielding
    the corrected per-row and total costs — the acceptance figures;
  * the OLD inflated behaviour (pack_size = 1.0) must be reproduced exactly
    by the fixture so any future change that silently re-derives per-gram
    costs (or flips the pairing-time unit conversion) fails here first.

Fixtures are the real dev catalog documents (GET /api/v1/inventory/{id}
dumps of 2026-10-10), so the r1 pairing ids in the bodies are the live ones.
Live dev endpoint replay is covered by SOLIN_LIVE_TESTS-gated smoke checks.

Run:  .venv/bin/pytest tests/test_price_regression.py -q
"""
import copy
import json
import os

import pytest
from fastapi.testclient import TestClient

from app.inventory.macros import aggregate_macro_result
from app.inventory.service import InventoryService
from app.inventory.store import ProductStore


# ---------------------------------------------------------------------------
# Ground-truth fixtures: the three dev products r1 pairs to, verbatim as
# served by GET /api/v1/inventory/{id} on 2026-10-10 (post pack_size fix).
# ---------------------------------------------------------------------------

KOLBASZ = {
    "id": "c4430fad-a86f-4fbc-8ca4-ab255c78c093",
    "name": "Csabai kolbasz",
    "brand": "Pikok pure",
    "base_unit": "g",
    "serving_size": 250.0,
    "serving_label": "2 db",
    "macros_per_100": {"calories": 481.0, "protein": 18.0, "fat": 45.0,
                       "carbs": 0.9, "fiber": 0.0, "sugar": 0.2, "sodium": 40.0},
    "prices": [{"amount": 1299.0, "currency": "HUF", "pack_size": 250.0,
               "source": "Lidl", "captured_at": "2026-10-07T20:04:40Z", "id": "pr14"}],
    "images": {"product_photo": None, "label_photo": None},
}

CSIRKEMELL = {
    "id": "0b34ae0b-1d7d-4c10-b61f-58599fd4641e",
    "name": "Csirkemell",
    "brand": "Lidl",
    "base_unit": "g",
    "serving_size": 650.0,
    "serving_label": None,
    "macros_per_100": {"calories": 121.0, "protein": 24.7, "fat": 0.5,
                       "carbs": 1.0, "fiber": 0.0, "sugar": 0.0, "sodium": 4.0},
    "prices": [{"amount": 1599.0, "currency": "HUF", "pack_size": 650.0,
               "source": "Lidl", "captured_at": "2026-10-10T10:22:27Z", "id": "pr28"}],
    "images": {"product_photo": None, "label_photo": None},
}

PARMESAN = {
    "id": "3184ba49-63a9-4678-a4a6-73b0beedf5ff",
    "name": "Parmezán",
    "brand": "Milbona",
    "base_unit": "g",
    "serving_size": 250.0,
    "serving_label": None,
    "macros_per_100": {"calories": 402.0, "protein": 32.4, "fat": 29.7,
                       "carbs": 0.0, "fiber": 0.0, "sugar": 0.0, "sodium": 16.0},
    "prices": [{"amount": 2999.0, "currency": "HUF", "pack_size": 250.0,
               "source": "Lidl", "captured_at": "2026-10-10T10:26:11Z", "id": "pr29"}],
    "images": {"product_photo": None, "label_photo": None},
}

FIXED_PRODUCTS = {p["id"]: p for p in (KOLBASZ, CSIRKEMELL, PARMESAN)}

#: the r1 recipe as priced on dev (5 portions), canonical pairing order
R1_ITEMS = [
    {"product_id": KOLBASZ["id"], "quantity": 50, "unit": "g",
     "name_override": "Csabai kolbász"},
    {"product_id": CSIRKEMELL["id"], "quantity": 650, "unit": "g",
     "name_override": "Csirkemell"},
    {"product_id": PARMESAN["id"], "quantity": 40, "unit": "g",
     "name_override": "Parmezán"},
]

#: acceptance figure: "40 g parmezán should be like 465 Ft" — engine-exact
#: value is 2999/250*40 = 479.84; band keeps the acceptance literal honest.
PARMESAN_40G_TOLERANCE = (400.0, 500.0)


def _corrupted(products):
    """The pre-fix dev shape: same amounts, pack_size forced to 1.0 —
    i.e. 'whole-pack price stored as price-per-gram'."""
    bad = copy.deepcopy(products)
    for p in bad.values():
        for price in p["prices"]:
            price["pack_size"] = 1.0
    return bad


# ---------------------------------------------------------------------------
# Engine level (pure, hermetic) — the acceptance figures
# ---------------------------------------------------------------------------

class TestCorrectedPricing:
    def test_parmesan_40g_is_about_465_ft(self):
        """Acceptance: parmezán 40 g ≈ 465 Ft (engine-exact 479.84 HUF)."""
        res = aggregate_macro_result(R1_ITEMS, products=FIXED_PRODUCTS)
        row = next(r for r in res["per_ingredient"]
                   if r["product_id"] == PARMESAN["id"])
        assert row["cost"] == pytest.approx(479.84, abs=0.005)
        lo, hi = PARMESAN_40G_TOLERANCE
        assert lo <= row["cost"] <= hi

    def test_recipe_total_corrected(self):
        """r1 total must be the corrected 2,338.64 HUF — not 1,224,260."""
        res = aggregate_macro_result(R1_ITEMS, products=FIXED_PRODUCTS)
        assert res["total_cost"] == {"amount": 2338.64, "currency": "HUF"}
        assert res["warnings"] == []

    def test_per_ingredient_costs(self):
        res = aggregate_macro_result(R1_ITEMS, products=FIXED_PRODUCTS)
        costs = {r["product_id"]: r["cost"] for r in res["per_ingredient"]}
        assert costs[KOLBASZ["id"]] == pytest.approx(259.8, abs=0.005)
        assert costs[CSIRKEMELL["id"]] == pytest.approx(1599.0, abs=0.005)
        assert costs[PARMESAN["id"]] == pytest.approx(479.84, abs=0.005)
        # invariant: total == sum of per-row costs (both already r2-rounded)
        assert res["total_cost"]["amount"] == pytest.approx(
            sum(r["cost"] for r in res["per_ingredient"]), abs=0.005)

    def test_portions_view_divides_totals_only(self):
        """Portions=5 view keeps total_cost intact (PORTIONS.md §7) and the
        corrected macro totals (per_portion == r2(totals/5))."""
        res = aggregate_macro_result(R1_ITEMS, products=FIXED_PRODUCTS,
                                     portions=5)
        assert res["portions"] == 5
        assert res["total_cost"] == {"amount": 2338.64, "currency": "HUF"}
        assert res["totals"]["calories"] == pytest.approx(1187.8, abs=0.05)
        assert res["per_portion"]["calories"] == pytest.approx(237.56, abs=0.01)


class TestOldInflatedBehaviourRejected:
    """The same fixtures with pack_size=1.0 reproduce the defect digit for
    digit (t_f56beded: live replay gave exactly 1,224,260). If any future
    change re-introduces per-gram pricing of pack amounts — via unit
    conversion, pairing, or cost roll-up — these assertions fail first."""

    def test_defect_reproduces_exactly_under_corrupted_fixture(self):
        res = aggregate_macro_result(R1_ITEMS, products=_corrupted(FIXED_PRODUCTS))
        # engine arithmetic itself: 2999/1 × 40 = 119,960 per-gram blow-up
        costs = {r["product_id"]: r["cost"] for r in res["per_ingredient"]}
        assert costs[PARMESAN["id"]] == pytest.approx(119960.0, abs=0.01)
        assert res["total_cost"]["amount"] == pytest.approx(1224260.0, abs=0.01)

    def test_corrected_fixture_must_not_match_inflated_totals(self):
        """Guard: corrected data and old behaviour are mutually exclusive.
        This test FAILS the moment dev-style pack_size=1.0 data (or an
        engine equivalent) comes back."""
        fixed = aggregate_macro_result(R1_ITEMS, products=FIXED_PRODUCTS)
        inflated = aggregate_macro_result(R1_ITEMS,
                                         products=_corrupted(FIXED_PRODUCTS))
        assert fixed["total_cost"]["amount"] != inflated["total_cost"]["amount"]
        assert fixed["total_cost"]["amount"] == 2338.64  # acceptance anchor
        assert inflated["total_cost"]["amount"] == pytest.approx(
            1224260.0, abs=0.01)


# ---------------------------------------------------------------------------
# Endpoint level — real /macros/count over a store seeded with dev docs
# ---------------------------------------------------------------------------

@pytest.fixture
def dev_like_service(tmp_path, monkeypatch):
    import app.inventory.media as media_mod
    mount_dir = None
    for r in _app_routes():
        if getattr(r, "path", "") == "/api/v1/media":
            from fastapi.staticfiles import StaticFiles
            inner = getattr(r, "app", r)
            if isinstance(inner, StaticFiles):
                mount_dir = str(inner.directory)
            break
    assert mount_dir is not None
    monkeypatch.setattr(media_mod, "media_root", lambda: mount_dir)
    store = ProductStore(path=str(tmp_path / "data" / "products.json"))
    for doc in FIXED_PRODUCTS.values():
        store.upsert(copy.deepcopy(doc))
    return InventoryService(store=store)


def _app_routes():
    from app.main import app
    return app.routes


@pytest.fixture
def dev_client(dev_like_service, monkeypatch):
    from app.main import app
    import app.inventory.routes as routes_mod
    monkeypatch.setattr(routes_mod, "svc", dev_like_service)
    return TestClient(app)


class TestEndpointRegression:
    def test_r1_body_returns_corrected_costs(self, dev_client):
        r = dev_client.post("/api/v1/inventory/macros/count",
                            json={"items": copy.deepcopy(R1_ITEMS),
                                  "portions": 5})
        assert r.status_code == 200, r.text
        b = r.json()
        assert b["total_cost"] == {"amount": 2338.64, "currency": "HUF"}
        by_id = {row["product_id"]: row for row in b["per_ingredient"]}
        assert by_id[PARMESAN["id"]]["cost"] == pytest.approx(479.84, abs=0.005)
        assert by_id[KOLBASZ["id"]]["cost"] == pytest.approx(259.8, abs=0.005)
        assert by_id[CSIRKEMELL["id"]]["cost"] == pytest.approx(1599.0, abs=0.005)

    def test_unit_conversion_gram_quantities_survive_pairing(self, dev_client):
        """Pairing-time unit conversion regression: 40 g on a 250 g pack is
        16 % of the pack, NOT 40 whole packs — the ~465 Ft acceptance case."""
        r = dev_client.post("/api/v1/inventory/macros/count",
                            json={"items": [{"product_id": PARMESAN["id"],
                                             "quantity": 40, "unit": "g"}]})
        assert r.status_code == 200, r.text
        b = r.json()
        assert b["total_cost"] == {"amount": 479.84, "currency": "HUF"}


# ---------------------------------------------------------------------------
# Live dev smoke (skipped unless SOLIN_LIVE_TESTS=1 — needs network)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(os.environ.get("SOLIN_LIVE_TESTS") != "1",
                    reason="set SOLIN_LIVE_TESTS=1 to replay against solin-dev")
class TestLiveDevSmoke:
    BASE = "https://solin-dev.ateszito.com/api/v1/inventory"

    def _post(self, path, body):
        import urllib.request
        req = urllib.request.Request(
            self.BASE + path, data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())

    def test_live_dev_matches_corrected_figures(self):
        b = self._post("/macros/count", {"items": copy.deepcopy(R1_ITEMS),
                                         "portions": 5})
        assert b["total_cost"] == {"amount": 2338.64, "currency": "HUF"}
        assert b.get("warnings") == []
