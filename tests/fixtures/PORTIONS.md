# `tests/fixtures/PORTIONS.json`

Canonical fixture for the portion-aware macro feature
(task **t_76975145** QA probe).

## What it holds

- **`engine_inputs`** — exact products + ingredient references to pass
  into the live engine
  (`backend/app/inventory/macros.py::aggregate_macro_result(ingredients,
  products=...)`). Reuses the same data as
  `use_cases.md \u00a75.3`. **Do not re-derive from the UI.**
- **`expected_totals`** — macro totals for the batch (the whole-batch
  numbers; `use_cases.md \u00a75.3` table row).
- **`expected_total_cost`** — invariant across `portions` values.
- **`portions_reference`** — for `portions` in `1, 3, 4, 6, 8, 100`, the expected
  `per_portion` MacroBlock and `total_cost`. Each `per_portion` row is the
  exact `r2(totals / portions)` with C2 ROUND_HALF_UP
  (`design/PORTIONS.md \u00a78`, `use_cases.md \u00a77.5`).
- **`portions_rejection_cases`** — the normative `E3\u2013E7` invalid inputs
  (`0`, `-3`, `2.5`, `"4"`, `7.5`, `1000` → 400 `PORTIONS_INVALID` with
  `fields=["portions"]`; `1e2`=100 is valid; `null` is treated as omitted).
- **`boundary`** — the `[1, 999]` effective range.

## Provenance

The `portions_reference` values were computed against the live
`solin-dev` engine (`aggregate_macro_result`) in this environment before
committing them to the contract; they are NOT hand-derived. Re-running the
probe against the engine is a mandatory acceptance step for `t_3ba0beb1`
(backend) and `t_76975145` (QA).

## Usage in tests

```python
import json, pathlib, pytest, sys
sys.path.insert(0, "backend")
from app.inventory.macros import aggregate_macro_result
from app.inventory.validation import InventoryError

F = json.loads((pathlib.Path(__file__).parent / "PORTIONS.json").read_text())
ING, P = F["engine_inputs"]["ingredients"], F["engine_inputs"]["products"]

def test_portions_split():
    for case in F["portions_reference"]:
        res = aggregate_macro_result(ING, P, portions=case["portions"])
        assert res["totals"] == F["expected_totals"]        # invariant
        assert res["total_cost"] == F["expected_total_cost"] # invariant
        assert res["per_portion"] == case["per_portion"]     # split
        assert res["portions"] == case["portions"]           # echo

def test_invalid_portions():
    with pytest.raises(InventoryError) as e:
        aggregate_macro_result(ING, P, portions=0)
    assert e.value.status_code == 400      # value-range violation (§10, use_cases.md §6)
    assert e.value.code == "PORTIONS_INVALID"
    assert e.value.fields == ["portions"]
    # InventoryError body is top-level (no `error` wrapper):
    body = e.value.to_body()
    assert set(body) == {"code", "message", "fields"}
    assert body["code"] == "PORTIONS_INVALID"
    assert body["fields"] == ["portions"]
```
