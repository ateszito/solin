"""Custom "egyéb" ingredient items — calc/data-layer tests (spec §11, task t_5721a2dd).

Pins:
  * §11.3 totals math — custom macros join `totals` as entered (2 dp),
    `cost` = r2(price), cross-currency custom excluded + warned, never
    silently summed (the "Σ already-rounded rows" rule);
  * §11.4 contract — items[] discriminator `type:"custom"`, response rows
    carry `source:"custom"`; invalid customs → 400 CUSTOM_ITEM_INVALID
    BEFORE aggregation (mixed batch too); zero-valid-items batch → 400
    VALIDATION_ERROR, never a 200-of-zeros;
  * A3 regression — a paired-only batch stays byte-for-byte identical
    (fixture checks vs tests/fixtures/PORTIONS.json);
  * A5 deletion semantics at the data layer — dropping the custom from
    items[] restores the paired-only result exactly.

Run:  .venv/bin/python -m pytest tests/test_custom_items_unit.py -q
"""
import copy
import json
import os

import pytest

from app.inventory.macros import aggregate_macro_result
from app.inventory.validation import InventoryError

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def fx():
    """Fresh deep-copied §5.2/§5.3 PORTIONS.json fixture document."""
    with open(os.path.join(FIXTURES, "PORTIONS.json"), encoding="utf-8") as fh:
        return json.load(fh)


def fxin():
    """Just the engine_inputs (fresh deep copy) of the same fixture."""
    return copy.deepcopy(fx()["engine_inputs"])


#: §11.6 A2 fixture-2 custom row, entered VERBATIM (totals for the 5 g).
A2_CUSTOM = {
    "type": "custom", "name": "Chilipehely", "quantity": 5, "unit": "g",
    "price": 0.35, "currency": "USD",
    "macros": {"calories": 15.90, "protein": 0.67, "fat": 0.87, "carbs": 2.83,
               "fiber": 1.36, "sugar": 2.10, "sodium": 1.50},
}


def run(items, products=None, portions=1):
    return aggregate_macro_result(items, products=products, portions=portions)


# ---- A2: full worked fixture through the real engine -----------------------

def test_a2_usd_fixture_totals_and_costs():
    f = fx()
    items = f["engine_inputs"]["ingredients"] + [copy.deepcopy(A2_CUSTOM)]
    r = run(items, f["engine_inputs"]["products"], portions=4)

    # A2 pinned totals — sum-of-rounded §4.2 including the custom row.
    assert r["totals"] == {"calories": 783.30, "protein": 70.57, "fat": 18.97,
                           "carbs": 81.63, "fiber": 3.46, "sugar": 2.20,
                           "sodium": 151.50}
    # Custom cost == base_currency → JOINS (1.50+0.55+0.35).
    assert r["total_cost"] == {"amount": 2.40, "currency": "USD"}
    # A2 pinned per-portion split (HALF_UP 2 dp) over the NEW totals.
    assert r["per_portion"] == {"calories": 195.83, "protein": 17.64,
                                "fat": 4.74, "carbs": 20.41, "fiber": 0.87,
                                "sugar": 0.55, "sodium": 37.88}
    assert r["per_portion_cost"] == {"amount": 0.60, "currency": "USD"}


def test_a2_custom_row_shape_and_order():
    f = fx()
    items = f["engine_inputs"]["ingredients"] + [copy.deepcopy(A2_CUSTOM)]
    r = run(items, f["engine_inputs"]["products"], portions=4)
    row = r["per_ingredient"][3]          # AFTER all paired rows (A2 index)
    assert row["source"] == "custom" and row["product_id"] is None
    assert row["name"] == "Chilipehely"
    assert row["quantity"] == 5 and row["unit"] == "g"
    assert row["cost"] == 0.35             # r2(price), displayed even here
    assert row["macros"]["calories"] == 15.90    # verbatim, not re-scaled
    assert row["warnings"] == []


def test_a2_huf_repeat_custom_excluded_and_warned():
    """A2 currency-split repeat: 1.20 HUF custom ≠ USD base → EXCLUDED,
    per-row + top-level CROSS_CURRENCY_EXCLUDED, total_cost stays 2.05 USD."""
    f = fx()
    ccy_custom = copy.deepcopy(A2_CUSTOM)
    ccy_custom.update(price=1.20, currency="HUF")
    r = run(f["engine_inputs"]["ingredients"] + [ccy_custom], f["engine_inputs"]["products"], portions=1)
    assert r["total_cost"] == {"amount": 2.05, "currency": "USD"}
    row = r["per_ingredient"][3]
    assert "CROSS_CURRENCY_EXCLUDED" in row["warnings"]
    assert {"code": "CROSS_CURRENCY_EXCLUDED", "product_id": "Chilipehely"} \
        in r["warnings"]
    # Excluded cost still DISPLAYS on the row (nothing is hidden/clamped).
    assert row["cost"] == 1.20
    # macros are NOT tied to the currency rule — they still count.
    assert r["totals"]["sodium"] == 151.50


def test_custom_only_batch_sets_base_currency():
    """§11.3: a custom-only batch bases on the custom currency (or HUF)."""
    r = run([copy.deepcopy(A2_CUSTOM)], products={})
    assert r["total_cost"] == {"amount": 0.35, "currency": "USD"}
    # currency omitted → HUF default (R2 default + "never USD" note)
    r2 = run([{"type": "custom", "name": "Só", "price": 500}], products={})
    assert r2["total_cost"] == {"amount": 500, "currency": "HUF"}


