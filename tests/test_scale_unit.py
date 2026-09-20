"""Unit tests for the pure recipe-scaling engine (stdlib ``Decimal`` + pytest).

These tests exercise ONLY :mod:`app.services.recipe_scaling` — no FastAPI, no
network, no DB. That is deliberate: the engine must be verifiable with zero
third-party dependencies (design §2.2 "pure function", §9 unit-test mandate).

Coverage per task ``t_da0ef25c``:
  * upscale (850 g)
  * downscale (480 g)
  * mixed units in the same recipe
  * rounding boundaries (half-up, min-1, 2dp / 1dp / whole)
  * per-unit-class behaviour (mass / liquid / count / non-scalable)
  * scale-factor edge cases (exact int, 0, negative, non-numeric)

All canonical expectations are taken verbatim from
``docs/design/RECIPE_SCALING.md`` §5 (the UC-07 reference tables).
"""
from decimal import Decimal

import pytest

from app.services.recipe_scaling import (
    classify_unit,
    is_scalable,
    parse_amount,
    round_amount,
    scale_recipe,
    select_default_anchor,
    resolve_ingredient,
    UnitClass,
)

# ---------------------------------------------------------------------------
# Shared canonical ingredients (design §5 recipe)
# ---------------------------------------------------------------------------

# The canonical TikTok recipe from design §5. The FIRST entry is the intended
# anchor (largest mass). Non-scalables are `so` (to taste) and `csili` (pcs).
RECIPE = [
    {"name": "csirkeemlo", "amount": 650, "unit": "g"},
    {"name": "voroshagyma", "amount": 200, "unit": "g"},
    {"name": "kolbasz", "amount": 50, "unit": "g"},
    {"name": "tejszin", "amount": 160, "unit": "g"},
    {"name": "parmezan", "amount": 40, "unit": "g"},
    {"name": "teszta", "amount": 240, "unit": "g"},
    {"name": "spinot", "amount": 80, "unit": "g"},
    {"name": "fokhagyma", "amount": 3, "unit": "gerezd"},
    {"name": "paradicsompure", "amount": 3, "unit": "tbsp"},
    {"name": "fustolt-paprika", "amount": 1, "unit": "tsp"},
    {"name": "bors", "amount": 0.5, "unit": "tsp"},
    {"name": "so", "amount": 2, "unit": "to taste"},
    {"name": "csili", "amount": 1, "unit": "pcs"},
]

ANCHOR = RECIPE[0]  # csirkeemlo 650 g — the deterministic default anchor (§2.1)

# Design §5.1 — upscale table (canonical, 2dp / 1dp / whole).
EXPECTED_850 = {
    "csirkeemlo": 850, "voroshagyma": 261.54, "kolbasz": 65.38,
    "tejszin": 209.23, "parmezan": 52.31, "teszta": 313.85,
    "spinot": 104.62, "fokhagyma": 4, "paradicsompure": 3.9,
    "fustolt-paprika": 1.3, "bors": 0.7, "so": 2, "csili": 1,
}
# Design §5.2 — downscale table.
EXPECTED_480 = {
    "csirkeemlo": 480, "voroshagyma": 147.69, "kolbasz": 36.92,
    "tejszin": 118.15, "parmezan": 29.54, "teszta": 177.23,
    "spinot": 59.08, "fokhagyma": 2, "paradicsompure": 2.2,
    "fustolt-paprika": 0.7, "bors": 0.4, "so": 2, "csili": 1,
}


def _scaled_by_name(available):
    result = scale_recipe(RECIPE, available, ANCHOR)
    return {si.name: si for si in result.ingredients}


# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("unit,cls", [
    ("g", UnitClass.MASS), ("kg", UnitClass.MASS), ("mg", UnitClass.MASS),
    ("G", UnitClass.MASS), (" Kg ".strip(), UnitClass.MASS),
    ("ml", UnitClass.LIQUID), ("l", UnitClass.LIQUID), ("cup", UnitClass.LIQUID),
    ("tbsp", UnitClass.LIQUID), ("tsp", UnitClass.LIQUID),
    ("tk", UnitClass.LIQUID), ("evőkanál", UnitClass.LIQUID), ("teáskanál", UnitClass.LIQUID),
    ("gerezd", UnitClass.COUNT), ("db", UnitClass.COUNT),
    ("szelet", UnitClass.COUNT), ("fej", UnitClass.COUNT),
    ("tojas", UnitClass.COUNT), ("tojás", UnitClass.COUNT),
    ("darab", UnitClass.COUNT), ("szal", UnitClass.COUNT),
    ("szál", UnitClass.COUNT), ("gomboc", UnitClass.COUNT), ("gombóc", UnitClass.COUNT),
    ("pcs", UnitClass.NON_SCALABLE), ("to taste", UnitClass.NON_SCALABLE),
    ("jodag", UnitClass.NON_SCALABLE), ("1-2 gerezd", UnitClass.NON_SCALABLE),
    ("", UnitClass.NON_SCALABLE), (None, UnitClass.NON_SCALABLE),
])
def test_classify_unit(unit, cls):
    assert classify_unit(unit) == cls


