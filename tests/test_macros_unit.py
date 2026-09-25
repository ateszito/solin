"""Unit tests for the real-macro aggregation engine (contract §4, §4.4).

The engine is pure over an injectable ``products`` mapping, so these tests are
hermetic: no store file, no I/O — just the canonical seed catalog (P1–P4)
from :data:`app.inventory.seed_data.seed_products` and hand-computed values
per the §5.3 worked example (C2 ROUND_HALF_UP, 2 dp).

Covers the task's edge-case list:
  * missing product id   → zero row + PRODUCT_NOT_FOUND warning, no exception
  * unit mismatch g/ml   → UNITS_INCOMPATIBLE
  * product no prices    → cost null, total_cost falls back / null
  * product zero cal     → totals still correct (p4)
  * overflow / huge qty  → Decimal has no overflow; values stay finite
  * zero / negative qty  → VALIDATION_ERROR row, zero macros
  * cross-currency       → first-currency-wins + CROSS_CURRENCY_EXCLUDED
"""
import pytest

from app.inventory.macros import (
    ZERO_BLOCK,
    aggregate_macro_result,
    count_real_macros,
    macro_count,
)
from app.inventory.seed_data import seed_products


PRODS = {p["id"]: p for p in seed_products()}

CANONICAL_INGREDIENTS = [
    {"product_id": "p1", "quantity": 200, "unit": "g"},
    {"product_id": "p2", "quantity": 100, "unit": "g"},
    {"product_id": "p3", "quantity": 10, "unit": "ml"},
]


# ---------------------------------------------------------------------------
# §5.3 canonical worked example — the acceptance "3 ingredients match
# hand-calculated values" criterion
# ---------------------------------------------------------------------------

def test_canonical_totals_match_contract_5_3():
    res = aggregate_macro_result(CANONICAL_INGREDIENTS, products=PRODS)
    expected = {
        "calories": 767.40, "protein": 69.90, "fat": 18.10,
        "carbs": 78.80, "fiber": 2.10, "sugar": 0.10, "sodium": 150.00,
    }
    for k, v in expected.items():
        assert abs(res["totals"][k] - v) <= 0.1, (k, res["totals"][k], v)


def test_canonical_total_cost_2_05_usd():
    res = aggregate_macro_result(CANONICAL_INGREDIENTS, products=PRODS)
    assert res["total_cost"] == {"amount": 2.05, "currency": "USD"}


def test_canonical_per_ingredient_rows():
    res = aggregate_macro_result(CANONICAL_INGREDIENTS, products=PRODS)
    rows = res["per_ingredient"]
    assert [r["product_id"] for r in rows] == ["p1", "p2", "p3"]
    # p1: 2× per-100 block
    assert rows[0]["macros"]["calories"] == 330.00
    assert rows[0]["macros"]["protein"] == 62.00
    assert rows[0]["cost"] == 1.50
    # p2: 1× per-100 block
    assert rows[1]["macros"]["calories"] == 349.00
    assert rows[1]["cost"] == 0.55
    # p3: 0.1× per-100 block, no price
    assert rows[2]["macros"]["fat"] == 10.00
    assert rows[2]["cost"] is None
    # name resolved from product (no override given)
    assert rows[0]["name"] == "Chicken breast"


def test_canonical_cross_currency_warning_once_per_product():
    res = aggregate_macro_result(CANONICAL_INGREDIENTS, products=PRODS)
    codes = {(w["code"], w["product_id"]) for w in res["warnings"]}
    assert ("CROSS_CURRENCY_EXCLUDED", "p1") in codes
    # exactly one warning per affected product — no duplicates
    assert len(res["warnings"]) == len(codes)


def test_name_override_is_display_only():
    res = aggregate_macro_result(
        [{"product_id": "p1", "quantity": 100, "unit": "g",
          "name_override": "My Chicken"}], products=PRODS)
    row = res["per_ingredient"][0]
    assert row["name"] == "My Chicken"
    # macro math is unaffected by the display name
    assert row["macros"]["calories"] == 165.0


# ---------------------------------------------------------------------------
# Edge case: missing product (acceptance criterion #2: 200 + warning, no 500)
# ---------------------------------------------------------------------------

def test_missing_product_is_zero_row_plus_warning_not_exception():
    res = aggregate_macro_result(
        [{"product_id": "no-such-product", "quantity": 10, "unit": "g"}],
        products=PRODS)
    row = res["per_ingredient"][0]
    assert row["product_id"] == "no-such-product"
    assert row["macros"] == ZERO_BLOCK
    assert row["cost"] is None
    assert "PRODUCT_NOT_FOUND" in row["warnings"]
    assert ("PRODUCT_NOT_FOUND", "no-such-product") in {
        (w["code"], w["product_id"]) for w in res["warnings"]}
    # resolved ingredients still sum; the phantom one contributes nothing
    res2 = aggregate_macro_result(
        [{"product_id": "p1", "quantity": 100, "unit": "g"},
         {"product_id": "nope", "quantity": 10, "unit": "g"}], products=PRODS)
    assert res2["totals"]["calories"] == 165.0
    assert res2["total_cost"] == {"amount": 0.75, "currency": "USD"}


# ---------------------------------------------------------------------------
# Edge case: unit mismatch (acceptance criterion: g vs ml on wrong family)
# ---------------------------------------------------------------------------

def test_units_incompatible_g_product_given_ml():
    res = aggregate_macro_result(
        [{"product_id": "p1", "quantity": 250, "unit": "ml"}], products=PRODS)
    row = res["per_ingredient"][0]
    assert "UNITS_INCOMPATIBLE" in row["warnings"]
    assert row["macros"] == ZERO_BLOCK
    assert row["cost"] is None
    assert res["total_cost"] is None


