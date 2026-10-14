# RECIPE_SCALING — „Ha ennyi van, mennyit kell hozzá?"

- **Task / status:** `t_054bf7d4` · ready → running · design spec (v1)
- **Use case:** `UC-07` — canonical reference: [`../use-cases/TIKTOK_STUDIO_RECIPES.md`](../use-cases/TIKTOK_STUDIO_RECIPES.md) „UC-07 — Scaling …"
- **Index:** [`../../use_cases.md`](../../use_cases.md)
- **Scope:** deterministic recept-skálázás az **meglévő** skémára + seedre + frontendre építve. Nem új architektúra, nem backend-átfestés — a modell már van, ezt a spec a viselkedést és a szabályt zárja le.

---

## 0. TL;DR

Egy receptből egy **anchor** ösztevő (tömegben mért, g/kg) megadott elérhető mennyiségéhez **egyetlen skálázási együtthatót** számolunk: `f = elérhető / anchor.base` (pontos, nem kerekített). Minden `scalable` ösztevésként `base × f`, **per-unit kerekítéssel** (tömeg 2 tizes, folyadék 1 tizes, darabos egész ≥1). Nem skálázható (``ízlés szerint`` / ``jódag`` / tartomány / szöveges) → az **alap változatlan**, manuális jelzéssel. Összesen **egy** szabály, determinisztikus, visszavethető; a UC-07 minden számja ebből adódik.

### Pipeline

```
[recept.ingredients]  --legnagyobb tömegű g-ös-->  anchor
        |                                             |
        |                                       f = avail / anchor.base   (Decimal, ROUND_HALF_UP)
        v                                             |
  per ingredient:  scalable? --nem-->  [alap, MANUAL jelzés]
        | igen                                   (to taste / jódag / tartomány / szöveg)
        v
   base * f  -- round-half-up per unit class -->  [új mennyiség]
   (g/kg/mg: 2 tizes | ml/l/cup/tbsp/tsp: 1 tizes | darabos: egész, min 1)
```

---

## 1. Mi van ma (ground truth) — a spec erre épít

| Réteg | Fájl | Összetevő-modell (tényleges) | Skálázható-e ma |
|---|---|---|---|
| **Séma** (authoritative) | [`../../schemas/recipe.schema.json`](../../schemas/recipe.schema.json) `items.required: [name, amount, unit]`; `amount: number`, `unit: string` | `name / amount(number) / unit(string)` | **Igen** — `amount` már az **alap-amount**, `unit` string |
| **DB** | [`../../schemas/database.sql`](../../schemas/database.sql) | `ingredients JSONB` (egyetlen tömb) | — (sémát követi) |
| **Backend** | [`../../backend/app/main.py`](../../backend/app/main.py) `class Ingredient(BaseModel): amount: float; unit: str`; root `/api/v1/recipes` | `{id, recipe_slug, name, amount: float, unit: str}` | **Igen** — az API-ben az `amount`+`unit` már strukturált |
| **Seed** | [`../../app/data.js`](../../app/data.js) | `{name, qty: "650 g", note?}` **szöveges** `qty`, nincs `id` | **Nem** — free-text, nem bontható megbízhatóan |
| **Frontend** | [`../../app/detail.js`](../../app/detail.js) L54–56 | checklist `data-idx="${ing.name}"`, render `<b>${esc(ing.qty||"")}</b> ${esc(ing.name)}`; `checked` per-session in-memory | renderzi a szöveget, nem számol |

**Következtetés:** backend/séma **már** `{amount: number, unit: string}` — vagyis a base-amount + unit **megvan**. A gap két: (a) a **seed/frontend** free-text `qty`-ben él, és (b) **nincs per-ösztevő `id`/slug**, a frontend a *name*-et kulcsola. A skálázás tehát **frontend-logika + seed-szabványosítás**, backend-változás nélkül (a modell már alkalmas).

> Megjegyzés a korábbi (crashelt) futáshoz: a `use_cases.md` index és a `TIKTOK_STUDIO_RECIPES.md` UC-07 szekció megvan, de **ez a fájlmag** hiányzott — most teljesíti.

---

## 2. Csontváz — canonical scaling modella

Egy skálázható recept **minden** ösztevője kell, hogy ezt a recordot viselje (ezt a széma **már** írja elő: `name/amount/unit`):