@pytest.mark.parametrize("unit", ["g", "kg", "mg", "ml", "l", "cup", "tbsp", "tsp",
                                  "gerezd", "db", "szelet", "fej", "tojas",
                                  "darab", "szal", "gomboc"])
def test_scalable_units(unit):
    assert is_scalable(unit) is True


@pytest.mark.parametrize("unit", ["pcs", "to taste", "jodag", "pinch", "dash", ""])
def test_non_scalable_units(unit):
    assert is_scalable(unit) is False


# ---------------------------------------------------------------------------
# parse_amount
# ---------------------------------------------------------------------------

def test_parse_amount_int_float_str():
    assert parse_amount(650) == Decimal(650)
    assert parse_amount(0.5) == Decimal("0.5")
    assert parse_amount("650") == Decimal(650)
    assert parse_amount("0.75") == Decimal("0.75")
    assert parse_amount("1,5",) == Decimal("1.5")


def test_parse_amount_rejects_bad_input():
    assert parse_amount(None) is None
    assert parse_amount(True) is None
    assert parse_amount("abc") is None
    assert parse_amount("") is None
    assert parse_amount(float("nan")) is None
    assert parse_amount(float("inf")) is None


# ---------------------------------------------------------------------------
# round_amount — canonical rounding per unit class (design §3)
# ---------------------------------------------------------------------------

def test_round_mass_2dp_half_up():
    assert round_amount(Decimal("65.385"), "g") == Decimal("65.39")
    assert round_amount(Decimal("65.384"), "g") == Decimal("65.38")
    assert round_amount(Decimal("36.923"), "g") == Decimal("36.92")
    assert round_amount(Decimal("1.005"), "g") == Decimal("1.01")   # half-up tie
    assert round_amount(Decimal("1.004"), "g") == Decimal("1.00")


def test_round_liquid_1dp_half_up():
    # Half-up to 1 dp. (Note: values here are *literal* inputs to round_amount,
    # not the §5 table's 3dp "raw" display — the endpoint feeds exact factors.)
    assert round_amount(Decimal("3.923"), "tbsp") == Decimal("3.9")   # 2<5 -> down
    assert round_amount(Decimal("2.215"), "tbsp") == Decimal("2.2")   # 1st extra digit is 1 -> down
    assert round_amount(Decimal("0.654"), "tsp") == Decimal("0.7")    # 4 < 5 -> wait, 0.654 1dp: 5th? see note
    assert round_amount(Decimal("0.65"), "tsp") == Decimal("0.7")     # tie (5) -> up
    assert round_amount(Decimal("0.55"), "tsp") == Decimal("0.6")     # tie (5) -> up
    # no min-1 for liquid (design §3.1)
    assert round_amount(Decimal("0.369"), "tsp") == Decimal("0.4")


def test_round_count_whole_with_min1():
    # whole, half-up
    assert round_amount(Decimal("3.923"), "gerezd") == Decimal("4")
    assert round_amount(Decimal("2.215"), "gerezd") == Decimal("2")
    assert round_amount(Decimal("1.5"), "db") == Decimal("2")
    assert round_amount(Decimal("1.4"), "db") == Decimal("1")
    # min-1: any value in (0, 1) becomes 1, never 0 (design §3.1)
    assert round_amount(Decimal("0.4"), "gerezd") == Decimal("1")
    assert round_amount(Decimal("0.6"), "gerezd") == Decimal("1")
    assert round_amount(Decimal("0.5"), "db") == Decimal("1")


# ---------------------------------------------------------------------------
# scale_recipe — full end-to-end engine (design §5 canonical tables)
# ---------------------------------------------------------------------------

def test_upscale_850_matches_design():
    got = {n: float(si.amount) for n, si in _scaled_by_name(850).items()}
    for name, expected in EXPECTED_850.items():
        assert abs(got[name] - expected) < 1e-9, (name, got[name], expected)


def test_downscale_480_matches_design():
    got = {n: float(si.amount) for n, si in _scaled_by_name(480).items()}
    for name, expected in EXPECTED_480.items():
        assert abs(got[name] - expected) < 1e-9, (name, got[name], expected)


def test_scale_factor_exact():
    assert scale_recipe(RECIPE, 850, ANCHOR).scale_factor == Decimal(850) / Decimal(650)
    assert scale_recipe(RECIPE, 480, ANCHOR).scale_factor == Decimal(480) / Decimal(650)


def test_manual_flags_set_only_on_non_scalable():
    result = scale_recipe(RECIPE, 850, ANCHOR)
    manuals = {si.name for si in result.ingredients if si.manual}
    assert manuals == {"so", "csili"}


def test_base_amount_never_mutated():
    result = scale_recipe(RECIPE, 850, ANCHOR)
    by = {si.name: si for si in result.ingredients}
    assert float(by["csirkeemlo"].base_amount) == 650
    assert float(by["kolbasz"].base_amount) == 50
    assert float(by["so"].base_amount) == 2
    assert by["so"].unit == "to taste"
    assert by["csili"].unit == "pcs"