# ---- A3: paired-only regression (fixture-pinned, not copied constants) ----

def test_a3_paired_only_unchanged():
    f = fx()
    r = run(f["engine_inputs"]["ingredients"], f["engine_inputs"]["products"], portions=1)
    assert r["totals"] == f["expected_totals"]
    assert r["total_cost"] == f["expected_total_cost"]
    assert r["warnings"] == f["expected_warnings"]


def test_removal_restores_paired_only_result():
    """A5 (data layer): deleting the custom row reproduces the paired-only
    result EXACTLY — totals/cost/warnings byte-for-byte."""
    f = fx()
    with_c = run(f["engine_inputs"]["ingredients"] + [copy.deepcopy(A2_CUSTOM)], f["engine_inputs"]["products"])
    without = run(f["engine_inputs"]["ingredients"], f["engine_inputs"]["products"])
    assert with_c["totals"] != without["totals"]        # custom did count
    # Re-running the same batch WITHOUT the row equals the pre-change run:
    assert without["totals"] == f["expected_totals"]
    assert without["total_cost"] == f["expected_total_cost"]
    assert len(without["per_ingredient"]) == 3
    assert all("source" not in row for row in without["per_ingredient"])


# ---- invalid values → rejected BEFORE aggregation, never clamped ----------

BAD_CUSTOM_CASES = [
    ({"type": "custom", "name": "", "price": 1}, ["name"], "empty name"),
    ({"type": "custom", "name": "x" * 81, "price": 1}, ["name"], "name > 80"),
    ({"type": "custom", "name": "N", "quantity": 0}, ["quantity"], "quantity 0"),
    ({"type": "custom", "name": "N", "quantity": -5}, ["quantity"], "quantity <"),
    ({"type": "custom", "name": "N", "price": 0}, ["price"], "price 0"),
    ({"type": "custom", "name": "N", "price": -3}, ["price"], "price negative"),
    ({"type": "custom", "name": "N", "price": 1, "currency": "Huf"},
     ["currency"], "lowercase ccy"),
    ({"type": "custom", "name": "N", "price": 1, "currency": "FORINT"},
     ["currency"], "6-letter ccy"),
    ({"type": "custom", "name": "N", "unit": "evokanal-with-x" * 2},
     ["unit"], "unit > 10"),
    ({"type": "custom", "name": "N", "macros": {"calories": 12345}},
     ["calories"], "macro > 9999"),
    ({"type": "custom", "name": "N", "macros": {"protein": -1}},
     ["protein"], "negative macro"),
    ({"type": "custom", "name": "N", "macros": {"sodium": 1.234}},
     ["sodium"], "macro > 2 dp"),
    ({"type": "custom", "name": "N", "macros": {"sugar": "abc"}},
     ["sugar"], "macro non-numeric"),
    ({"type": "custom", "name": "N", "price": -1, "macros": {"fat": 2, "sodium": 3.333}},
     ["price", "sodium"], "mixed bad fields"),
]


@pytest.mark.parametrize("item,fields,label", BAD_CUSTOM_CASES,
                         ids=[c[2] for c in BAD_CUSTOM_CASES])
def test_bad_custom_raises_before_aggregation(item, fields, label):
    # pure refusal (custom-only batch)…
    with pytest.raises(InventoryError) as ei:
        run([item], products={})
    exc = ei.value
    assert exc.status_code == 400 and exc.code == "CUSTOM_ITEM_INVALID"
    # exact bad-field list, encounter order, deduplicated across rows
    assert exc.fields == fields
    # …and the SAME refusal inside a mixed batch (no silent exclusion, R3)
    f = fx()
    with pytest.raises(InventoryError) as ei2:
        run(f["engine_inputs"]["ingredients"] + [dict(item)], f["engine_inputs"]["products"])
    assert ei2.value.code == "CUSTOM_ITEM_INVALID"


def test_empty_customs_refused_not_counted_as_zeros():
    """Zero-valid-items (§3.6 count guard): a batch whose only items are
    empty custom rows has NOTHING computable → VALIDATION_ERROR, never a
    200-of-zeros (no silent 0-macro result)."""
    with pytest.raises(InventoryError) as ei:
        run([{"type": "custom", "name": "Valami"}], products={})   # name only
    assert ei.value.code == "VALIDATION_ERROR"
    # empty macros (all-zero) count as empty too
    with pytest.raises(InventoryError) as ei2:
        run([{"type": "custom", "name": "Nulla",
              "macros": {k: 0 for k in
                        ("calories", "protein", "fat", "carbs",
                         "fiber", "sugar", "sodium")}}], products={})
    assert ei2.value.code == "VALIDATION_ERROR"
    # …but paired + empty-custom batch still aggregates the PAIRED rows
    # (custom-only empties are refused only when nothing computable exists)
    f = fx()
    r = run(f["engine_inputs"]["ingredients"] + [{"type": "custom", "name": "Valami"}],
            f["engine_inputs"]["products"])
    assert r["totals"] == f["expected_totals"]


def test_discriminator_other_shapes_stay_paired():
    """§11.4 discriminator = type/source marker; a dict WITHOUT either stays
    on the paired path (fixes the earlier no-product_id misread)."""
    r = run([{"product_id": "ghost", "quantity": 10, "unit": "g"}],
            products={})
    row = r["per_ingredient"][0]
    assert "source" not in row
    assert row["warnings"] == ["PRODUCT_NOT_FOUND"]
    # explicit type paired stays paired too
    r2 = run([{"type": "paired", "product_id": "ghost"}], products={})
    assert "source" not in r2["per_ingredient"][0]
