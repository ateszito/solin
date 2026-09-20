"""Recipe scaling engine — pure, deterministic core (no FastAPI, no I/O).

Implements the canonical scaling rule from ``docs/design/RECIPE_SCALING.md``:

    f          = available_amount / base_amount(target)      # exact Decimal
    new_amount = base_amount * f                             # rounded HALF-UP per unit class

Unit classes and their canonical rounding (design §3):

    mass     (g, kg, mg)             -> 2 decimal places
    liquid   (ml, l, cup, tbsp, tsp) -> 1 decimal place
    count    (cloves, pcs, slice, ...) -> whole number, MIN 1 when 0 < raw < 1
    non-scalable (pinch, dash, “to taste”, optional, free-text) -> base unchanged + MANUAL flag

Determinism (design §9.1): no ``random``, no wall-clock dependence — the same
(input recipe, available amount, target) always yields the same output. All
arithmetic uses :class:`decimal.Decimal` with ``ROUND_HALF_UP`` (never float),
so every value is traceable back to ``f`` and the base.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from typing import Any, Dict, List, Optional, Sequence, Union

# ---------------------------------------------------------------------------
# Unit classification (canonical — design §3 / §4)
# ---------------------------------------------------------------------------

class UnitClass:
    """Constant labels for the four unit classes (stable to serialize)."""

    MASS = "mass"
    LIQUID = "liquid"
    COUNT = "count"
    NON_SCALABLE = "non_scalable"


#: Diacritic / Hungarian-legacy variants -> canonical ASCII token.
#: Only these are canonical; everything else (unknown, free-text, ranges)
#: is non-scalable by design §4.
_UNIT_ALIASES = {
    "tojás": "tojas",
    "szál": "szal",
    "gombóc": "gomboc",
    "evőkanál": "tbsp",
    "teáskanál": "tsp",
    "tk": "tsp",
}


def normalize_unit(unit: Any) -> str:
    """Fold a raw unit token to its canonical (lower-case, ASCII) form.

    Design §4 names the scalable set with diacritics (``tojás / szál / gombóc``);
    clients and seeds may vary case, whitespace, or use the plain ASCII form.
    ``_UNIT_ALIASES`` maps the diacritic/legacy variants onto the canonical
    tokens used by :data:`MASS_UNITS`/:data:`LIQUID_UNITS`/:data:`COUNT_UNITS`
    so the classifier stays tolerant and deterministic.
    """
    u = str(unit or "").strip().lower()
    return _UNIT_ALIASES.get(u, u)


#: Mass units -> 2 decimal places. (Design §3 row 1: g, kg, mg.)
MASS_UNITS = {"g", "kg", "mg"}

#: Liquid / volume units -> 1 decimal place.
#: (Design §3 row 2: ml, l, cup, tbsp / evőkanál, tsp / teáskanál / tk.)
LIQUID_UNITS = {"ml", "l", "cup", "tbsp", "tsp"}

#: Count / discrete units -> whole number, min 1 when 0 < base×f < 1.
#: (Design §3 row 3 / §4: gerezd, db, szelet, fej, tojás, darab, szál, gombóc.)
#: Diacritic variants of the same words are folded via ``_UNIT_ALIASES`` before
#: this set is consulted, so ``tojás`` -> ``tojas`` etc.
COUNT_UNITS = {
    "gerezd", "db", "szelet", "fej", "tojas", "darab", "szal", "gomboc",
}

#: Non-scalable — base kept at original value, `manual` flag set (design §3
#: row 4 / §4: "to taste", "jodag", "kb. N db", "1 pcs", "1-2 ...", free-text).
#: ANY unit NOT in MASS ∪ LIQUID ∪ COUNT falls through to this class — this set
#: just documents the canonical non-scalables.
NON_SCALABLE_UNITS = {"pinch", "dash", "to taste", "taste", "optional"}


#: All scalable units in one flat set (mass ∪ liquid ∪ count).
SCALABLE_UNITS = MASS_UNITS | LIQUID_UNITS | COUNT_UNITS


def classify_unit(unit: Any) -> str:
    """Return the UnitClass label for a raw unit token (design §4).

    Canonical tokens are accepted case-insensitively and after diacritic
    folding (``_UNIT_ALIASES``); any token NOT in the canonical set is
    non-scalable (safe default per design §4 — "bármely nem parsolt szöveg").
    """
    u = normalize_unit(unit)
    if u in MASS_UNITS:
        return UnitClass.MASS
    if u in LIQUID_UNITS:
        return UnitClass.LIQUID
    if u in COUNT_UNITS:
        return UnitClass.COUNT
    return UnitClass.NON_SCALABLE


def is_scalable(unit: Any) -> bool:
    """True if the unit can be multiplied by a scale factor (design §4)."""
    return classify_unit(unit) != UnitClass.NON_SCALABLE


# ---------------------------------------------------------------------------
# Numeric parsing (robust, Decimal-based)
# ---------------------------------------------------------------------------

def parse_amount(value: Any) -> Optional[Decimal]:
    """Best-effort conversion of an input token to a finite :class:`Decimal`.

    Accepts int / finite float / numeric string (`,` -> `.` is tolerated).
    Returns ``None`` for booleans, non-numeric strings, NaN, inf, and ``None``
    — the caller then raises a 400-class error.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        # str() round-trips a Python float losslessly (repr), preserving the
        # exact decimal the client sent — e.g. 850.0 -> Decimal('850.0').
        return Decimal(str(value))
    if isinstance(value, str):
        s = value.strip().replace(",", ".")
        if not s:
            return None
        try:
            d = Decimal(s)
        except InvalidOperation:
            return None
        return d if d.is_finite() else None
    return None


