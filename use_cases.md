# Solin — Real Product Inventory: Data Model & API Contract

> **Status: Implementation-ready.** This is the contract the inventory module and
> the macro-aggregation function are built from. Consumers:
> - `t_152cdcdb` — implement Inventory CRUD + image upload (developer)
> - `t_b321f68d` — implement `count_real_macros()` macro aggregation (developer)
> - `t_06d48239` — QA end-to-end suite (tester)
> - `t_3ba0beb1` — implement portion-aware macro split (backend)
> - `t_2d849968` — add portion selector + per-portion display (UI)
> - `t_76975145` — QA per-portion suite (tester)
>
> Every field name below is **canonical** and normative. Deviations require a
> comment on the linking task before the developer proceeds.

---

## 0. Global conventions (apply everywhere)

- **C1 — Numeric type.** All macro/price/quantity values are JSON **numbers**
  (float allowed), never strings.
- **C2 — Rounding.** All display and comparison values are rounded **half-up** to
  2 decimal places (0.01 g / 0.01 currency). Internally use
  `decimal.Decimal(ROUND_HALF_UP)`; serialize to JSON number. Tolerance for the
  "match hand-calculated" acceptance: within 0.1 g per field.
- **C3 — Units.** Legal `unit` enum (matches `recipe.schema.json`):
  `g, kg, mg, ml, l, cup, tbsp, tsp, pcs, slice, cloves, pinch, dash`.
  Base unit of a product is one of `g | ml | pcs`.
- **C4 — Macro field set (canonical order).**
  `calories` (kcal), `protein` (g), `fat` (g), `carbs` (g), `fiber` (g),
  `sugar` (g), `sodium` (mg). These are the ONLY fields aggregated/totaled.
- **C5 — Timestamps.** ISO-8601 UTC, `YYYY-MM-DDTHH:MM:SSZ`, generated server-side
  at write time.
- **C6 — IDs.** `product.id` is a server-generated UUIDv4 string. Ingredient
  `product_id` references it.
- **C7 — Storage of media.** Files under the existing media root
  (`settings` in `backend/app/config.py`; default layout
  `/data/inventory/{product_id}/{slot}/{filename}`). The **media URL** is exposed
  through the existing static-media route. Never return a raw absolute
  filesystem path in an API response.
- **C8 — Error shape.** HTTP `4xx/5xx` with a **top-level** JSON body `{ "code": "<STR_ENUM>", "message": "<human>" }` plus optional `"details"` / `"fields"` keys. No `error` wrapper — emit the body exactly as `InventoryError.to_body()` produces (`backend/app/inventory/validation.py`): `{"code", "message", "details"?, "fields"?}`. Field-level failures set `"fields": ["<dotted.key>", ...]`.
  Codes defined in **§6**. A 404 on an unknown product is `NOT_FOUND`; a 400 with
  a field list is `VALIDATION_ERROR`.

---

## 1. Entity model

Four logical entities. Two of them are the product + its prices; the macro block
is a sub-object of the product; the image slot is also a sub-object of the
product. The recipe/ingredient side is *referenced*, not owned, by inventory.

### 1.1 `product` (the inventory row)

| field | type | required | constraints |
|---|---|---|---|
| `id` | uuid string | server | generated; not client-settable on POST |
| `name` | string | yes | 1–255 chars, trimmed, non-empty |
| `brand` | string \| null | no | 0–120 chars; `null` if not provided |
| `base_unit` | enum | yes | one of `g` \| `ml` \| `pcs` |
| `serving_size` | number \| null | no | >0; optional; grams/ml/pieces equivalent to one "serving" of this product |
| `serving_label` | string \| null | no | 1–60 chars; e.g. "1 can (330 ml)" |
| `macros_per_100` | `MacroBlock` | yes | per-100 g (or per-100 ml, or per-100 pcs); all C4 fields present |
| `macros_per_serving` | `MacroBlock` \| null | no | optional; if absent, derived via `serving_size` when one exists |
| `prices` | `PriceEntry[]` | no | 0..N; each element validated per §1.2 |
| `images` | `{ product_photo, label_photo }` | no | each slot either an `ImageSlot` (below) or `null` |
| `created_at` | iso8601 | server | — |
| `updated_at` | iso8601 | server | — |

`MacroBlock` (C4):
```
{
  "calories": number,   // kcal, >= 0
  "protein":  number,   // g,    >= 0
  "fat":      number,   // g,    >= 0
  "carbs":    number,   // g,    >= 0
  "fiber":    number,   // g,    >= 0
  "sugar":    number,   // g,    >= 0
  "sodium":   number    // mg,   >= 0
}
```
Every key is required inside a `MacroBlock`. `0` is a valid value (zero-calorie
product case in the QA plan); missing is a `VALIDATION_ERROR` (code
`MACRO_BLOCK_INCOMPLETE`).

`ImageSlot`:
```
{
  "url":          string (absolute or app-root-relative URL; never a fs path),
  "filename":     string,   // stored leaf name, sanitized
  "mime_type":    string,   // "image/jpeg" | "image/png" | "image/webp"
  "byte_size":    integer >0,
  "original_name": string | null,  // from multipart `filename`, if any
  "uploaded_at":  iso8601
}
```

### 1.2 `PriceEntry` (element of `product.prices[]`)

| field | type | required | constraints |
|---|---|---|---|
| `id` | uuid string | server | generated per entry; stable across PUTs |
| `amount` | number | yes | > 0; quantized to 2 dp |
| `currency` | string | yes | ISO-4217 3-letter, stored UPPER (e.g. `USD`, `EUR`, `HUF`) |
| `pack_size` | number | yes | > 0; unit is implied by product `base_unit` (500 means "500 g" / "500 ml" / "500 pcs") |
| `source` | string \| null | no | 1–120 chars; store / retailer / "home" |
| `captured_at` | iso8601 | server | timestamp of the capture |

Uniqueness: the same `(amount, currency, pack_size)` may appear twice if captured
at different times — the client can list them chronologically. The aggregation
function picks the **lowest unit price** (see §4) and is not affected by
duplicates.

### 1.3 `reference` (recipe → product, used by the macro function)

A recipe object (already modeled in `recipe.schema.json`) is extended — the
*product_id* is the canonical link. This is the shape **both** developer tasks
and the QA task must agree on:

```
ingredient_reference = {
  "product_id":   string (uuid, required),
  "name_override": string | null,  // optional display name; else look up product.name
  "quantity":     number > 0,
  "unit":         string enum (C3),
  "note":         string | null
}
```