```
ingredient = {
  id          : slug | UUID  (ajánlott: determinisztikus slug, pl. "focirkeemlo" — meglévő hiány)
  name        : string       (display, nem kulcs)
  amount      : number       // BASE (alap, nem skálázott) — ez a kanonikus
  unit        : string       // "g" | "kg" | "mg" | "ml" | "l" | "cup" | "tbsp" | "tsp"
                                | "gerezd" | "db" | "szelet" | "fej" | "tojás" | "darab" | "szál"
  scalable?   : derived(unit, amount_type)  // lásd §4
  note        : string?      // opcionális
}
```

`amount` = **alap** (recipe-eredeti) mennyiség; a skálázott érték **nem** kerül vissza az `amount`-ba — az csak read-only bemenet a számoláshoz.

### 2.1 Anchor (a skálázás horgonya)

- **Definíció:** az az ösztevő (egyetlen), amely (a) **tömegben** van mérve (`unit ∈ {g,kg}`), és (b) amiből a felhasználó **megadja az elérhető mennyiséget**.
- **Determinisztikus default:** a **legnagyobb tömegű** `g`/`kg` ösztevő.
  - Ebben a receptben: `focirkeemlo` 650 g > `teszta` 240 g > `voroshagyma` 200 g > `tejszin` 160 g > … → **anchor = csirkeemlő, 650 g**. (Ez adja a `650→850→480` példát is.)
- Ha több tömeges ösztevő is lehetséges horgonynak, a felhasználó kézzel válthat (UI), de a **default mindig a legnagyobb tömeg** — így ugyanaz a bemenet ugyanazt a `f`-et mindig adja.

### 2.2 Skálázási együttható (egety)

```
f = available / anchor.base            # pontos Decimal, ROUND_HALF_UP a végkimeneten
```

Nem kerekítünk az útközben — csak a **végmennyiségeken** (§3). Így `f` pontos és visszavezethető: `f = 850/650 = 1.30769…`, `f = 480/650 = 0.73846…`.

---

## 3. Kerekítési szabály (canonical, unit-klasszok)

**Kerekítés: ROUND_HALF_UP, per-unit tizedes.** Az UI megjelenés *lehet* olvashatóbban kerekítve, de a **kanonikus (tárolt/számolt) érték** mindig az alábbi:

| Unit-klassz | Tagok (HU) | Kanonikus kerekítés | Példa |
|---|---|---|---|
| **Tömeg** | `g, kg, mg` | **2 tizes** | 50 g × 0.7385 → `36.92 g` |
| **Folyadék / térfogat** | `ml, l, cup, tbsp (evőkanál), tsp (teáskanál/tk)` | **1 tizes** | 160 g* × … → (ml lenne) |
| **Darabos / db** | `gerezd, db, szelet, fej, tojás, darab, szál, gombóc` | **egész; ha `0 < f.base < 1` → min `1`** | 3 gerezd × 1.3077 → `4 gerezd`; × 0.7385 → `2 gerezd` |
| **Nem skálázható** | ízlés szerint (`to taste`) · ``jódag`` · tartomány (`1-2 …`) · ``kb. N db`` · bármely nem parsolt szöveg | **alap változatlan + MANUAL jelzés** | ``2 to taste``, ``1 pcs`` → nem éri el |

> *`tejszin` ebben a receptben `g`-ben van (tejszín), ezért tömeg-klassz 2 tizes: 160 g → 209.23 / 118.15.

> **Kanonikus vs UI:** a **tárolt/számolt** kanonikus mindig 2 tizes (§3); a **UI render** 1 tizesre kerekít, amikor olvasható (pl. `65.38 g` → `65.4 g`). A UC-07 test-ágak **a kanonikusra** (2 tizes) tesznek claimet, az UI-ben 1 tizes látszik — ugyanaz a szám.

