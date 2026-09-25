"""Macro aggregation engine for prepared food (contract §4, normative).

Given a ``recipe`` whose ingredient list references inventory products
(``product_id`` + ``quantity`` + ``unit``), this module resolves each product,
converts the quantity into the product's base unit, scales the per-100
macro block, and sums everything — plus an optional cost roll-up using the
cheapest price entry per product.

Design principles (mirroring :mod:`app.services.recipe_scaling`):

* **Pure + deterministic.** No I/O, no wall-clock, no float arithmetic. Every
  number flows through :class:`decimal.Decimal` with ``ROUND_HALF_UP`` (C2).
* **Tolerant at the boundary.** A product that is missing, has no macro
  basis, or a mismatched unit never 500s the aggregation — it is reported in
  ``per_ingredient`` with a ``warnings`` flag and an all-zero macro block,
  and a top-level ``warnings`` list records the condition (contract §4.4).
* **Canonical return shape** from contract §4.4:
  ``{totals, per_ingredient, total_cost, warnings}``.

Conversion table (contract §4.5, family-based):
    mass    g/kg/mg        -> to g        (1 kg = 1000 g, 1 mg = 0.001 g)
    liquid  ml/l/cup       -> to ml       (1 l = 1000 ml, 1 cup = 240 ml)
    count   pcs/slice/...  -> pcs (no cross-scale; only pcs matches pcs)
Anything in a *different* family from the product ``base_unit`` is
``UNITS_INCOMPATIBLE`` (contract §4.1 step 3).
"""

from __future__ import annotations

import math
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# C4 canonical macro keys (single source of truth shared with validation.py)
# ---------------------------------------------------------------------------
from .validation import MACRO_KEYS  # noqa: E402

#: Zero macro block (C4 order). Every unresolved ingredient carries this.
ZERO_BLOCK: Dict[str, float] = {k: 0.0 for k in MACRO_KEYS}

# ---------------------------------------------------------------------------
# Unit conversion to the product's base unit (contract §4.1 / §4.5)
# ---------------------------------------------------------------------------

#: factor to convert 1 unit -> 1 g  (mass family, base g)
_G_PER = {"g": Decimal("1"), "kg": Decimal("1000"), "mg": Decimal("0.001")}

#: factor to convert 1 unit -> 1 ml (liquid family, base ml)
_ML_PER = {"ml": Decimal("1"), "l": Decimal("1000"), "cup": Decimal("240")}

#: count family — discrete; only "pcs" is a legal base and only matches itself.
_COUNT_UNITS = {"pcs", "slice", "cloves"}

#: unit -> factor that brings it into the product's base unit of that family.
#: A unit not in the same family as the product base -> incompatible (None).
_FAMILY: Dict[str, str] = {}
for _k, _f in _G_PER.items():
    _FAMILY[_k] = "mass"
for _k, _f in _ML_PER.items():
    _FAMILY[_k] = "liquid"
for _k in _COUNT_UNITS:
    _FAMILY[_k] = "count"


def _to_base_unit(quantity: Decimal, ing_unit: str, base_unit: str) -> Optional[Decimal]:
    """Convert ``quantity`` (in ``ing_unit``) to ``base_unit`` (contract §4.1 step 3).

    Returns ``None`` when the two units are in different conversion families
    (mass vs liquid vs count) — the caller flags ``UNITS_INCOMPATIBLE``.

    * ``ing_unit == base_unit``        -> quantity unchanged.
    * same family, different scale     -> exact Decimal factor applied.
    * ``slice`` / ``cloves``           -> normalised to ``pcs`` (documented).
    * different family                 -> ``None``.
    """
    iu = (ing_unit or "").strip().lower()
    bu = (base_unit or "").strip().lower()
    if iu in ("slice", "cloves"):
        iu = "pcs"
    if iu == bu:
        return quantity
    if (iu not in _FAMILY) or (bu not in _FAMILY) or _FAMILY[iu] != _FAMILY[bu]:
        return None
    if bu == "g":
        return quantity * _G_PER[iu]
    if bu == "ml":
        return quantity * _ML_PER[iu]
    # base_unit == "pcs": count family — only "pcs" survived (slice/cloves
    # already folded); any other count token is a non-derivable scale.
    if iu == "pcs":
        return quantity
    return None