def test_units_incompatible_pcs_given_for_g_product():
    res = aggregate_macro_result(
        [{"product_id": "p1", "quantity": 3, "unit": "pcs"}], products=PRODS)
    assert "UNITS_INCOMPATIBLE" in res["per_ingredient"][0]["warnings"]


def test_same_family_conversion_is_applied():
    # 1 kg on a g-basis product → 1000 g → factor 10
    res = aggregate_macro_result(
        [{"product_id": "p2", "quantity": 1, "unit": "kg"}], products=PRODS)
    assert res["per_ingredient"][0]["macros"]["carbs"] == 788.0
    # 1 l on an ml-basis product → 1000 ml → factor 10
    res2 = aggregate_macro_result(
        [{"product_id": "p3", "quantity": 1, "unit": "l"}], products=PRODS)
    assert res2["per_ingredient"][0]["macros"]["fat"] == 1000.0


# ---------------------------------------------------------------------------
# Edge case: product with no prices → cost null (acceptance criterion #3)
# ---------------------------------------------------------------------------

def test_product_without_prices_has_null_cost_but_counts_macros():
    res = aggregate_macro_result(
        [{"product_id": "p3", "quantity": 50, "unit": "ml"}], products=PRODS)
    row = res["per_ingredient"][0]
    assert row["cost"] is None
    assert row["macros"]["calories"] == 442.0  # 0.5 × 884
    assert row["macros"]["fat"] == 50.0
    assert res["total_cost"] is None


# ---------------------------------------------------------------------------
# Edge case: zero-calorie product (p4) still flows through totals
# ---------------------------------------------------------------------------

def test_zero_calorie_product_kept_in_totals():
    res = aggregate_macro_result(
        [{"product_id": "p4", "quantity": 330, "unit": "ml"},
         {"product_id": "p2", "quantity": 100, "unit": "g"}],
        products=PRODS)
    assert res["totals"]["calories"] == 349.0
    # p4 carries sodium 10/100 → 330 ml adds 33.0
    assert res["totals"]["sodium"] == pytest.approx(35.0, abs=0.11)
    assert res["total_cost"] == {"amount": 0.55, "currency": "USD"}


# ---------------------------------------------------------------------------
# Overflow: huge quantities must stay finite (Decimal, no float overflow)
# ---------------------------------------------------------------------------

def test_very_large_quantity_is_finite():
    res = aggregate_macro_result(
        [{"product_id": "p2", "quantity": 10**12, "unit": "g"}], products=PRODS)
    row = res["per_ingredient"][0]
    cal = row["macros"]["calories"]
    assert cal == 349 * 10**10
    assert cal < float("inf")
    assert res["totals"]["calories"] == cal


# ---------------------------------------------------------------------------
# Invalid quantities (zero / negative / non-numeric) → zero row + warning
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("qty", [0, -10, "forty", None])
def test_invalid_quantity_is_zero_row_plus_validation_warning(qty):
    res = aggregate_macro_result(
        [{"product_id": "p1", "quantity": qty, "unit": "g"}], products=PRODS)
    row = res["per_ingredient"][0]
    assert "VALIDATION_ERROR" in row["warnings"]
    assert row["macros"] == ZERO_BLOCK
    assert res["total_cost"] is None


def test_empty_ingredients_list_is_all_zero():
    res = aggregate_macro_result([], products=PRODS)
    assert res["totals"] == {k: 0.0 for k in res["totals"]}
    assert res["per_ingredient"] == []
    assert res["total_cost"] is None
    assert res["warnings"] == []


def test_non_list_ingredients_raises_typeerror():
    with pytest.raises(TypeError):
        aggregate_macro_result("p1g", products=PRODS)


# ---------------------------------------------------------------------------
# Cross-currency selection (contract §8: first-currency-wins)
# ---------------------------------------------------------------------------

def test_first_currency_wins_not_globally_cheapest():
    # p1: USD 2.99/400g first, then EUR 3.49/500g (cheaper per-gram).
    # Canonical §5.3: USD wins (1.50) and EUR is excluded + warned.
    res = aggregate_macro_result(
        [{"product_id": "p1", "quantity": 200, "unit": "g"}], products=PRODS)
    assert res["per_ingredient"][0]["cost"] == 1.50
    assert res["total_cost"]["currency"] == "USD"
    assert any(w["code"] == "CROSS_CURRENCY_EXCLUDED" and w["product_id"] == "p1"
               for w in res["warnings"])


# ---------------------------------------------------------------------------
# Public API surface (contract §3.6 + task body)
# ---------------------------------------------------------------------------

def test_macro_count_and_count_real_macros_are_the_same_function():
    assert count_real_macros is macro_count


def test_macro_count_resolves_default_store(monkeypatch):
    # §3.6: macro_count(ingredients) must read the default inventory store.
    # Stub ProductStore.load so no real products.json is touched, and prove
    # the default path (products=None) works end-to-end.
    import app.inventory.store as store_mod

    class FakeStore:
        def load(self):
            return {p["id"]: p for p in seed_products()}

    monkeypatch.setattr(store_mod, "ProductStore", lambda: FakeStore())
    res = macro_count(CANONICAL_INGREDIENTS)
    assert abs(res["totals"]["calories"] - 767.40) <= 0.1
    assert res["total_cost"] == {"amount": 2.05, "currency": "USD"}
