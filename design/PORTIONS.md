# Solin — Portion-aware macros: `portions` extension contract

> **Status: Implementation-ready.** Binding contract for the portion-split
> feature on `solin-dev`. Extends the existing real-macro aggregation
> (`macro_count` / `aggregate_macro_result`) and the
> `POST /api/v1/inventory/macros/count` route (contract §3.6/§4, `use_cases.md` §5.3).
>
> **Consumers (all block on this doc):**
> - `t_3ba0beb1` — backend: add `portions` param + `per_portion` output (developer)
> - `t_2d849968` — UI: portion selector + per-portion display (developer)
| `t_76975145` — QA: per-portion end-to-end suite (tester)
>
> **Canonical root:** `use_cases.md §7` remains the use-case home.
> This file is the detailed implementation spec. Field names in §3 are
> **normative** — implement exactly.

---

## 1. What changes, in one paragraph

The existing endpoint (`POST /api/v1/inventory/macros/count`) already
returns the macro totals for **one batch** (`totals`). Portions are a
*view* of that same batch: the user says "this batch is `portions` servings"
and the response gains a `per_portion` block = `totals / portions`, per
macro field. Nothing about ingredient quantities, unit conversion, cost
selection, or warnings changes — portions only divides the **already-
computed** per-batch totals. `portions` is a request-only body field with
default `1`, so the response is fully backward-compatible when it is omitted
or set to `1`.

**Do NOT** change the endpoint path. **Do NOT** re-scale ingredient
quantities by portions. **Do NOT** divide `total_cost` (see §7 — cost is a
whole-batch figure).

---

## 2. Request

`POST /api/v1/inventory/macros/count` — add exactly one optional field to
the existing body. The existing `items` array is unchanged.

```json
{
  "items": [
    {"product_id": "p1", "quantity": 200, "unit": "g"},
    {"product_id": "p2", "quantity": 100, "unit": "g"},
    {"product_id": "p3", "quantity": 10,  "unit": "ml"}
  ],
  "portions": 4
}
```

| field      | type        | required | default | constraints                                              |
|------------|-------------|----------|---------|----------------------------------------------------------|
| `portions` | int (JSON number, integral) | no | **1** | `integer`, `>= 1`, `<= 999`. Fractional (e.g. `2.5`) and non-integral values are **rejected** (see §5). |

- The `portions` field is accepted **in addition to** the canonical
  `items[]` field. Both are top-level keys on the same JSON body.
- Omitting it, passing `null`, or passing `1` are **byte-for-byte identical**
  to today's behavior: `totals` returned unchanged, `per_portion` = `totals`
  (since `/1`). This is the backward-compat guarantee.
- Validation order: `items` (existing), then `portions` (new). `items`
  failures are unchanged. `portions` failures are 400 `PORTIONS_INVALID`
  (see §10), `fields=["portions"]`.

---

## 3. Response (normative)

The current top-level object is:

```json
{
  "totals":         { ...7 macro keys... },
  "per_ingredient": [ ... ],
  "total_cost":     { "amount": 2.05, "currency": "USD" } | null,
  "warnings":       [ { "code": "...", "product_id": "..." } ]
}
```

**Extend** it — add two top-level keys, keep all four existing ones verbatim:

```json
{
  "portions": 4,

  "totals": {
    "calories": 767.40, "protein": 69.90, "fat": 18.10,
    "carbs": 78.80, "fiber": 2.10, "sugar": 0.10, "sodium": 150.00
  },

  "per_portion": {
    "calories": 191.85, "protein": 17.48, "fat": 4.53,
    "carbs": 19.70, "fiber": 0.53, "sugar": 0.03, "sodium": 37.50
  },

  "per_ingredient": [ ...unchanged... ],
  "total_cost": { "amount": 2.05, "currency": "USD" },
  "warnings": [ ...unchanged... ]
}
```

**Key rules:**

1. **`portions`** (echo integer) — the *effective* value used for the split,
   after validation. Always present in the response (even when the request
   omitted it → echoes `1`). Lets the UI render "Per portion (of 4): …".
2. **`per_portion`** — a **MacroBlock** (exactly the 7 fields, same order as
   `totals`), where each field = `r2(totals[field] / portions)`. This is the
   UI's `per_portion_macros`.
3. **`totals`** is unchanged and remains the **canonical whole-batch** total.
   Naming note: `totals` **IS** the task's `total_macros`. Do not rename it;
   `per_portion` is the new `per_portion_macros`.
4. **`total_cost` is NOT divided.** It stays the cost of the whole batch
   (see §7). There is no `per_portion_cost` in MVP.