# ---------------------------------------------------------------------------
# Numeric parsing (Decimal, robust) — mirrors recipe_scaling.parse_amount
# ---------------------------------------------------------------------------

def _num(value: Any) -> Optional[Decimal]:
    """Best-effort conversion of an input token to a finite :class:`Decimal`.

    Accepts int / finite float / numeric string (`,` -> `.` tolerated).
    Returns ``None`` for booleans, non-numeric, NaN, inf, and ``None``.
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
        return Decimal(str(value))
    if isinstance(value, str):
        s = value.strip().replace(",", ".").replace(" ", "")
        if not s:
            return None
        try:
            d = Decimal(s)
        except Exception:
            return None
        return d if d.is_finite() else None
    return None


def r2(x: Decimal) -> Decimal:
    """C2 — round half-up to 2 dp (0.01) for every macro/monetary value."""
    return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _out(d: Optional[Decimal]):
    """Decimal -> int when integral, else float (so JSON shows 4 not 4.0)."""
    if d is None:
        return None
    if d == d.to_integral_value():
        return int(d)
    return float(d)


# ---------------------------------------------------------------------------
# Cost selection (contract §4.3)
# ---------------------------------------------------------------------------

def _select_price(product: dict):
    """Pick a single price entry per the normative cost rule (§4.3, §8).

    Returns ``None`` when the product has no usable price entries, else
    ``{"amount": Decimal, "currency": str, "pack_size": Decimal,
    "excluded_other_currencies": bool}``.

    Rule (contract §8, §4.3 step 2): the currency of the **first** valid
    price entry in list order is the base currency.  Within that currency,
    the entry with the lowest ``amount / pack_size`` wins.  All entries in
    any other currency are excluded (no FX in MVP) so the caller can emit a
    ``CROSS_CURRENCY_EXCLUDED`` warning.

    Worked p1 (chicken breast):
      prices = [USD 2.99/400 g, EUR 3.49/500 g]
      base_ccy = USD (first entry)
      USD unit price = 2.99/400 = 0.007475 USD/g
      EUR excluded → CROSS_CURRENCY_EXCLUDED warning
      cost = r2(0.007475 × 200) = r2(1.495) = 1.50 USD  (canonical §5.3)
    """
    prices = product.get("prices") or []
    if not prices:
        return None

    # Collect valid entries grouped by currency, preserving first-occurrence
    # order so we can apply first-currency-wins.
    by_ccy: Dict[str, list] = {}
    order: list = []
    for p in prices:
        if not isinstance(p, dict):
            continue
        amt = _num(p.get("amount"))
        pk = _num(p.get("pack_size"))
        ccy = p.get("currency")
        if amt is None or pk is None or pk <= 0 or amt <= 0:
            continue
        if not (isinstance(ccy, str) and ccy.strip()):
            continue
        ccy = ccy.strip().upper()
        if ccy not in by_ccy:
            by_ccy[ccy] = []
            order.append(ccy)
        by_ccy[ccy].append({"amount": amt, "pack_size": pk})

    if not by_ccy:
        return None

    # Contract §8: first-currency-wins — other currencies unconditionally excluded.
    base_ccy = order[0]
    entries = by_ccy[base_ccy]
    best = min(entries, key=lambda e: e["amount"] / e["pack_size"])

    excluded_other = len(order) > 1
    return {
        "amount": best["amount"],
        "currency": base_ccy,
        "pack_size": best["pack_size"],
        "excluded_other_currencies": excluded_other,
    }


# ---------------------------------------------------------------------------
# Core aggregation (contract §4 + §4.4)
# ---------------------------------------------------------------------------

def _resolve_products(products: Optional[Dict[str, dict]]) -> Dict[str, dict]:
    """Resolve the product snapshot for one aggregation call.

    ``products`` is an injectable mapping (id → product doc) so callers can
    hand in a curated catalog; when omitted, the default inventory store is
    snapshotted once (a single read of products.json) so the call is
    consistent even if the store is mutated between ingredients.
    """
    if products is not None:
        return {str(pid): dict(p) for pid, p in products.items() if p is not None}
    from .store import ProductStore

    return {pid: dict(p) for pid, p in ProductStore().load().items()}


def aggregate_macro_result(
    ingredients: Sequence[dict],
    products: Optional[Dict[str, dict]] = None,
) -> Dict[str, Any]:
    """Aggregate real macros (and optional cost) for a prepared food.

    Core of the :func:`macro_count` contract (§4 + §4.4): pure over the
    ``products`` mapping — no I/O, deterministic, exact Decimal math (C2
    ROUND_HALF_UP to 2 dp). ``products=None`` snapshots the default
    inventory store once (contract §3.6).

    Returns
    -------
    The canonical ``MacroResult`` dict (contract §4.4)::

        {
            "totals":       {calories, protein, fat, carbs, fiber, sugar, sodium},
            "per_ingredient": [
                {product_id, name, quantity, unit, macros, cost, warnings}
            ],
            "total_cost":   {"amount", "currency"} | None,
            "warnings":     [{"code", "product_id"}],
        }

    Unresolved ingredients are *reported*, not raised: they appear in
    ``per_ingredient`` with an all-zero macro block and a
    ``PRODUCT_NOT_FOUND`` warning, so the call is always a clean result
    (contract §6 QA rule: never 500).

    Parameters
    ----------
    ingredients:
        List of ``ingredient_reference`` dicts (contract §1.3), each at most
        ``{product_id, quantity, unit, name_override?, note?}``.
    products:
        Optional injectable mapping of product id → stored product doc.
        When ``None``, the default inventory store is read once.
    """
    if not isinstance(ingredients, (list, tuple)):
        raise TypeError("ingredients must be a list of ingredient references")

    prod_map = _resolve_products(products)

    totals: Dict[str, Decimal] = {k: Decimal("0") for k in MACRO_KEYS}
    per_ingredient: List[Dict[str, Any]] = []
    warnings: List[Dict[str, str]] = []

    # cost roll-up state (contract §4.3 step 4)
    base_currency: Optional[str] = None
    cost_sum = Decimal("0")
    any_captured = False  # at least one resolved product with a price

    def add(code: str, product_id: str) -> None:
        warnings.append({"code": code, "product_id": product_id})

    for ing in ingredients:
        row: Dict[str, Any] = {
            "product_id": None,
            "name": None,
            "quantity": None,
            "unit": None,
            "macros": dict(ZERO_BLOCK),
            "cost": None,
            "warnings": [],
        }

        pid = None
        if isinstance(ing, dict):
            pid = ing.get("product_id")
            row["product_id"] = None if pid is None else str(pid)
            name_override = ing.get("name_override")
            row["name"] = name_override if name_override else None
            ing_unit = ing.get("unit")
            row["unit"] = (str(ing_unit).strip()
                           if ing_unit is not None else None)
            row["quantity"] = _out(_num(ing.get("quantity")))

        # -- 1. resolve product (contract §4.1 step 1) -----------------------
        if not pid or str(pid) not in prod_map:
            wcode = "PRODUCT_NOT_FOUND"
            row["warnings"].append(wcode)
            if pid is not None:
                add(wcode, str(pid))
            per_ingredient.append(row)
            continue
        product = prod_map[str(pid)]

        if row["name"] is None:
            row["name"] = product.get("name")

        # missing quantity or unit -> treated as unaggregable (all zero + warn)
        qty_dec = _num(ing.get("quantity")) if isinstance(ing, dict) else None
        ing_unit = ing.get("unit") if isinstance(ing, dict) else None
        if (not isinstance(ing, dict)) or qty_dec is None or qty_dec <= 0 or not ing_unit:
            wcode = "VALIDATION_ERROR"
            row["warnings"].append(wcode)
            add(wcode, str(pid))
            per_ingredient.append(row)
            continue

        # -- 2. pick macro basis (contract §4.1 step 2) -----------------------
        macros_per_100 = product.get("macros_per_100")
        macros_per_serving = product.get("macros_per_serving")
        if macros_per_100:
            basis_values = macros_per_100
            basis_denominator = Decimal("100")
        elif macros_per_serving:
            basis_values = macros_per_serving
            serving_size = _num(product.get("serving_size"))
            if serving_size is None or serving_size <= 0:
                wcode = "NO_MACRO_BASIS"
                row["warnings"].append(wcode)
                add(wcode, str(pid))
                per_ingredient.append(row)
                continue
            basis_denominator = serving_size
        else:
            wcode = "NO_MACRO_BASIS"
            row["warnings"].append(wcode)
            add(wcode, str(pid))
            per_ingredient.append(row)
            continue

        # -- 3. convert to base unit (contract §4.1 step 3) -------------------
        base_unit = product.get("base_unit")
        q_in_base = _to_base_unit(qty_dec, str(ing_unit), str(base_unit))
        if q_in_base is None:
            wcode = "UNITS_INCOMPATIBLE"
            row["warnings"].append(wcode)
            add(wcode, str(pid))
            per_ingredient.append(row)
            continue

        q_in_base = max(q_in_base, Decimal("0"))

        # -- 4. scale (contract §4.1 step 4) ----------------------------------
        factor = q_in_base / basis_denominator

        # -- 5. per-ingredient macros (contract §4.1 step 5 + §4.2) -----------
        per_block: Dict[str, Any] = {}
        for k in MACRO_KEYS:
            raw = basis_values.get(k, 0.0)
            raw_dec = _num(raw)
            if raw_dec is None or raw_dec < 0:
                raw_dec = Decimal("0")
            scaled = r2(raw_dec * factor)
            per_block[k] = _out(scaled)
            totals[k] += scaled  # sum the already-rounded per-ingredient values

        row["macros"] = per_block

        # -- 6. cost (contract §4.3 + §8: first-currency-wins) ----------------
        price = _select_price(product)
        if price is not None:
            # cost = unit_price × quantity_in_base_unit, r2 (contract §4.3.3)
            unit_price = price["amount"] / price["pack_size"]
            cost = r2(unit_price * q_in_base)
            row["cost"] = _out(cost)
            ccy = price["currency"]
            if base_currency is None:
                base_currency = ccy
                cost_sum = cost
                any_captured = True
            elif ccy == base_currency:
                cost_sum += cost
                any_captured = True
            else:
                # cross-currency vs the established base → excluded + warn
                add("CROSS_CURRENCY_EXCLUDED", str(pid))
            if price.get("excluded_other_currencies"):
                add("CROSS_CURRENCY_EXCLUDED", str(pid))
        else:
            row["cost"] = None

        per_ingredient.append(row)

    # -- totals (contract §4.2) ----------------------------------------------
    totals_out: Dict[str, Any] = {}
    for k in MACRO_KEYS:
        totals_out[k] = _out(r2(totals[k]))

    total_cost = None
    if any_captured and base_currency is not None:
        total_cost = {"amount": _out(r2(cost_sum)), "currency": base_currency}

    return {
        "totals": totals_out,
        "per_ingredient": per_ingredient,
        "total_cost": total_cost,
        "warnings": warnings,
    }


def macro_count(ingredients: Sequence[dict]) -> Dict[str, Any]:
    """Contract §3.6 service function: ``macro_count(ingredients) -> MacroResult``.

    Resolves the ingredients against the default inventory store (a single
    snapshot) and returns the canonical §4.4 result.  Every input ingredient
    appears in ``per_ingredient[]`` in input order — including unresolved
    ones (zero macros, ``PRODUCT_NOT_FOUND`` warning) — so callers never
    see a 500 from the aggregation path (contract §6).
    """
    return aggregate_macro_result(ingredients, products=None)


#: Compatibility alias — the task body refers to the function as
#: ``count_real_macros``; it and :func:`macro_count` are identical.
count_real_macros = macro_count