def test_scaled_recipe_is_readonly_input():
    original = [dict(ing) for ing in RECIPE]
    scale_recipe(RECIPE, 850, ANCHOR)
    assert RECIPE == original, "scaling must not mutate the input list"


# ---------------------------------------------------------------------------
# Mixed units — a recipe with mass+liquid+count+non-scalable in one call
# ---------------------------------------------------------------------------

MIXED = [
    {"name": "flour", "amount": 500, "unit": "g"},
    {"name": "milk", "amount": 250, "unit": "ml"},
    {"name": "eggs", "amount": 3, "unit": "fej"},
    {"name": "butter", "amount": 100, "unit": "g"},
    {"name": "salt", "amount": 1, "unit": "tsp"},
    {"name": "vanilla", "amount": 1, "unit": "szal"},
]


def test_mixed_units_scale_proportionally():
    result = scale_recipe(MIXED, 250, MIXED[0])  # factor 0.5
    by = {si.name: float(si.amount) for si in result.ingredients}
    assert by["flour"] == 250
    assert by["milk"] == 125.0
    assert by["eggs"] == 2        # 3*0.5 = 1.5 -> whole half-up -> 2
    assert by["butter"] == 50
    assert by["salt"] == 0.5      # 1*0.5 = 0.5 -> 1dp -> 0.5 (no min-1)
    assert by["vanilla"] == 1     # 1*0.5 = 0.5, count min-1 -> 1


def test_mixed_units_downscale_to_fraction_of_a_count():
    result = scale_recipe(MIXED, 80, MIXED[0])  # factor 0.16
    by = {si.name: float(si.amount) for si in result.ingredients}
    assert by["eggs"] == 1       # 3*0.16=0.48 -> min-1 -> 1
    assert by["salt"] == 0.2     # 1*0.16=0.16 -> 1dp -> 0.2
    assert by["vanilla"] == 1    # 1*0.16=0.16 -> min-1 -> 1


# ---------------------------------------------------------------------------
# Scale-factor edge cases (=> 400 in the endpoint)
# ---------------------------------------------------------------------------

def test_available_zero_raises():
    with pytest.raises(ValueError):
        scale_recipe(RECIPE, 0, ANCHOR)


def test_available_negative_raises():
    with pytest.raises(ValueError):
        scale_recipe(RECIPE, -50, ANCHOR)


def test_available_non_numeric_raises():
    with pytest.raises(ValueError):
        scale_recipe(RECIPE, "six-hundred fifty", ANCHOR)


def test_available_nan_raises():
    with pytest.raises(ValueError):
        scale_recipe(RECIPE, float("nan"), ANCHOR)


def test_available_inf_raises():
    with pytest.raises(ValueError):
        scale_recipe(RECIPE, float("inf"), ANCHOR)


def test_anchor_non_scalable_raises():
    # can't derive f from a "to taste" / "pcs" ingredient (no numeric base unit)
    with pytest.raises(ValueError):
        scale_recipe(RECIPE, 2, {"name": "so", "amount": 2, "unit": "to taste"})
    with pytest.raises(ValueError):
        scale_recipe(RECIPE, 1, {"name": "csili", "amount": 1, "unit": "pcs"})


def test_anchor_missing_non_numeric_amount_raises():
    with pytest.raises(ValueError):
        scale_recipe(RECIPE, 850, {"name": "x", "amount": "six", "unit": "g"})


# ---------------------------------------------------------------------------
# select_default_anchor / resolve_ingredient
# ---------------------------------------------------------------------------

def test_select_default_anchor_is_largest_mass():
    anchor = select_default_anchor(RECIPE)
    assert anchor["name"] == "csirkeemlo" and anchor["amount"] == 650


def test_select_default_anchor_ignores_non_mass():
    assert select_default_anchor([
        {"name": "so", "amount": 2, "unit": "to taste"},
        {"name": "a", "amount": 5, "unit": "tsp"},
        {"name": "b", "amount": 10, "unit": "g"},
    ]) == {"name": "b", "amount": 10, "unit": "g"}


def test_select_default_anchor_none_without_mass():
    assert select_default_anchor([{"name": "so", "amount": 2, "unit": "to taste"}]) is None


def test_resolve_by_index():
    assert resolve_ingredient(RECIPE, 0)["name"] == "csirkeemlo"
    assert resolve_ingredient(RECIPE, 11)["name"] == "so"
    assert resolve_ingredient(RECIPE, 12)["name"] == "csili"


def test_resolve_by_name_case_insensitive():
    assert resolve_ingredient(RECIPE, "csirkeemlo")["name"] == "csirkeemlo"
    assert resolve_ingredient(RECIPE, "  CSIRKEEMLO ")["name"] == "csirkeemlo"


def test_resolve_missing_returns_none():
    assert resolve_ingredient(RECIPE, 99) is None
    assert resolve_ingredient(RECIPE, "nonexistent") is None
    assert resolve_ingredient(RECIPE, None) is None