5. **Field presence:** `per_portion` is always present, including for a zero
   macro case (all seven keys `0.0`) and for a partially-unresolved recipe
   (unresolved ingredients contribute `0` to `totals`, so `per_portion` also
   carries `0` for those fields).
6. **Rounding:** every value rounded per canonical C2 (half-up, 2 dp).
   Division is performed at full Decimal precision *before* the single final
   r2 — never round the input, divide, then rely on floating-point. Trailing
   zeros are dropped in JSON (e.g. `19.70` → `19.7`, `37.50` → `37.5`); this
   is normal and expected (C1/C2).

---

## 4. Scaling model & relationship to ingredient quantities

Portions are a **pure divisor on the finished totals**. The order of
evaluation is fixed and normative:

1. Resolve & scale each ingredient by its **quantity** and **unit** exactly as
   `use_cases.md` §4.1 does (this is independent of portions).
2. Sum per-batch → `totals` per field (§4.2). **`totals` is the macro for
   the batch exactly as the recipe lists it.**
3. **Then** and only then: `per_portion[field] = r2(totals[field] / portions)`.

Therefore the relationship the task asked for — "scale factor = 1/portions" —
holds *between the two output blocks*, not on the ingredient inputs:

```
per_portion[field]  =  r2( totals[field] / portions )
totals[field]       =  r2( Σ per_ingredient[i][field] )   // unchanged by portions
```

- If the recipe's quantities already describe a full multi-serving batch
  (e.g. "600 g chicken" is really 2 people's meal and the user says
  `portions=2`), each served portion = `totals/2`. The user controls what
  "one portion" means by choosing `portions`; the server does not infer it.
- If the recipe quantities are already *per single serving* and the user
  batch-cooks it `N` times, they should either set `portions=1` (as-listed)
  or enter `N×` the quantities and set `portions=N`. The server only divides
  what is fed to `totals`. This disambiguates the "batch of N portions" case
  in one rule: **`per_portion` is always `1/N` of the batch totals**, by
  construction, no matter how the user arrived at the totals.

---

## 5. Edge cases & validation (normative)

| # | Input | Behavior | Response detail |
|---|-------|----------|-----------------|
| E1 | `portions` omitted | default `1`; `per_portion` == `totals` | echoes `portions: 1` |
| E2 | `portions: null` | treated as omitted → `1` | echoes `portions: 1` |
| E3 | `portions: 0` | **reject** | `400`, body `{code:"PORTIONS_INVALID", message, fields:["portions"]}` |
| E4 | `portions: -3` | **reject** | `400 PORTIONS_INVALID` |
| E5 | `portions: 2.5` | **reject** (must be integral) | `400 PORTIONS_INVALID` |
| E6 | `portions: "4"` (string) | **reject** (type must be number/int) | `400 PORTIONS_INVALID` |
| E7 | `portions: 1000` | **reject** (exceeds `999` bound) | `400 PORTIONS_INVALID` |
| E8 | `portions: 1e2` (=100) | accept; effective `100` | echoes `portions: 100` (JSON integral values only) |
| E9 | any of the above reject cases | **whole-batch `totals` is still computed but NOT returned to the caller as success** | HTTP ≥ 400; body is the standard C8 error envelope, not the macro result |

Validation order: validate `portions` **first** (cheap, before any DB lookups
or aggregation). A `PORTIONS_INVALID` is a 400 **request** error — it must
fire even if the recipe/ingredients are otherwise valid. Reject, do **not**
clamp, for out-of-range/integral failures (determinism + explicit UI
messaging; the UI stepper has `min=1` so this is defensive).

**`PORTIONS_MAX = 999`.** (Upper bound keeps the per-portion values meaningful
and defends against an accidental giant integer; a user who genuinely makes
>999 portions of a batch should split into separate meals. Not a hard data cap —
it's an input sanity bound. If product later needs a real high-water
mark, change `PORTIONS_MAX` in `validation.py` — it is the single source of
the bound.)

Effective-portion echo: the echoed `portions` is the **integer** used, so for
E8 it is `100`, never `100.0` or `1e2`.

---

## 6. Rounding & precision (normative, C2-consistent)

- Compute `totals` and `total_cost` exactly as `use_cases.md` §4.2/§4.3 say
  (sum of per-ingredient r2 values; per-field, Decimal, half-up 2 dp).
- Compute `per_portion` as `r2( totals[field] / portions )` using
  `decimal.Decimal(total_value) / portions`, then quantize half-up to `0.01`.
- **Invariant the developer and QA both rely on:**
  `r2( totals[f] / portions )` equals the returned `per_portion[f]` for
  every macro field `f`. For the acceptance probe (`portions=4`, the §5.3
  canonical batch) this means the returned `per_portion` is *exactly* the
  §5.3 `totals` divided by `4`, half-up rounded to 2 dp — no extra drift.