# ---------------------------------------------------------------------------
# Rounding (canonical, per-unit — design §3)
# ---------------------------------------------------------------------------

def round_amount(raw: Decimal, unit: Any) -> Decimal:
    """Round ``base * factor`` (``raw``) to the canonical precision for ``unit``.

    * mass     -> 2 dp, half-up
    * liquid   -> 1 dp, half-up
    * count    -> whole, half-up, MIN 1 when 0 < raw < 1 (design §3.1 / §9.4)

    Only meant to be called for *scalable* units — non-scalable units are kept
    at base (un-multiplied) by :func:`scale_recipe`.
    """
    cls = classify_unit(unit)
    if cls == UnitClass.MASS:
        return raw.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if cls == UnitClass.LIQUID:
        return raw.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    if cls == UnitClass.COUNT:
        whole = raw.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        # min-1: a strict fraction of a single discrete item becomes "1",
        # never "0" (you can't chop 0.4 of a clove; design §3.1 / §9.4).
        if raw > 0 and whole == 0:
            whole = Decimal("1")
        return whole
    # Defensive: non-scalable should never reach here, but keep the value sane.
    return raw.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ---------------------------------------------------------------------------
# Result model
# ---------------------------------------------------------------------------

@dataclass
class ScaledIngredient:
    name: str
    amount: Decimal      # scaled value (or base, unchanged, for non-scalable)
    unit: str
    base_amount: Decimal  # original recipe amount (unchanged — design §9.5)
    base_unit: str
    scalable: bool
    manual: bool          # True => non-scalable, kept at base (design §5)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "amount": _to_number(self.amount),
            "unit": self.unit,
            "manual": self.manual,
            "scalable": self.scalable,
            "base_amount": _to_number(self.base_amount),
            "base_unit": self.base_unit,
        }


@dataclass
class ScaleResult:
    scale_factor: Decimal
    anchor: Dict[str, Any]
    ingredients: List[ScaledIngredient] = field(default_factory=list)

    def to_response(self, recipe_id: str) -> Dict[str, Any]:
        """JSON-serialisable response body (numbers, exact factor preserved).

        ``scale_factor`` and ``scale_factor_num`` keep different fidelities:
        the string ``scale_factor`` is lossless Decimal (e.g. "1.3076923077");
        the float ``scale_factor_num`` is the same value as a JSON number.
        Every ``amount`` in ``ingredients`` is an int/float (design §5 values).
        """
        return {
            "recipe_id": recipe_id,
            # Exact, lossless factor in plain notation (never E-notation).
            "scale_factor": format(self.scale_factor, "f"),
            # Same value as a JSON number, readable precision.
            "scale_factor_num": _to_rounded_float(self.scale_factor),
            "anchor": self.anchor,
            "ingredients": [si.to_dict() for si in self.ingredients],
        }


# ---------------------------------------------------------------------------
# Core pure function
# ---------------------------------------------------------------------------

def _to_ingredient_dict(ing: Any) -> Dict[str, Any]:
    """Normalise one ingredient (dict *or* a Pydantic/attribute object) to a dict.

    Lets the pure engine work on raw dicts (tests / frontend seeds) AND on the
    backend's Pydantic ``Ingredient`` models without the caller copying fields.
    """
    if isinstance(ing, dict):
        d = dict(ing)
    else:
        d = {}
        for key in ("name", "amount", "unit", "prep", "order"):
            v = getattr(ing, key, None)
            if v is not None:
                d[key] = v
    return d