**Why round-half-up (nem banker's/benford):** recept-kontextusban a „fel-felé" kerekítés a felhasználó számára konzisztensebb (sose kevesebb adagot kaphat, mint a lefelé kerekítés sugallaná), és minden érték **visszavethető** az `f`-ből és az alaplövedérből (base × f ROUND_HALF_UP). Nincs véletlen.

### 3.1 Darabos al-1 eset (min 1 — csupán **darabos** egységeken)

A min-1 szabály — ha `base × f` egészre van kerekítve és a nyers érték `(0, 1)` közé esik, kerekítés **`1`-re** (nem `0`) — **kizárólag** a *darabos* egységekre (`gerezd / fej / db / tojás / darab / szál / gombóc`) vonatkozik, mert azokból nem lehet `0.4 darab`.

A **folyékony / térfogat** (`tbsp / tsp / ml / l / cup`) és a **tömeg** egységek **nem** kapnak min-1-ot — a 1 tizes (`tsp`) vagy 2 tizes (`g`) kerekítés a kanonikus, így `0.5 × 0.7385 = 0.369 tsp → 0.4 tsp` (nem `1 tsp`).

---

## 4. Mi skálázható, mi nem (determinisztikus osztályozó)

Egy ösztevő **`scalable`**, ha és csak ha `unit` ∈ `{g,kg,mg,ml,l,cup,tbsp,tsp,gerezd,db,szelet,fej,tojás,darab,szál,gombóc}` — vagyis a **mennyiség és unit szétszeparálható**.

**Nem skálázható (alap marad + `MANUAL`/manual scale jelzés):**
- `unit = "to taste"` / magyar „ízlés szerint" (`so`, …)
- `qty` / `unit` **szöveg**: ``jódag``, ``kb. 1 db``, ``1-2 gerezd``, ``½ tk``, free-text `qty` (`app/data.js` minta)
- Tartomány (`1-2 …`), közelítő jelző (`kb.`, „némi", „apró")

**Ez pontosan lezárja a korábori fokhagyma-kérdést:** ``3 gerezd`` (tiszta db-alap) **skálázódik** → 4 (850 g) / 2 (480 g); a korábbi seed mintájában lévő ``1-2 gerezd`` / ``jódag`` **nem** — alap, manual jelzéssel. Többé nem „4 vs 2 vs 1" a semmi közepette.

### 4.0 Free-text / legacy fallback (kritikus)

Amíg a seed `app/data.js` `{name, qty:"650 g", note?}` free-text:
1. A skálázó **nem próbál meg** szöveget parseolni (`"1-2 gerezd"` nem `1`-et, nem `2`-t, nem középet — **nem éri el**).
2. Nem parsolt `qty` → **alap változatlan**, UI-en **`manual`** badge.
3. Ha a seed migrál a sémára (`amount:number` + `unit:string`), ugyanaz a logika már skálázni tud. **A logika nem változik a seed formájától függően — csak annál, ami parsolt.**

---

## 5. Worked example (canonical, 2 tizes — UC-07 referenciája)

Recept: `focirkeemlos-csirkesor-babgombos` (TikTok — Studio recipes). Anchor = csirkeemlő 650 g. `f` pontos; kanonikus kérés: `g/kg/mg → 2 tizes`, `tbsp/tsp → 1 tizes`, `gerezd → egész ≥1`. Non-scalable: `so` `2 to taste`, `csili` `1 pcs`.

### 5.1 Upscale — 850 g (f = 850/650 = 1.30769…)

| Ösztevő | Base | Unit | Base × f (nyers) | **Kanonikus (half-up)** |
|---|---|---|---|---|
| csirkeemlő (anchor) | 650 | g | 850.00 | **850 g** (anchor) |
| voroshagyma | 200 | g | 261.538 | **261.54 g** |
| kolbasz | 50 | g | 65.385 | **65.38 g** |
| tejszin | 160 | g | 209.231 | **209.23 g** |
| parmezan | 40 | g | 52.308 | **52.31 g** |
| teszta | 240 | g | 313.846 | **313.85 g** |
| spinot | 80 | g | 104.615 | **104.62 g** |
| fokhagyma | 3 | gerezd | 3.923 | **4 gerezd** (gezeg) |
| paradicsompure | 3 | tbsp | 3.923 | **3.9 tbsp** (1 tizes) |
| fustolt-paprika | 1 | tsp | 1.308 | **1.3 tsp** |
| bors | 0.5 | tsp | 0.654 | **0.7 tsp** (folyékony-egység 1 tizes: 0.654→0.7; nem db-klassz, min-1 nem létesít) |
| so | 2 | to taste | — | **2 to taste** (manual) |
| csili | 1 | pcs | — | **1 pcs** (manual) |

### 5.2 Downscale — 480 g (f = 480/650 = 0.73846…)

| Ösztevő | Base | Unit | Base × f (nyers) | **Kanonikus (half-up)** |
|---|---|---|---|---|
| csirkeemlő (anchor) | 650 | g | 480.00 | **480 g** (anchor) |
| voroshagyma | 200 | g | 147.692 | **147.69 g** |
| kolbasz | 50 | g | 36.923 | **36.92 g** |
| tejszin | 160 | g | 118.154 | **118.15 g** |
| parmezan | 40 | g | 29.538 | **29.54 g** |
| teszta | 240 | g | 177.231 | **177.23 g** |
| spinot | 80 | g | 59.077 | **59.08 g** |
| fokhagyma | 3 | gerezd | 2.215 | **2 gerezd** (gezeg) |
| paradicsompure | 3 | tbsp | 2.215 | **2.2 tbsp** |
| fustolt-paprika | 1 | tsp | 0.738 | **0.7 tsp** |
| bors | 0.5 | tsp | 0.369 | **0.4 tsp** |
| so | 2 | to taste | — | **2 to taste** (manual) |
| csili | 1 | pcs | — | **1 pcs** (manual) |

> **Ellenőrzés:** ez a tábla és a `UC-07` (`TIKTOK_STUDIO_RECIPES.md` L152–154) **ugyanannak** adódik. A korábbi futás két hibás értékét (`50 g → 65.38 g` és `40 g → 50.75 g` az 480 g-os soron) a fenti 36.92 / 29.54 helyette állítja be.

---

## 6. UI szerződés (frontend, `app/detail.js`)

### 6.1 Vezérlő (recept-fejléc, a „5 adag / 20 perc" sor mellett)

```
┌───────────────────────────────────────────────────────────────────────┐
│  5 adag · 20 perc · MAGAS KOLESTERIN                                   │
│                                                                        │
│  Ha ennyi van:  [ 650  g ] csirkeemlő   [ Skálázom → ]      (×1.00)   │
└───────────────────────────────────────────────────────────────────────┘
```

- Egy **number input** („hány g van?") + egy gomb. Az input **anchor = csirkeemlő**.
- Bemeneti érték = `available` (g). `f = available / 650`.
- Ha `available < 100` vagy `> 3 × 650` → warning (de nem blokkol).
- Ha `available == 650` (default) → `f=1`, minden alap (nem skálázott látszat).

### 6.2 Output (a meglévő checklist helyett, ugyanazon DOM-ban)

- Ugyanaz a `<li data-idx=…>` lista, de minden sor:
  - `amount` (skálázott kanonikus érték, UI-render 1 tizes tömegre)
  - `unit`
  - `name`
  - **anchor** sor kiemelés (pl. `★ anchor`)
  - **manual** sor: `manual` badge + alap (nem skálázott)
- A meglévő `checked` (`Set<name>`) **per-session in-memory** állapotot fenntartjuk — **skálázás nem írja vissza** a `window.SOLIN_DATA`-ba (a skálázott érték csak a render rétegben él; a seed `amount`-ja változatlan).
- Nem tárolt: refreshre visszaáll az alap (konzisztens a `checked` handlinggel, `detail.js` L162: „Data model: unchanged … per-session in-memory").

### 6.3 Access / edge

- **Empty / null** `available` → alap látható, `f=1`.
- **Nincs skálázható tömeges ösztevő** (nem ez a recept) → a vezérlő elrejtődik, vagy az első skálázható tömeges ösztevő lesz anchor (heuristic: legnagyobb tömeg).
- **Anchor nem a legnagyobb** (pl. felhasználó `available`-t tejszín-hez ad) → az adott ösztevő horgony, `f = avail/160`.
- **Több anchor** egyszerre → nem támogatott (UI egy inputot enged).

---

## 7. Implementációs leképezés (mi változik, mi nem)

| Réteg | Változik-e | Mi |
|---|---|---|
| `recipe.schema.json` | **nem** (már jó) | `name/amount/unit` kötelező — ez a skálázhatóság bázisa |
| `database.sql` | **nem** | `ingredients JSONB` elég (per-ösztevő `id` slug opcionális, de nem blokkol) |
| `backend/app/main.py` | **nem** | `Ingredient(amount:float, unit:str)` az API-ban — a scaling **frontend-logika**, backend nem számol (kivéve: egy `/scale` POST endpoint az API-fogyasztóknak — opcionális, lásd §8) |
| `app/data.js` (seed) | **nem kötelező** | Free-text `qty` maradhat (a fallback kezeli); **ajánlott** a sémásra (`amount:number`+`unit:string`) migrálni, hogy a skálázás mindenkinél működjön |
| `app/detail.js` | **IGEN** | Skálázó vezérlő + skálázott render (új fájlok: `app/scale.js` `scaleIngredient(base, unit, f)` és `selectAnchors(ingredients)`; `detail.js` importja) |
| `docs/design/RECIPE_SCALING.md` | **EZ a fájl** | canonical spec |
| `TIKTOK_STUDIO_RECIPES.md` L152–154 | **targeted fix** | a 2 hibás 480 g-os érték (36.92 / 29.6… vldg) + canonical 2 tizes kiigazítás — a spec egyenes következménye |

**Nem csinálok architektúraváltást.** Per-ösztevő `id` bevezetése külön, opcionális hardening (lásd §10 Q1) — nem skálázás-blokkoló.
---

## 8. API contract (opcionális hardening — UC-07 test scenario L184–L185)

A design **default** frontend-logika. Az UC-07 tesztpalástja (`POST /api/v1/recipes/<recipe-id>/scale`) **a backend-et követeli**, ha az API-fogyasztó is skálázik:

```
POST /api/v1/recipes/{recipe_id}/scale
Content-Type: application/json

{ "ingredient_id": 3, "available_amount": 850 }   # available_amount > 0, unit == anchor.unit
```

**200 response** — pontosan a [§5.1 kanonikus tábla](#51-upscale--850-g-f-850650-130769) minden cellája, `unit`-tel és `slug`-gal. Nincs `Math.random()`, determinisztikus.

**400 response** — `available_amount ≤ 0`, nem numeric, vagy unit mismatch (pl. `available_amount` kg-ban, anchor g-ben). Body: `{"error": "…"}`.

**404 response** — `ingredient_id` nem létezik a receptben, vagy a recept `recipe_id` nem létezik. Body: `{"error": "not found", "hint": "GET /api/v1/recipes/{recipe_id} for valid ingredient_ids"}`.

`ingredient_id` = per-ösztevő stabil identifikátor (slug vagy integer index a `recipes`+`ingredients` táblázatban) — ez a [§4.0 data-model](#40-free-text--legacy-fallback-kritikus) requirement.

**Out-of-scope v1:** multi-anchor constraint solver (pl. "ennyi csirke AND ennyi tej") — lásd §10 Q4.

---

## 9. Acceptance criteria (tesztelő-e)

1. **Determinizmus:** ugyanaz a bemenet (`available`, `recipe`) **mindig** ugyanazt a kimenetet adja. (Nincs `Math.random()`, nincs időfüggés.)
2. **Anchor-helyes:** 650 g-os recepten `available=850` → csirkeemlő **850 g**, nem `650→850`-ra skálázva mással.
3. **Per-unit kerekítés:** `g` → 2 tizes; `tbsp/tsp` → 1 tizes; `gerezd/db` → egész ≥1; `to taste`/free-text → alap + `manual`.
4. **Min-1:** bármely `0 < base×f < 1` db-os → `1`.
5. **Visszaadás:** skálázás **nem írja** a seed `amount`-ot (refreshre alap).
6. **Ellenőrzés:** a §5 tábla minden cellája == `f` + alap ROUND_HALF_UP-ja. (Automatizált: `verify_scaling.py` workspace-ben.)
7. **Nem skálázható:** `so` `2 to taste`, `csili` `1 pcs` mindkét irányban változatlan.

---

## 10. Nyitott kérdések / out-of-scope

1. **Per-ösztevő `id`/slug?** A séma ma `name/amount/unit`; a frontend a `name`-öt kulcsola. Skálázáshoz **nem kötelező**, de ha majd a `checked`-t `id`-ra építjük, determinisztikus slug ajánlott (pl. `slugify(name)`) — **külön task**, nem skálázás-blokkoló.
2. **`available` más mértékegységben** (pl. 0.85 kg)? UI: g-ben fogad, konvertál `f` előtt. (Spec: g; a konverzió logika a `scale.js`-ben.)
3. **`/api/v1/recipes/{id}/scale?available=X` GET endpoint?** Backend **nem** köteles a scalinget kiszámolni (frontend-logika). Ha az API-fogyasztók (mobile, stúdó-app) is kérést tesznek, akkor egy vékony GET — **opcionális hardening**, külön task.
4. **Skálázás több anchorral** (pl. "ennyi csirkeÉs ennyi tej van")? Ma nem (UI egy anchor). Később: multi-constraint `f` (legszűgebb horgonnyal) — **out-of-scope v1**.
5. **Seed migrálás** `qty` → `amount+unit`? Ajánlott, de nem skálázás-blokkoló (fallback fedez). Külön task.

---

## 11. Hivatkozások

- Canonical UC: [`TIKTOK_STUDIO_RECIPES.md` UC-07](../use-cases/TIKTOK_STUDIO_RECIPES.md)
- Séma: [`recipe.schema.json`](../../schemas/recipe.schema.json) · DB: [`database.sql`](../../schemas/database.sql)
- Backend: [`backend/app/main.py`](../../backend/app/main.py) · Seed: [`app/data.js`](../../app/data.js) · Frontend: [`app/detail.js`](../../app/detail.js)
- Index: [`use_cases.md`](../../use_cases.md)

**Ez a spec a UC-07 skálázási logikájának kanonikus, determinisztikus lezárása. Minden szám visszavethető `f`-ből + alaplövedérből, ROUND_HALF_UP per-unit kerekítéssel.**
