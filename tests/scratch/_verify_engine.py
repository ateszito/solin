import sys
sys.path.insert(0, "backend")
import os; os.environ.setdefault("SOLIN_ENV", "unknown")

from decimal import Decimal
from app.services.recipe_scaling import (
    scale_recipe, classify_unit, UnitClass, round_amount,
)

# --- Canonical recipe (design §5) ---
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

# Design §5.1 upscale 850g -> canonical values
EXPECTED_850 = {
    "csirkeemlo": 850, "voroshagyma": 261.54, "kolbasz": 65.38,
    "tejszin": 209.23, "parmezan": 52.31, "teszta": 313.85,
    "spinot": 104.62, "fokhagyma": 4, "paradicsompure": 3.9,
    "fustolt-paprika": 1.3, "bors": 0.7, "so": 2, "csili": 1,
}
# Design §5.2 downscale 480g
EXPECTED_480 = {
    "csirkeemlo": 480, "voroshagyma": 147.69, "kolbasz": 36.92,
    "tejszin": 118.15, "parmezan": 29.54, "teszta": 177.23,
    "spinot": 59.08, "fokhagyma": 2, "paradicsompure": 2.2,
    "fustolt-paprika": 0.7, "bors": 0.4, "so": 2, "csili": 1,
}

def run(avail, expected):
    target = {"name": "csirkeemlo", "amount": 650, "unit": "g"}
    res = scale_recipe(RECIPE, avail, target)
    got = {si.name: float(si.amount) for si in res.ingredients}
    fails = []
    for k, v in expected.items():
        g = got.get(k)
        if abs(g - v) > 1e-9:
            fails.append(f"  {k}: got {g}, expected {v}")
    # manual flags
    manuals = {si.name for si in res.ingredients if si.manual}
    if manuals != {"so", "csili"}:
        fails.append(f"  manuals: {manuals}, expected {{so, csili}}")
    if fails:
        print(f"FAIL avail={avail}:")
        print("\n".join(fails))
    else:
        print(f"OK avail={avail}: all {len(expected)} values match design §5, manuals correct")
    return not fails

ok1 = run(850, EXPECTED_850)
ok2 = run(480, EXPECTED_480)

# --- Round-boundary unit tests (round_amount direct) ---
print("--- rounding boundaries ---")
def expect(label, raw, unit, want):
    got = round_amount(Decimal(str(raw)), unit)
    status = "OK" if abs(got - Decimal(str(want))) < 1e-12 else f"FAIL (got {got})"
    print(f"  {label}: raw={raw} {unit} -> {got}  expect {want}  [{status}]")
    return status == "OK"

checks = [
    # mass 2dp half-up
    ("mass .005 tie up", 3.305, "g", 3.31),
    ("mass .155 tie up", 1.155, "g", 1.16),
    # liquid 1dp half-up
    ("liquid .25 tie up", 0.25, "tsp", 0.3),
    ("liquid .15 tie up", 0.15, "tsp", 0.2),
    # count min-1
    ("count 0.4 -> 1", 0.4, "gerezd", 1),
    ("count 0.6 -> 1", 0.6, "gerezd", 1),
    # liquid min-1 NOT applied (design §3.1: 0.369 -> 0.4, not 1)
    ("liquid 0.369 -> 0.4", 0.369, "tsp", 0.4),
]
ok3 = all(expect(*c) for c in checks)

# --- classify sanity ---
print("--- classifier ---")
cs = [
    ("g", "mass"), ("kg", "mass"), ("mg", "mass"),
    ("ml", "liquid"), ("l", "liquid"), ("cup", "liquid"),
    ("tbsp", "liquid"), ("tsp", "liquid"), ("tk", "liquid"),
    ("gerezd", "count"), ("db", "count"), ("szelet", "count"),
    ("fej", "count"), ("tojas", "count"), ("tojas", "count"),
    ("darab", "count"), ("szal", "count"), ("gomboc", "count"),
    ("pcs", "non_scalable"), ("to taste", "non_scalable"),
    ("jodag", "non_scalable"), ("pinch", "non_scalable"),
    ("1-2 gerezd", "non_scalable"), ("", "non_scalable"),
]
ok4 = all(
    (lambda u, exp: print(f"  {u!r:14} -> {classify_unit(u):14}  expect {exp}  " + ("[OK]" if classify_unit(u)==exp else "[FAIL]")) or classify_unit(u) == exp
) for (u, exp) in cs
)

print()
if ok1 and ok2 and ok3 and ok4:
    print("ALL ENGINE CHECKS PASSED")
else:
    print("SOME CHECKS FAILED")
    sys.exit(1)
