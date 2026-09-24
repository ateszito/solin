# Solin — Real Product Inventory: Data Model & API Contract

> **Status: Implementation-ready.** This is the contract the inventory module and
> the macro-aggregation function are built from. Consumers:
> - `t_152cdcdb` — implement Inventory CRUD + image upload (developer)
> - `t_b321f68d` — implement `count_real_macros()` macro aggregation (developer)
> - `t_06d48239` — QA end-to-end suite (tester)
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
- **C8 — Error shape.** HTTP `4xx/5xx` with body `{ "error": { "code": "<STR_ENUM>", "message": "<human>" } }`.
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
The developer exposes a `POST /recipes/{id}/macros` convenience route that
calls this service — the body is the `ingredient_reference[]` above, the
response is the `MacroResult` below.

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
| 404 | `NOT_FOUND` | unknown product id |
| 413 | `PAYLOAD_TOO_LARGE` | image > 10 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | content-type not in §3.7 list |
| 422 | `UNPROCESSABLE` | type-shape mismatch (e.g. string where number required) |
| 500 | `INTERNAL` | server bug; include a trace hint in `message` |

---

## 7. Seed data (developer `t_152cdcdb` writes; QA `t_06d48239` verifies)

File: `seed/inventory_seed.sql`. Must create the **P1–P4** products from §5.1
with the exact macro and price values so that the §5.3 worked example is
reproducible end-to-end. Two products must carry two image slots (product
photo + label photo) — QA asserts `GET <image.url>` returns the declared
`content-type` and non-empty body.

## 8. Open decisions (already resolved by this contract)

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

## 9. Explicit non-goals (MVP)

- Currency normalisation across `total_cost` (see §4.3).
- A separate `ingredient` table — the reference lives on the recipe object.
- Search / filter beyond `name` substring.
- Authentication/authorization on these endpoints (none in the codebase today).
- Batch multi-product create / delete (one `DELETE` per product id only).