The product's `base_unit` + `quantity` + `unit` together determine the scale
(see §4 conversion rules). `name_override` is display-only and never affects
macro math.

---

## 2. Storage layout (normative)

- **Media files under media root:**
  `<MEDIA_ROOT>/inventory/<product_id>/product_photo/<filename>`
  `<MEDIA_ROOT>/inventory/<product_id>/label_photo/<filename>`
- `<filename> = "YYYYMMDDTHHMMSSZ__<slug>"` (slug from `original_name`, or a
  deterministic hash if absent).
- **DB row:** one `products` row per product (the fields of §1.1). `prices`
  and `images` are stored as JSONB columns **or** as two sibling tables
  `product_price(product_id, ...)` / `product_image(product_id, slot, ...)` —
  the developer picks; the **API response shape is normative** and both
  layouts must produce the identical JSON.
- **Seeds:** `seed/inventory_seed.sql` (developer creates; QA verifies via API
  only). Must seed at least 2 products, one of them with ≥2 price entries.

---

## 3. API surface (FastAPI)

All routes are prefixed with the existing app prefix (no new base path —
`/inventory`; see `backend/app/main.py` for the mounted prefix if one is
present). All responses are JSON.

### 3.1 `POST /inventory` — create product
Request body (JSON):
```
{
  "name": "Chicken breast",
  "brand": "Oyala",
  "base_unit": "g",
  "serving_size": 150,
  "serving_label": "1 piece",
  "macros_per_100": {
    "calories": 165, "protein": 31.0, "fat": 3.6,
    "carbs": 0, "fiber": 0, "sugar": 0, "sodium": 74
  },
  "prices": [
    { "amount": 3.49, "currency": "EUR", "pack_size": 500,
      "source": "Lidl", "captured_at": null }
  ]
}
```
- `captured_at: null` → server fills now.
- Response: `201` + the full stored product (with `id`, `created_at`,
  `updated_at`, `prices[i].id`, `images` null for both slots).
- Validation failures: `400 VALIDATION_ERROR` (missing macro field, non-enum
  unit, negative amount, non-positive pack_size) or `422 UNPROCESSABLE` for
  type/format errors (Pydantic-style).

### 3.2 `GET /inventory` — list
- Query: `?limit=50&offset=0&search=<name-substring>` (all optional; defaults
  limit=50 offset=0).
- Response: `200` + `{ "items": [ <Product> ... ], "total": int }`.

### 3.3 `GET /inventory/{id}` — read one
- Response: `200` + full `<Product>`. Image slots, if present, carry the
  resolvable `url` (C7) — the QA assertion "image URLs are accessible" means
  a `GET` on that URL returns the bytes with the declared `content-type`.
- Unknown id: `404 NOT_FOUND`.

### 3.4 `PUT /inventory/{id}` — update (independent partial fields)
Request body: **any subset** of
`{ name?, brand?, base_unit?, serving_size?, serving_label?, macros_per_100?,
prices?, images? }`.
- `prices` in a PUT body is treated as **full replacement** of the price list
  (simpler than a delta protocol). Any entry missing an `id` is created;
  any entry present in DB but not in the request is deleted. The server
  stamps `captured_at` on new entries the client omitted.
- `images` in a PUT body: each slot may be an `ImageSlot` (with `url`
  pointing to an already-uploaded file — see §3.7 for the upload route)
  or the literal `null` (clears the slot).