- Division uses full precision; only the **final** value is rounded. Do not
  pre-round `totals` again (they're already 2 dp) and do not round
  per-ingredient values separately for the division path.

---

## 7. Cost stays whole-batch

`total_cost` is the price of **everything** the user prepared in this batch.
Portions are a way to *view* macros per serving; they do not de-price the
purchase. Therefore:

- `total_cost` is returned **unchanged** by `portions`.
- There is **no** `per_portion_cost` field in MVP (do not add one — the QA
  plan has no per-portion cost assertion).
- Rationale: cost is anchored to `pack_size` prices in currency and is
  additive across ingredients; dividing it by portions would mix units
  (currency / serving) with no defined basis. If a future feature wants
  "cost per serving", that is a separate contract, not one implied here.

---

## 8. Worked example (reuses canonical `use_cases.md` §5.3 batch)

Canonical §5.3 **batch** totals (fixed, from `use_cases.md` §5.3 — do not
recompute; use exactly these):

```
totals = {
  calories: 767.40, protein: 69.90, fat: 18.10, carbs: 78.80,
  fiber: 2.10, sugar: 0.10, sodium: 150.00
}
total_cost = { amount: 2.05, currency: "USD" }
```

### `portions=1` (default / backward-compat)
`per_portion` == `totals` field-for-field:

```
per_portion = {
  calories: 767.40, protein: 69.90, fat: 18.10, carbs: 78.80,
  fiber: 2.10, sugar: 0.10, sodium: 150.00
}
```

### `portions=4` — canonical acceptance probe
`per_portion[field] = r2(totals[field]/4)`, half-up:

| field    | totals  | /4 (exact) | r2 (HALF-UP) |
|----------|---------|-----------|--------------|
| calories | 767.40  | 191.850   | **191.85**   |
| protein  | 69.90   | 17.475    | **17.48**    |
| fat      | 18.10   | 4.525     | **4.53**     |
| carbs    | 78.80   | 19.700    | **19.70**    |
| fiber    | 2.10    | 0.525     | **0.53**     |
| sugar    | 0.10    | 0.025     | **0.03**     |
| sodium   | 150.00  | 37.500    | **37.50**    |

`total_cost` = `{ "amount": 2.05, "currency": "USD" }` (unchanged).

**Half-up note (do not round-to-even here):** 17.475 → 17.48, 4.525 → 4.53,
0.525 → 0.53, 0.025 → 0.03. `decimal.ROUND_HALF_UP` (per C2), **not**
`ROUND_HALF_EVEN` — a banker's rounding would give 17.47 / 4.52 / 0.52 / 0.02
and fail this probe.

### `portions=6` — UI acceptance probe ("type 6")

| field    | totals  | /6 | r2 HALF-UP |
|----------|---------|----|-----------|
| calories | 767.40  | 127.900    | **127.90** |
| protein  | 69.90   | 11.650     | **11.65**  |
| fat      | 18.10   | 3.0166…    | **3.02**   |
| carbs    | 78.80   | 13.1333…   | **13.13**  |
| fiber    | 2.10    | 0.350      | **0.35**   |
| sugar    | 0.10    | 0.0166…    | **0.02**   |
| sodium   | 150.00  | 25.000     | **25.00**  |

`total_cost` unchanged (`2.05 USD`).

---

## 9. Service / function signature (backend implementation)

The existing engine (`backend/app/inventory/macros.py`, `solin-dev`) is:

```
aggregate_macro_result(ingredients, products=None) -> Dict[str, Any]   # today
macro_count(ingredients: Sequence[dict]) -> Dict[str, Any]              # today
count_real_macros = macro_count                                         # alias (L433)
```

And the HTTP route is:

```
POST /api/v1/inventory/macros/count   # routes.py L66
```

which forwards the `body["items"]` list to the engine.

**Extend to** (add one new optional keyword arg, **default 1**, to the
existing public functions; no existing caller changes):

```
aggregate_macro_result(ingredients, products=None, portions: int = 1)
macro_count(ingredients, portions: int = 1)
```

Contract:
- `portions` validated **before** any aggregation (E3–E7). On failure
  raise `InventoryError("PORTIONS_INVALID", 400, "portions must be an integer between 1 and 999", fields=["portions"])` — do **not**
  return a partial result.
- On success, compute the existing `{totals, per_ingredient, total_cost,
  warnings}` first (exactly as today, `totals` still = the whole-batch
  sum), then **add** two keys to the returned dict:
  - `portions`: the effective int used for the split (echo, default 1)
  - `per_portion`: a MacroBlock (7 fields, same order as `totals`)
    where each field = `r2(totals[field] / portions)` (C2 ROUND_HALF_UP)
- **Additive-only:** no existing key changes name, type, or value.
  Strict-equality tests in `t_06d48239` that compare the entire response
  dict must be updated to allow the two new keys — but no existing numeric
  assertion changes.
- The route `POST /api/v1/inventory/macros/count` reads `portions` from
  the request body (default `1`) and forwards it to `svc.macro_count(items,
  portions=...)`, which forwards to the engine with `portions=...`.

**Reference implementation shape** (normative, illustrative):

```python
def aggregate_macro_result(ingredients, products=None, *, portions=1):
    _validate_portions(portions)                    # may raise InventoryError
    result = _aggregate(ingredients, products)      # today's logic, unchanged
    totals = result["totals"]
    n = int(portions)
    result["portions"] = n
    result["per_portion"] = {
        k: r2(totals[k] / n) for k in MACRO_KEYS    # order preserved
    }
    return result
```

`_validate_portions` mirrors the existing `InventoryError` style and is
the **single** place the bound (`PORTIONS_MAX = 999`) is checked. Put it
in `validation.py` alongside the other validators so it is testable
in isolation (acceptance: `_validate_portions(0)` raises with
`PORTIONS_INVALID`, `fields=["portions"]`, `status_code=400`).

---

## 10. Error code (add to `use_cases.md` §6 table)

| HTTP | code                 | meaning |
|------|----------------------|---------|
| 400  | `PORTIONS_INVALID`   | `portions` not a positive integral integer in `[1, 999]` (0, negative, fraction, non-numeric, or `> 999`) |

Envelope shape (from `InventoryError.to_body()`, `backend/app/inventory/
validation.py` — top-level keys, **no** `error` wrapper):
```json
{
  "code": "PORTIONS_INVALID",
  "message": "portions must be an integer between 1 and 999",
  "fields": ["portions"]
}
```

---

## 11. What QA (`t_76975145`) asserts (minimum)

1. `POST /api/v1/inventory/macros/count` **without** `portions` → `portions==1`
   echoed, `per_portion == totals` field-for-field, all legacy keys
   present and unchanged.
2. `portions=4` on the §5.3 canonical batch → `per_portion` **exactly**
   matches the §8 table (191.85 / 17.48 / 4.53 / 19.7 / 0.53 / 0.03 / 37.5),
   `total_cost` unchanged `2.05 USD`.
3. `portions=6` → `per_portion` matches the §8 (N=6) table.
4. Each E1–E9 validation case returns the code and HTTP status from §5.
5. Field order in `per_portion` == field order in `totals` (7 keys, same
   canonical order).
6. **Invariance:** for any `P in [1..12]` (skip E-rejects),
   `abs(per_portion[f] - r2(totals[f]/P)) <= 0.005` for every macro field
   `f`. (This is a 2 dp equality within a rounding epsilon.)
7. `total_cost` is **identical** across `portions=1, 4, 6` on the same
   recipe. (Regression guard: cost must never start being divided.)

---

## 12. Explicit non-goals (MVP) — do NOT implement

- Per-portion cost / price (`per_portion_cost`) — see §7.
- Rounding **up** of portions (e.g. 2.5 → 3). The rule is **reject** (E5).
- Auto-infering `portions` from ingredient quantities.
- Persisting `portions` on the recipe entity. It is a **request-time view**
  parameter — not stored.
- Locale-specific per-serving normalization (US "serving" 1 cup / 1 oz —
  see `use_cases.md` §3.6 note). Portions are unit-free integer splits.
- Any new endpoint. Extend `POST /api/v1/inventory/macros/count` only.

---

## 13. Decision log (resolved by this contract)

| decision | resolution |
|----------|------------|
| Request field name | **`portions`** (int, default 1). Not `n_serving`, not `serves_count`. |
| Response split-naming | Keep `totals`; add **`per_portion`** (MacroBlock). `total_macros`/`per_portion_macros` from the original request are satisfied by these two names. |
| Fractional `portions` | **Reject** (400 `PORTIONS_INVALID`), do not clamp or round. |
| Upper bound | **999** (`PORTIONS_MAX` in `validation.py`). |
| Rounding model | `r2(totals[f]/portions)` with `ROUND_HALF_UP`, 2 dp, full precision inside. |
| Cost | **Whole-batch only.** No `per_portion_cost`. |
| Persistence | None. `portions` is a request-time view parameter. |
| Endpoint path | Unchanged. |
| Backward compat | `portions` omitted ⇒ `per_portion == totals`, legacy response intact. |