def scale_recipe(
    ingredients: Sequence[Dict[str, Any]],
    available_amount: Union[int, float, str, Decimal, None],
    target: Dict[str, Any],
) -> ScaleResult:
    """Recalculate every ingredient for a known available amount.

    Parameters
    ----------
    ingredients:
        The recipe's ingredient list (list of dicts with ``name/amount/unit``;
        Pydantic ``Ingredient`` models are also accepted and normalised).
    available_amount:
        How much of ``target`` the user has. Must be a positive number.
    target:
        The ingredient the user has — the scaling "anchor". Must be a scalable
        ingredient (non-scalable like ``pinch`` cannot define a scale factor).

    Returns a :class:`ScaleResult`. Raises ``ValueError`` (=> 400) when the
    input is not usable to derive a scale factor.
    """
    ings = [_to_ingredient_dict(i) for i in ingredients]
    t = _to_ingredient_dict(target)

    # -- 1. derive the exact scale factor from the anchor -----------------
    t_amount = parse_amount(t.get("amount"))
    t_unit = t.get("unit")
    if t_amount is None or t_amount <= 0:
        raise ValueError("target ingredient must have a positive numeric base amount")
    if not is_scalable(t_unit):
        raise ValueError(
            f"target ingredient unit {t_unit!r} is not scalable; "
            "choose a measurable (g/kg/gerezd/...) ingredient as the anchor"
        )

    avail = parse_amount(available_amount)
    if avail is None or avail <= 0:
        raise ValueError("available_amount must be a positive number")

    factor = avail / t_amount  # exact Decimal, no intermediate rounding (§2.2)

    # -- 2. scale (or leave) every ingredient ------------------------------
    out: List[ScaledIngredient] = []
    for ing in ings:
        name = str(ing.get("name") or "").strip()
        unit = str(ing.get("unit") or "").strip()
        base = parse_amount(ing.get("amount")) or Decimal("0")

        if is_scalable(unit):
            amount = round_amount(base * factor, unit)
            manual = False
        else:
            # Non-scalable (pinch/dash/to-taste/free-text): unchanged + MANUAL.
            amount = base
            manual = True

        out.append(ScaledIngredient(
            name=name,
            amount=amount,
            unit=unit,
            base_amount=base,
            base_unit=unit,
            scalable=not manual,
            manual=manual,
        ))

    return ScaleResult(
        scale_factor=factor,
        anchor={
            "name": str(t.get("name") or "").strip(),
            "unit": str(t_unit or "").strip(),
            "available_amount": _to_number(avail),
            "base_amount": _to_number(t_amount),
        },
        ingredients=out,
    )


def select_default_anchor(ingredients: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Default anchor = the largest-mass (g/kg/mg) ingredient (design §2.1).

    Returns the ingredient dict, or ``None`` if the recipe has no mass-based
    ingredient (the UI would then hide the scaler; the API still works when an
    explicit ``target`` is supplied).
    """
    best = None  # (base: Decimal, ing: dict)
    for ing in ingredients:
        if classify_unit(ing.get("unit") if isinstance(ing, dict) else getattr(ing, "unit", None)) == UnitClass.MASS:
            base = parse_amount(ing.get("amount") if isinstance(ing, dict) else getattr(ing, "amount", None))
            if base is None or base <= 0:
                continue
            if best is None or base > best[0]:
                best = (base, ing)
    return best[1] if best else None


def resolve_ingredient(
    ingredients: Sequence[Dict[str, Any]],
    ingredient_id: Union[int, str, None],
) -> Optional[Dict[str, Any]]:
    """Resolve an ``ingredient_id`` to one of the recipe's ingredients.

    The current schema has no per-ingredient id, so ``ingredient_id`` is
    accepted as either:

    * an **integer 0-based index** into the ingredients list, or
    * an **ingredient name** (case-/whitespace-insensitive match).

    Returns ``None`` when nothing matches (=> HTTP 404 in the endpoint).
    """
    if ingredient_id is None or isinstance(ingredient_id, bool):
        return None
    if isinstance(ingredient_id, int):
        if len(ingredients) and 0 <= ingredient_id < len(ingredients):
            return ingredients[ingredient_id]
        return None
    if isinstance(ingredient_id, str):
        nid = ingredient_id.strip().lower()
        for i in ingredients:
            name = i.get("name") if isinstance(i, dict) else getattr(i, "name", None)
            if str(name or "").strip().lower() == nid:
                return i
        return None
    return None


# ---------------------------------------------------------------------------
# internal serialisation helpers
# ---------------------------------------------------------------------------

def _to_number(d: Decimal):
    """Decimal -> int when integral, else float (so JSON shows 4 not 4.0)."""
    if d is None:
        return None
    if d == d.to_integral_value():
        return int(d)
    return float(d)


def _to_rounded_float(d: Decimal) -> float:
    """A readable float view of the factor (e.g. 1.3076923077)."""
    q = d.quantize(Decimal("0.0000000001"), rounding=ROUND_HALF_UP)
    return float(q)


# Convenience alias for tests / callers that prefer a stable public name.
parse_amount = parse_amount  # noqa: E501