- Unchanged fields are preserved (server-side merge on read-modify-write).
- Response: `200` + the fully updated product; `updated_at` bumped to now.
- Unknown id: `404 NOT_FOUND`. Conflict: last-write-wins on concurrent PUTs
  (the QA plan's concurrency test).
- **Validation rule:** if the PUT omits `macros_per_100` but the stored
  product already has one, keep it; if it's omitted and the stored product
  has none, return `400 VALIDATION_ERROR` (a product without macros is
  unaggregable).

### 3.5 `DELETE /inventory/{id}` — delete
- Response: `204 No Content`.
- Side effects: remove the product DB row, remove both image slots' files
  under `<MEDIA_ROOT>/inventory/{id}/`, and orphan any
  `ingredient_reference` that points at it (the macro function surfaces a
  warning in that case, per §6 `PRODUCT_NOT_FOUND`).
- Unknown id: `404 NOT_FOUND`.

### 3.6 (Internal) `macro_count(recipe_ingredients: [ingredient_reference]) -> MacroResult`
This is NOT an HTTP route in the MVP (it is a service function; the QA task
exercises it via a thin wrapper or by importing it). Return contract in §5.
The developer exposes a `POST /api/v1/inventory/macros/count` convenience
route that calls this service — the body is `{"items":[ingredient_reference,...]}`,
the response is the `MacroResult` below (`{totals, per_ingredient, total_cost, warnings}`).

### 3.7 `POST /inventory/{id}/images/{slot}` — upload an image
- `slot` ∈ `product_photo | label_photo`.
- Multipart `file` = the image; optional `filename` (original name).
- Accepted content-types: `image/jpeg`, `image/png`, `image/webp`.
- Max size: **10 MB** (QA's oversized-file test expects a `413 PAYLOAD_TOO_LARGE`).
- Response: `200` with the `ImageSlot` object (per §1.1 shape).
- Repeating an upload to the same slot **replaces** the previous file and
  overwrites the slot metadata (last-write-wins).
- Non-image file: `415 UNSUPPORTED_MEDIA_TYPE`.
- Over 10 MB: `413 PAYLOAD_TOO_LARGE`.

---

## 4. Macro aggregation — algorithm (normative)

Function signature (service layer; language not fixed but must match the
return contract in §5):

```
macro_count(ingredients: list[ingredient_reference]) -> MacroResult
```

### 4.1 Per-ingredient scaling
For each `ing = { product_id, quantity, unit, ... }`:

1. **Resolve product.** `P = products[product_id]`. If absent → emit the
   per-ingredient row (all-zero macros, `cost: null`) with
   `warnings += [{ code: "PRODUCT_NOT_FOUND", product_id: <id> }]` and
   continue.
2. **Pick the macro basis.**
   - `P.macros_per_100` present → `basis_values = P.macros_per_100`,
     `basis_ref = 100 * P.base_unit` (e.g. "100 g").
   - `P.macros_per_serving` present → `basis_values = P.macros_per_serving`,
     `basis_ref = P.serving_size * P.base_unit` (e.g. "150 g").
   - neither present → `warnings += [{ code: "NO_MACRO_BASIS",
     product_id: <id> }]`, emit all-zero row, continue.
3. **Convert `ing.quantity` to the basis unit** (g / ml / pcs families; see
   the conversion table in §4.5 of this document). Produce
   `q_in_basis_units`:
   - `ing.unit == P.base_unit` → `q_in_basis_units = ing.quantity`.
   - same family, different scale → apply the table (e.g. `1 kg = 1000 g`,
     `1 cup = 240 ml`).
   - different family → `warnings += [{ code: "UNITS_INCOMPATIBLE",
     product_id: <id> }]`; emit all-zero row; continue.
4. **Scale (normative).** `factor = q_in_basis_units / basis_denominator`,
   where `basis_denominator` is the quantity (in `P.base_unit`) that one
   block of `macros_per_100` covers (i.e. `100` if the basis is
   `macros_per_100`, or `serving_size` if the basis is
   `macros_per_serving`). Worked:
   - p1 (chicken breast, basis = per-100 g), 200 g used → `factor = 200/100 = 2.00`.
   - serving-based (basis = per 150 g serving), 225 g used → `factor = 225/150 = 1.50`.
5. **Per-ingredient macros.** For each `k ∈ C4` compute
   `macros[k] = r2(basis_values[k] * factor)` (C2 half-up to 2 dp).

### 4.2 Totals
`totals[k] = r2(Σ_{i} per_ingredient[i][macros][k])` — sum the **already-
rounded** per-ingredient values per field. This is the canonical reference
against the QA "within 0.1 g" tolerance (§7).

### 4.3 Cost (normative)
1. **Unit price per entry.** `unit_price(entry) = entry.amount /
   entry.pack_size`, currency stays `entry.currency`.
2. **Choose the cheapest entry per product.** Group `P.prices` by currency;
   for each currency compute `min(unit_price)`; then pick the currency whose
   `min(unit_price)` is **globally smallest**. Ties are broken by the
   currency of the **first** price entry in list order. All entries in other
   currencies are **excluded** (no FX conversion in MVP) and the warning
   `CROSS_CURRENCY_EXCLUDED` (product_id) is appended.
3. **Ingredient cost (normative).** With `unit_price(chosen)` in
   `<currency>/<P.base_unit>` and the scaling `factor` from §4.1 step 4:
   `cost = r2(unit_price(chosen) * basis_denominator * factor)`.
   - basis = `macros_per_100` → `basis_denominator = 100`.
   - basis = `macros_per_serving` → `basis_denominator = P.serving_size`.
   This equals `unit_price * (quantity used in P.base_unit)` by construction.
   Worked (p1): cheapest `2.99/400g = 0.00748 USD/g`; `cost =
   0.00748 * 100 * 2.00 = 1.4958`, r2 → **1.50 USD** (matches §5.3).
   If `P.prices` is empty → `cost = null`.
4. **Total cost.** `base_currency` = the chosen currency of the **first**
   resolved ingredient that has a price. `total_cost.amount = r2(Σ cost over
   all resolved ingredients whose chosen currency == base_currency)`.
   Ingredients whose chosen currency differs are excluded and each emits a
   `CROSS_CURRENCY_EXCLUDED` warning. `total_cost = null` when no resolved
   ingredient has any price.

### 4.4 Return shape (normative JSON)

```
{
  "totals": {
    "calories": number, "protein": number, "fat": number,
    "carbs": number, "fiber": number, "sugar": number, "sodium": number
  },
  "per_ingredient": [
    {
      "product_id": string,
      "name": string | null,
      "quantity": number,
      "unit": string,
      "macros": MacroBlock,           // r2 per §4.1
      "cost": number | null,          // r2, in the §4.3 currency
      "warnings": [ "PRODUCT_NOT_FOUND" | "UNITS_INCOMPATIBLE" | "NO_MACRO_BASIS" ]
    }
  ],
  "total_cost": { "amount": number, "currency": string } | null,
  "warnings": [
    { "code": "PRODUCT_NOT_FOUND" | "CROSS_CURRENCY_EXCLUDED" | ..., "product_id": string }
  ]
}
```
All `number` fields are rounded per C2. Every ingredient in the input appears
in `per_ingredient[]` in input order — even unresolved ones (their `macros`
is an all-zero `MacroBlock`, their `warnings` is non-empty).

---

## 5. Worked reference example (the canonical test fixture)

This is the fixture both developers and QA use as the "3 sample ingredients
with known macros" baseline. The products come from `seed/inventory_seed.sql`
(see §2); the arithmetic below is canonical (C2 half-up, 2 dp).

### 5.1 Products (seed)
**P1 — Chicken breast** (id `p1`, base_unit `g`):
```
macros_per_100 = { calories:165, protein:31.0, fat:3.6, carbs:0,
                   fiber:0, sugar:0, sodium:74 }
prices = [
  { id:"pr1", amount:2.99,  currency:"USD", pack_size:400, source:"home", captured_at:... },
  { id:"pr2", amount:3.49,  currency:"EUR", pack_size:500, source:"Lidl", captured_at:... }
]
```
(USD vs EUR are deliberately mixed — exercises §4.3 cross-currency rule.)

**P2 — Basmati rice** (id `p2`, base_unit `g`):
```
macros_per_100 = { calories:349, protein:7.9,  fat:0.9, carbs:78.8,
                   fiber:2.1, sugar:0.1, sodium:2 }
prices = [ { id:"pr3", amount:5.49, currency:"USD", pack_size:1000,
             source:"home", captured_at:... } ]
```

**P3 — Vegetable oil** (id `p3`, base_unit `ml`):
```
macros_per_100 = { calories:884, protein:0, fat:100, carbs:0,
                   fiber:0, sugar:0, sodium:0 }
prices = []     // zero-price case for the QA "no prices" branch
```
**P4 — Zero-calorie sparkling water** (for the QA "zero calories" branch):
```
base_unit:"ml", macros_per_100 = { calories:0, protein:0, fat:0, carbs:0,
                                  fiber:0, sugar:0, sodium:10 }, prices=[]
```

### 5.2 Recipe ingredient list
```
[
  { "product_id": "p1", "quantity": 200, "unit": "g"   },
  { "product_id": "p2", "quantity": 250, "unit": "ml"  },   // g↔ml cross-unit on a g-basis product → UNITS_INCOMPATIBLE
  { "product_id": "p3", "quantity":   0,"unit": "pcs"  }    // ml-basis product, pcs input → UNITS_INCOMPATIBLE
]
```
For the **positive** reference the QA/dev pair should use a compatible list:
```
[
  { "product_id": "p1", "quantity": 200, "unit": "g"  },
  { "product_id": "p2", "quantity": 100, "unit": "g"  },
  { "product_id": "p3", "quantity":  10, "unit": "ml" }
]
```

### 5.3 Expected aggregate (positive list, canonical values)

Per-ingredient (r2, half-up):

| ing | scale | cal | protein | fat | carbs | fiber | sugar | sodium | cost (USD) |
|---|---|---|---|---|---|---|---|---|---|
| p1 | 2.00 | 330.00 | 62.00 | 7.20 | 0.00 | 0.00 | 0.00 | 148.00 | **1.50** |
| p2 | 1.00 | 349.00 | 7.90 | 0.90 | 78.80 | 2.10 | 0.10 | 2.00 | **0.55** |
| p3 | 0.10 | 88.40 | 0.00 | 10.00 | 0.00 | 0.00 | 0.00 | 0.00 | **null** |

Cost rationale:
- **p1** = cheapest of `2.99/400g = 0.007475 USD/g` vs `3.49/500g = 0.00698 EUR/g`.
  EUR excluded (cross-currency rule §4.3) → `0.007475 USD/g × 200 g = 1.495`,
  r2 → **1.50 USD**. Warning: `CROSS_CURRENCY_EXCLUDED` (the EUR entry is
  dropped from the min).
- **p2** = `5.49/1000g = 0.00549 USD/g × 100 g = 0.549`, r2 → **0.55 USD**.
- **p3** = no prices → **null** (QA's "no prices" branch).

**`totals`** (r2 of sum, §4.2):
```json
{
  "calories": 767.40, "protein": 69.90, "fat": 18.10,
  "carbs":   78.80,   "fiber": 2.10,   "sugar": 0.10,
  "sodium":  150.00
}
```

**`total_cost`** = r2(1.50 + 0.55) = `{ "amount": 2.05, "currency": "USD" }`.

> **Hand-check:** `cal` 330.00+349.00+88.40 = 767.40 ✓ ; `protein` 62.00+7.90
> +0.00 = 69.90 ✓ ; `fat` 7.20+0.90+10.00 = 18.10 ✓ ; `carbs` 0+78.80+0 =
> 78.80 ✓ ; `sodium` 148.00+2.00+0.00 = 150.00 ✓ .

---

## 6. Error codes (normative)

| HTTP | code | meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | field-level failure; `error.fields` lists the offending keys |
| 400 | `MACRO_BLOCK_INCOMPLETE` | any of the C4 keys missing or non-numeric in a `MacroBlock` |
| 400 | `UNITS_INCOMPATIBLE` | at aggregate time: `ing.unit` and product `base_unit` are in different conversion families (g-family vs pcs-family vs ml-family) |
| 400 | `PORTIONS_INVALID` | `portions` not a positive integral integer in `[1, 999]` (e.g. `0`, `-3`, `2.5`, `"4"`, `1e2`=100 valid, `1000` invalid); body carries `fields=["portions"]` (see §7) |
| 404 | `NOT_FOUND` | unknown product id |
| 413 | `PAYLOAD_TOO_LARGE` | image > 10 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | content-type not in §3.7 list |
| 422 | `UNPROCESSABLE` | type-shape mismatch (e.g. string where number required) |
| 500 | `INTERNAL` | server bug; include a trace hint in `message` |

---

## 7. Portions view (the new `portions` view feature)

> Binding: `design/PORTIONS.md`. This section is the **use case** and the
> **normative surface**; all derivation rules live in the spec. Consumer
> tasks: `t_3ba0beb1` (dev), `t_2d849968` (UI), `t_76975145` (QA).

### 7.1 Intent

The macro aggregation already returns the **whole-batch** total for one
recipe as listed. The user sometimes prepares the same list as multiple
served portions (e.g. "2 meals tonight" or "meal-prep 5"). We need a view
that also shows **how much of the batch is in one served portion**, without
changing the recipe, its quantities, or its stored product set. Portions are
a *request-time view parameter* — nothing is persisted.

### 7.2 Surface

**Request** — `POST /api/v1/inventory/macros/count` body gains one optional field
(alongside the existing `items[]` array):

| field | type | required | default | constraints |
|-------|------|----------|---------|-------------|
| `portions` | integer | no | **1** | `1 ≤ portions ≤ 999`; must be integral; else `400 PORTIONS_INVALID` |

**Response** — add two keys to the existing `{totals, per_ingredient,
total_cost, warnings}` envelope (all four existing keys stay byte-for-byte
identical when `portions` is omitted):

| key | type | rule |
|-----|------|------|
| `portions` | integer | echoes the **effective** integer used (default `1`) |
| `per_portion` | MacroBlock (7 keys, same order as `totals`) | `per_portion[f] = r2( totals[f] / portions )` (C2, HALF-UP) |

`total_cost` is **not** divided — it stays the cost of the whole batch
(`design/PORTIONS.md` §7). `total_macros` / `per_portion_macros` from the
original request wording map to `totals` / `per_portion` here respectively.

### 7.3 Interaction with ingredient quantities

Portions are a **pure divisor on the finished `totals`**, not a re-scalar on
ingredient quantities. The engine order is fixed:

1. resolve & scale each ingredient by quantity/unit → §4.1 of this file
2. sum per-ingredient r2 values → `totals` (§4.2)
3. **only then**: `per_portion[f] = r2(totals[f]/portions)`

So: "if you batch-cook the recipe N times" → set `portions=N` and pass
`N×` the listed quantities; the engine sums and returns `totals` for N
batches, and `per_portion` = `totals/N` = one batch. **`per_portion` is
always `1/N` of the batch totals**, by construction.

### 7.4 Edge cases (normative — `design/PORTIONS.md` §5)

| case | treatment |
|------|-----------|
| `portions` omitted | default `1`; `per_portion == totals` field-for-field |
| `portions: null` | treated as omitted → `1` |
| `portions: 0`, `-3`, `2.5`, `"4"`, `1000` | **reject** with `400 PORTIONS_INVALID` (do NOT clamp or round) |
| `portions: 100`, `6` | valid; `per_portion` is the `r2(totals/N)` split |
| `portions: 1e2` (=100) | valid; echoed as integer `100` |
| `portions: 7.5` | reject (must be integral) |

**Upper bound: `PORTIONS_MAX = 999`** (single source:
`backend/app/inventory/validation.py`). A user who prepares >999 portions
should split across meals, not into one batch.

### 7.5 Canonical worked reference (reuses §5.3 batch)

Using the §5.3 canonical batch totals (`cal 767.40, prot 69.90, fat 18.10,
carbs 78.80, fiber 2.10, sugar 0.10, sodium 150.00`) — **do not re-derive
these, use them verbatim as inputs**:

| `portions` | calories | protein | fat | carbs | fiber | sugar | sodium | total_cost |
|-----------|----------|---------|-----|-------|-------|-------|--------|------------|
| 1 | 767.40 | 69.90 | 18.10 | 78.80 | 2.10 | 0.10 | 150.00 | **2.05 USD** (unchanged) |
| 4 | **191.85** | **17.48** | **4.53** | **19.70** | **0.53** | **0.03** | **37.50** | **2.05 USD** |
| 6 | **127.90** | **11.65** | **3.02** | **13.13** | **0.35** | **0.02** | **25.00** | **2.05 USD** |

The §5.3 numbers are the input; the `per_portion` row is the **exact**
`design/PORTIONS.md` §8 table (verified against the live solin-dev engine,
`r2(totals[N]/portions)` with `ROUND_HALF_UP`). `total_cost` is invariant
across `portions` values — a regression guard QA asserts.

### 7.6 Service signature (normative)

The existing engine on `solin-dev` is
`aggregate_macro_result(ingredients, products=None)` and a thin wrapper
`macro_count(ingredients)`. Extend both with a trailing `portions: int = 1`
keyword; validate **before** aggregation (E3–E7); on failure raise the
existing 400 error path with `code=PORTIONS_INVALID`. Existing callers
pass `portions=1` and see the same result **plus two additive keys**
(`portions`, `per_portion`). No change to `per_ingredient`, `total_cost`, or
`warnings` computation.

---

## 8. Seed data (developer `t_152cdcdb` writes; QA `t_06d48239` verifies)

File: `seed/inventory_seed.sql`. Must create the **P1–P4** products from §5.1
with the exact macro and price values so that the §5.3 worked example is
reproducible end-to-end. Two products must carry two image slots (product
photo + label photo) — QA asserts `GET <image.url>` returns the declared
`content-type` and non-empty body.

## 9. Open decisions (already resolved by this contract)

- **Price replacement on PUT = full-list replacement** (§3.4).
- **Cross-currency in cost = first-currency-wins, others excluded + warning** (§4.3).
- **`pcs` ↔ `g/ml` conversion is not derivable** → `UNITS_INCOMPATIBLE`;
  `slice`/`cloves` map to `pcs` (documented) (§4.1.1).
- **`macros_per_100` is the primary basis; `macros_per_serving` is optional
  and used only when `macros_per_100` is absent** (§4.1).
- **Media under `<MEDIA_ROOT>/inventory/{id}/{slot}/`** (§2, C7).
- **Rounding = half-up 2 dp** (C2), tolerance 0.1 g for QA comparison.
- **`captured_at` for a new price entry is server-stamped when omitted** (§3.4).
- **Concurrent PUTs = last-write-wins** (§3.4; QA concurrency test).
- **Portions = view-only request parameter** (`portions`), not persisted. (§7)
- **Effective range `[1, 999]`**, integer only; **default 1** (equivalent to
  current behavior). Single source of the bound:
  `backend/app/inventory/validation.py` `PORTIONS_MAX = 999`. (§7,
  design/PORTIONS.md §2 E1)
- **Response key names (canonical)** — `per_portion` (MacroBlock) and
  `portions` (integer echo). The original task's loose naming
  `per_portion_macros` / `portions_macros` maps to these names. Deviations
  require a comment on the parent task. (§7.2)
- **`per_portion` is a pure divisor of the already-computed `totals`** — no
  secondary macro basis is consulted, `per_ingredient` rows are unchanged,
  `total_cost` is not divided. (§7.3, design/PORTIONS.md §4–§7)
- **Engine extension = trailing `portions: int = 1` kw on
  `aggregate_macro_result(ingredients, products=None)` and on
  `macro_count(ingredients)`** — not a new function, not a new endpoint.
  Validate before aggregation; 400 `PORTIONS_INVALID` on failure. (§7.6,
  design/PORTIONS.md §3)
- **Invalid `portions` values are rejected, never clamped or rounded.**
  (`0`, `-3`, `2.5`, `"4"`, `7.5`, `1000` are all `400 PORTIONS_INVALID`
  with `fields=["portions"]`; `1e2`=100 is valid.) (§7.4)

## 10. Explicit non-goals (MVP)

- Currency normalisation across `total_cost` (see §4.3).
- A separate `ingredient` table — the reference lives on the recipe object.
- Search / filter beyond `name` substring.
- Authentication/authorization on these endpoints (none in the codebase today).
- Batch multi-product create / delete (one `DELETE` per product id only).
- **Portions persistence.** `portions` is a request-time view parameter only;
  it is never stored on the product, recipe, or macro result. (§7)
- **Portion re-derivation.** `per_portion` is always computed as
  `r2(totals[portions])/portions`; no secondary macro basis is consulted for
  per-portion values. (§7.3, design/PORTIONS.md §4)
- **Cost re-derivation.** `total_cost` stays the whole-batch cost; the cost of
  "one portion" is not broken out. (§7)
- **Per-ingredient macro re-split** into per-portion values. (Portions act
  only on the summed `totals`; `per_ingredient` rows are unchanged.) (§7.3)
- **Clamping / rounding of a bad `portions` value.** Invalid input is always
  a `400 PORTIONS_INVALID` (E3–E7); we never fall back to a "nearest valid
  integer." (§7.4, design/PORTIONS.md §5)

---

## 11. Custom "extra" ingredient items + pairing block at the bottom (t_e2572497, ask t_138c1717)

Normative contract for t_5721a2dd (calc/data layer), t_a411a23e (UI + layout)
and t_0b3310dc (QA). It supersedes the inner-card placement note of
t_d6c25424 where they conflict: the card's INNER arrangement (result block
directly under the Számolás row) does NOT change — the whole card MOVES.

### 11.1 Current behavior (code-verified, dev@33a4709)

- Recipe detail renders, in order (app/detail.js `render()`): video → title +
  actions → description → default macro cards (`macrosPerServing`) →
  ingredients checklist (`#ing-list`) → pairing card (`#pairing`,
  app/pairing.js) → "Elkészítés (videó-szinkron)" steps (`#step-list`).
- Pairing rows exist ONLY for recipe-declared ingredients, and every row can
  only pair to an inventory product (picker or Auto-párosítás).
- `collectItems()` sends only rows that have `product_id` + amount; the
  engine resolves macros + price per product (§4). Anything not in the
  ingredient list cannot be added, priced, or counted at all.

### 11.2 Desired behavior — custom extra items ("Egyéb hozzávaló")

R1 (entry control). One "＋ Egyéb hozzávaló" chip in the pairing card's
  `.pg-actions` row adds an UNLIMITED number of custom rows (independent of
  the recipe's ingredient list and of inventory). Each custom row has its own
  "×" delete. "Kiválasztott termékek törlése" stays product-pairing-only:
  it must NOT clear custom rows.

R2 (custom item fields — required shape). A custom row captures:

| field   | type                         | required            | bounds / notes |
|---------|------------------------------|---------------------|----------------|
| name    | text                         | yes                 | 1–80 chars after trim |
| quantity| number                       | display-only, optional | > 0 |
| unit    | free text (datalist g, kg, ml, dl, db, szelet, szem, evőkanál, teáskanál) | display-only, optional | ≤ 10 chars; NOT unit-family-gated (rule 2 keeps display-only values out of scope) |
| price   | number + currency (default HUF; may be edited, `^[A-Z]{3}$`) | optional | > 0; amount = TOTAL price of the used quantity (not per unit / not per 100) |
| macros  | the 7 MacroBlock fields (kcal, P, C, Z, rost, cukor, Na) | optional | each 0–9999, ≤2 dp; values are TOTALS for the used quantity (not per 100) |

Rationale (decision, do not re-decide): a custom item models "that one thing
I threw into the pan" — for groceries the user usually does not know
per-100 g data, so requiring a basis + unit reconciliation would recreate the
UNITS_INCOMPATIBLE/NO_MACRO_BASIS class of friction this feature exists to
avoid. Absolute totals + display-only quantity/unit keep the row
server-verifiable without inventing a second unit family.

R3 (invalid input is never silently repaired — §9 no-clamp spirit). Client:
an invalid value (negative price, `abc`, empty name with values present)
marks the row red, toasts once, and EXCLUDES the row from the next count;
nothing is clamped to 0 and nothing is dropped silently. Server (API
producers other than this client): same violations → 400 `CUSTOM_ITEM_INVALID`
(§11.4). An empty-name row with values is excluded client-side, never sent.

R4 (compatibility). Existing flow unchanged: unpaired ingredient rows are
counted exactly as before; custom rows are strictly additive and never
replace a paired row.

### 11.3 Effect on totals (normative math)

- Custom row enters the same `per_ingredient[]` array as paired rows, in
  USER-ENTRY order AFTER all paired rows (display: under a "Egyéb hozzávalók"
  sub-label inside `#pg-rows`).
- Its `macros` block is the verbatim typed totals (already ≤2 dp → no
  re-rounding); its `cost` is `r2(price)` when a valid price was entered,
  else `null`. Row carries `"source": "custom"` (additive key; UI may tag it
  `egyéb`).
- §4.2 totals rule unchanged: `totals[k] = r2(Σ already-rounded rows)`.
  §4.3/§7 cost rules UNCHANGED and apply to custom rows too: a custom `cost`
  joins `total_cost` only when its currency equals the §4.3 `base_currency`
  (first priced item, usually USD from a paired product); a custom price in a
  foreign currency is excluded and emits the per-row `CROSS_CURRENCY_EXCLUDED`
  warning, never a silent sum. A custom-only batch (no paired rows) sets
  base_currency = the custom row's currency. Custom never participates in
  `per_portion` math differently — portions still divides the recomputed
  `totals` (and `total_cost`), per §7.3.
- Count guard: if only invalid custom rows remain, count is REFUSED
  (client "add or fix at least one item", then §3.6 `VALIDATION_ERROR`).

### 11.4 API / data contract changes (additive only)

Request `POST /api/v1/inventory/macros/count` — `items[]` gains a variant
item (discriminator `type`, mirrors §1.3 ingredient_reference):

```
paired (unchanged): { "product_id": "p1", "quantity": 200, "unit": "g", "name_override"? }
custom (new):       { "type": "custom", "name": "Chilipehely", "quantity": 5,
                      "unit": "g",                      // optional, display-only
                      "price": 1.2, "currency": "HUF",  // both optional
                      "macros": {7 MacroBlock keys, totals-for-the-quantity} }
```

Response (same §4.4 shape + additive keys): custom rows appear in
`per_ingredient[]` with `"source":"custom"`, verbatim macros, `cost:r2(price)`
or null; empty `unit` renders `—`; totals `total_cost`, `per_portion`,
`per_portion_cost` recompute over the new totals per §7/§11.3.

Server validation → 400 `CUSTOM_ITEM_INVALID` `fields=[<bad field>]`, raised
BEFORE aggregation (same ordering as PORTIONS_INVALID): name empty/>80, any
macro key ∉ [0,9999] or >2 dp, price ≤ 0, currency `^[A-Z]{3}$`, quantity ≤ 0.
A count whose item list is non-empty but has ZERO computable rows (all
custom+invalid) → 400 `VALIDATION_ERROR`, no 200-with-zeros.

Local persistence (localStorage `solin.pairings.v1` → **v2**, version-key bump
so v1 readers never see foreign rows): `{name, product_id|null, amount, unit,
note, source:"custom"|undefined, price, currency, macros}`; a v2 file with
`"source":"custom"` rows saves/loads/round-trips; legacy v1 files remain
readable (missing `source` ⇒ paired row).

### 11.5 Layout change (recipe detail vertical order)

New bottom-to-top on mobile (≤768 px, single column): … → ingredient
checklist → instructions (steps) → **pairing card incl. #pg-result + portion
selector**. The recipe detail is ONE flat `article#recipe-detail` (no column layout —
`.detail-wrap`/`.recipe-grid` don't apply here), so the change is literally
the template order in `detail.js render()` + the `Pairing.renderCard` call
site. Mobile and desktop share that order; QA spot-checks both (390 px,
1280 px) for scroll height and no horizontal overflow. The pairing card's
internal order (actions → portions → result → rows) is UNCHANGED — this move
supersedes t_d6c25424's "section second-from-bottom" placement, not its
inner-card rule. `#pg-result` keeps growing in place (t_d6c25424 "Scroll"
criterion now applies to the new bottom section).

### 11.6 Acceptance criteria (QA t_0b3310dc)

A1 Add ≥2 custom rows to r1 with known price+macros → they count, totals =
   §4.2 sum including them, per-portion split divides the new totals,
   per-portion price = r2(new total_cost/portions).
A2 Worked fixture (fixture-2): §5.2-positive pairings (p1 200 g, p2 100 g,
   p3 10 ml) + ONE custom row entered verbatim — name "Chilipehely",
   quantity 5, unit "g", price 0.35 USD, macros block (totals for the
   5 g, NOT per-100) {calories:15.90, protein:0.67, fat:0.87, carbs:2.83,
   fiber:1.36, sugar:2.10, sodium:1.50} →
   per_ingredient[3].cost = 0.35 USD, source "custom";
   totals = {calories:783.30, protein:70.57, fat:18.97, carbs:81.63,
             fiber:3.46, sugar:2.20, sodium:151.50}  (sum-of-rounded §4.2);
   total_cost = 2.40 USD (1.50+0.55+0.35 — custom cost joins because
   currency == base_currency); with portions=4 → per_portion
   {195.83, 17.64, 4.74, 20.41, 0.87, 0.55, 37.88} (HALF_UP 2dp) and
   per_portion_cost = 0.60 USD. Currency-split repeat: same row with price
   1.20 HUF → custom cost EXCLUDED from total_cost (2.05 USD) + per-row
   cross-currency warning (custom rules §11.3; base currency rule §4.3).
A3 r1 without custom rows byte-identical to pre-change response (regression).
A4 Instructions section sits above the pairing card at 390 px and 1280 px
   widths; pairing card is the last block; no horizontal scroll.
A5 Custom row deletion, reload persistence (v2), Auto-pár / clear-products
   do not touch custom rows; invalid entries surface red+toast (client) or
   400 `CUSTOM_ITEM_INVALID` (server); zero-valid-items count refused.

## 12. Non-goals added (MVP)

- No auto-pair, substitute-lookup, or unit-conversion for custom rows.
- No editing inventory products from the pairing card (custom ≠ product).
- No per-100 macro basis for custom rows (totals-only, R2).
- No cross-currency aggregation (custom price obeys §4.3).


## Section 13 — Inventory quick-select & seed-batch contract (v14 restatement, t_47f009f1, 2026-10-18)

> This section was drafted and re-anchored on one read-through of the CURRENT tree:
> cross-module rules reference only live modules/suites/files in this tree, never an
> off-tree chain, secret marker path, or compressed-copy reference pack (no such
> quote or §5.2-spec connector exists in this tree — verified by search this run;
> trust this file first). Cluster-marker policy: §13 minted no `=====MARKER=====`
> (the census ran on a discarded draft, never on this file — do not "re-run"
> it); this file holds exactly zero marker markers (search them as five equals
> signs); no run may interpret one, for any reason. Seed counts and labels
> never mirror copied package content either.
> Cluster rules here RESTATE the live spec clusters whose current content I verified
> on disk while drafting (§5.1-§5.3 listings, §6, §7, §11, §12); where wording differs
> from a cluster this section treats that content as the drift to fix (§13.7).

### §13.1 Entry-model (three kinds per ingredient slot — every slot is exactly ONE)

1. **pairing** — exactly one pinned §5.2 entry-list block (contiguous `p` → row 1;
   `r3` rule preserved; unit omitted ⇒ ingredient-IDENTITY lookup only, §13.3). Its
   transcribed pair-values are ported to the fill+re-fill fixture feeds (§13.7):
   format changed, totals unchanged; value/symbol verification is NOT delegated —
   dev/QA re-read the live pairing protocol; differ → STOP + record, never guess.
2. **fast** — any non-§5.2 formula (slot pins kept only while singular — a slot
   pins both a pairing and any else → PAIRING_CONFLICT, 400; instruction strings
   in "count"/"filling"; own-ingredients stay literal labels, never resolution
   candidates). Hard rule: NO unit symbol anywhere, including the "count" section
   (it belongs to §13.2 = pairing INPUT; guard stays VISIBLE — do not re-comment it).
3. **quick** — tracker-typed-and-accepted entry (pairing = 10). Key conflict on the
   SELF ingredient (name, chain, topline_target removed, id removed).

- A slot quick when a pairing pins, keeps the pairing label and moves to the used
  list (pinned stay; self identical → only conflict slot member remains).
- quick entries NEVER participate in §4 math — entry level AND slot level.
- empty = no macro > 0 AND no price ⇒ never counted.

### §13.2 Request payload & session (normative)

- Raw `__seedReplay` → natural §§, space-separated (§5.2 cluster; §§ >720 px window
  only, both pages, toggle via `+ Hozzávaló a termékeimből`; §§ <720 px = dialogue,
  sees FULL list = ALL-fail input).
- `fill_ingredients` input = "pick ingredients" + one-key list-quit (de-select = same),
  set to REFILL; own-ingredient fast section removed; once-pinned §5.2 anchors and
  their format that use keys PRICES — seed unit is auto-count, never unit picker.
- Tracker payload = exactly seed+`count` (chat builder removed; `__seedReplay` flag)
  and ONE IN-CALL, never mixed with `seedReplay` (even empty) and never inside a
  §5.2-batch call. Seed sessions emitted once, fixed, strictly-after §5.2 anchors,
  one trigger-validated pairing pinned, §5.2 input; no multi-file script or
  single-file run mixes the pinned pairs.
- Count guard, normative: batch refused when items are non-empty and EVERY entry is
  input-blocked/formula-missing/product-unknown (tracker-sent entries would break the
  result-card clean non-blocking case; guard stays, writer starts new-page only),
  handled via tracker exclusion (negative/zero qty, missing/unknown unit — slot-singular
  pairings §13.3, marker kept) → NOT sent; UI invalid, toast once; paired pairing
  slots unaffected; the clean-pairing cause keeps its §5.2 input pairing untouched.

### §13.3 Unit resolution — ONE table, client-side

- Resolver input (non-default units only): mass g/kg/mg + tablespoon + teaspoon;
  liquid ml/l + cup; count pcs/slice/cloves.
- Family ≠ product's → `UNITS_INCOMPATIBLE` (pairing routes; §6/§9 CLAMPED PATHS, NEVER CLAMP).
- Default quick amount: pairing-slot amount (singular slot only) else §5.2-level
  default when its unit maps the same family, else quantity+unit default + unit picker.

### §13.4 App-facing input-surface layer (direct) — append notes

- Test chain run: `node app/tests/portions.spec.js`-style (browser shims, `__test`
  hooks; serverless, bring-your-own-data; probes are python; `tests/scratch/` is
  historical scratch — never the QA chain) — `app/tests/custom_items_data.spec.js`
  reads today as pure unit-test (serverless, no seeded pairing): if any harness
  elsewhere claims to feed it §5.2-style pairs, that harness is DEAD — cite a
  live-relative locator or NONE, never a guessed filename; keep the verb chaining
  (collect→fix→resolve→send). `app/pairing.js`/`app/inventory.js` carry §5.2-era
  input rules (re-verify by grep, NOT by memory, when you get to them).
- Interceptor read rule: read back (not once-read), set active/tag or block every
  read entry (all-blocked → batch failure, §13.2), §5.2 pairing items stay active, §13.1
  merge checks keep priority, deliver → listener; re-anchor is take-offs only.
- Numberless tag (PRD rename) rule: read it back BEFORE every rename (never a
  once-read list, never listed-numberless, never section-page-name). Both v14 E2E
  pages now start fresh — the old §5.2-style listing and its trailing clause are
  replaced by §13.1–§13.3; the trailing clause was not seeded, so no §5.2 seed
  keys exist here (a fresh suite carries none; do NOT re-create the removed
  cross-pair case). Reference tokens are zero in this tree (verified by search).

### §13.5 Resolution flow (one step by code location)

1. Read entries → §13.2 matching (empty entries discarded); `count`/`filling` literals are
   read nowhere else than §13.2's match rule.
2. Split unit off a compound amount (split-with-unit-labels ONLY; unitless → default
   unit); empty = pairing-page default unit; the custom DEFAULT-UNIT removal and the
   `p:`-key format (fast-own) are SPLIT elsewhere (`sp` text end) — never re-merged here.
3. Unit resolution → the §13.2 drop rule (untracked written state; tracker starts written).
4. Re-verify pairing keys, then rewrite typed/singular input entries plus data-wiring
   and data-content values (re-key by the `c`/token marker; no-marker entries re-run
   from live locators per §13.4 — never from frozen external references).

### §13.6 Contract-drift canons

- ALL-non-printable batches → blanket rejection (no per-key throw; no silently mixed
  full units).
- One family-mapped unit everywhere + slot checks.
- Seed counts use their own §13.2 formulas (no value mirroring — remove any mirror).

### §13.7 Fixture & seed-fact re-anchoring (written from current-tree evidence)

- V-SUITES live chain base: `app/tests/portions.spec.js`, `custom_items.spec.js`,
  `custom_items_data.spec.js`, `scale.spec.js`, `probe_live_portions.py`, plus the
  fixture pair `tests/fixtures/PORTIONS.json`/`PORTIONS.md` (per module block,
  §13.4). No seeded block with paired pairings, no seed-provider-style helper, and
  no fill-ingredients E2E suite exists in this tree — full-tree file search AND
  harness-key search (main_recipe, seed_fields, %RESOURCE:, slotKey, sizeConflicts,
  seed_family: zero hits) ran THIS attempt; any page or harness quoting such
  anchors is delegated-prompt STALE, not tree fact (re-anchor rule, §13.4). A
  fresh suite carries NO seed keys and reads its data from the live scripts.
- V-SUITES run `node`-style with shims (serverless, bring-your-own-data);
  E2E-shaped scripts ride on them — dev converts, no separate E2E harness or
  external seed helper to set up. `checks/` is dead; `tests/scratch/` is
  historical, not a suite.
- Only trigger-valid pairings get seeded, and a seeded pairing is UNIQUE per
  filler; §5.2-style pair literals, where any suite lists them, get replaced by
  the §13.2 values FIRST (one batch never mixes pinned pairings with
  tracker-typed quicks — two calls, per input §13.2; §5.3's own-keys layer is
  carried by the 876d831→§13.2 flip, not mirrored as values; "No cross-currency
  aggregation" and §5.2's "a pinned multi-entry test" rule outrank old-wording).
- Seed pairing followers rerun from the REWRITTEN feeds, never on frozen pasted
  pairings (pairing and custom seeds rerun, including seeded multi-count cases).
- Counter-facts (verified this attempt): `tests/use-cases-validation-sections.md`
  is ABSENT — a fresh suite gets no self-check keys; the §5.3 "portions-canonical"
  and "fill-ingredients-all-inputs-fail-all-blocked" titles are intact in the
  live suites (counts limited to actually-seeded pairings); empty quick select →
  zero display and a toast (claim = once-read reference, rerun matches this);
  seed pins ride real routes (double-anchor block carries cold route; one seed
  per one-section page; pairing+special-listed pairs may co-exist in one slot —
  the §13.1-type conflict pair is ONE set per test; seedReplay is one step then
  goes OFF-TRACK: seeding and freezing default amount can't change a count).
- Full-list rule (grammar fixed by rerun): seed by text or whole-recipe seed on
  the no-data product; FULL LIST HIDDEN; sections exist and are full only when no
  section matched (full = 0; empty: sections and full exist and section-full
  fails — count dominates); sub-blocks match by ingredient-name `:has()` NOT by
  document-body marker; one §5.2-style batch seeds BOTH sides, §13.7 anchor blocks.

### §13.8 E2E verification & hotspots

- **Trigger chip** (cascade `+ Hozzávaló a termékeimből`; `m` = toggle; >720 px only,
  both pages).
- Drill-down; re-fill of one active; blocked > tag; unknown → blocked body; seed on
  the hydration write (final blocker `<b>`/`;` — risk sits in the tracker-internal key
  check, dev-owned); refills and seed double-slots are SHORT-STATE (no fixed sleeps;
  toasts, relative rulings — timeouts, matchers stop at the blocker reading; pages
  re-key on count/accept/reject; empty queries never run; §13.4 hit-cell answers
  stay untracked, up to ONE page, call + db-click count-stops, `seedReplay`/`count`
  in one case).
- Hotspots — unique living anchors; each a one-desk board, do NOT let any step pin
  anything the engine offers (trigger-validity ≠ pin-validity) and never re-pin a
  §5.2 seed key because a "Protocol Case No" clause once mentioned it (that clause
  is DEAD here — engine truth: paired items CO-EXACT defaults, or typed count does
  nothing): `app/pairing.js` §4.1 — the pinned/§13.2-fast paths split on conversion
  (price select in the non-branch); §13.2 chain refs and the §13.1/§6 branches sit
  ABOVE one non-fixable, non-thrown case — live content must be RE-READ before
  being rewritten; section count/line ranges frozen. `tests/test_custom_items_endpoint.py`
  — lives WITHOUT seeded pairings (its own keys cover mixed paired+custom batches,
  "zero-valid batch → 400 VALIDATION_ERROR (never 200-of-zeros)", invalid-custom-first);
  rerun it from rewritten feeds. `tests/test_inventory_unit.py` — no live-engine
  seed anchor named inside (all-off-track supplier references dead per §13.4; do
  NOT seed from file names; "2% Roastment" means an off-track supplier label like
  any other); write the fresh suite before switching, then grep §5.3/§13.7 twice.

--- END OF SECTION 13 ---
