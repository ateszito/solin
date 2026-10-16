/* ============================================================
   Solin v3 — pairing.js
   "Recept ↔ termék párosítás" — recipe–product real-macro pairing
   (task t_47368aba, dashboard ask 2026-10-06).

   What this module does (all in the recipe DETAIL view, mobile-first):
     1. Lists the recipe's ingredients.
     2. Lets the user PAIR each ingredient with a REAL product from
        the inventory (app/fcapi.js). An "Auto-párosítás" button
        pre-selects the best fuzzy-name match per row (no surprises:
        nothing is counted until the user taps Számolás).
     3. The amount+unit the user types is the REAL amount of product
        used (the recipe's listed qty is only a prefill / hint — real
        values differ from recipe amounts, which is exactly why this
        feature exists).
     4. Számolás → POST /api/v1/inventory/macros/count → real macro
        totals + per-row cost + ÖSSZES ÁR of the prepared food.
        PORTIONS (design/PORTIONS.md §2/§3/§7): a portion-count selector
        near the macro summary; per-portion values shown PROMINENTLY
        (per_portion = r2(totals / portions), HALF_UP 2 dp), whole-batch
        totals + total_cost (NOT divided) stay as a secondary block.
        Invalid values → 400 PORTIONS_INVALID, clear error message.
        The split is recomputed client-side from the fresh totals when
        the user changes the count (pure function → zero latency, no
        stale-data flashes); the request still carries `portions` so a
        portions-aware backend can echo + serve its own `per_portion`.
        The selected count persists across navigation WITHIN the recipe
        view (in-memory, per contract §12 — NOT globally persisted).
     5. A pairing (product+amounts) can be SAVED per recipe
        (localStorage) and re-loaded later (Mentett párosítás).

   Units are family-gated to the product base_unit by the backend
   (mass g/kg/mg · liquid ml/l · count pcs). The UI only offers the
   product's allowed unit family (FcApi.allowedUnitsFor) and a local
   convert-to-base for the common HU unit words — anything the engine
   still rejects surfaces as the UNITS_INCOMPATIBLE row, never a crash.

   Data: localStorage solin.pairings.v2  (was .v1 — version bumped per
   spec §11.4 so v1 readers never see custom rows; v1 stays READABLE and
   falls back on load. A row without "source" is a paired product row.)
     { "<recipeId>": { saved_at, version:2, rows: [
         {name, product_id|null, amount, unit, note}              // paired
         {name, product_id:null, source:"custom", amount, unit,
          price, currency, macros{7}}                            // custom
     ] } }

   Hungarian copy to match the app registers (detail.js / foodcounter.js).
   ============================================================ */
window.Pairing = (function () {
  "use strict";
  const { $, $$, S, esc, toast } = window.Solin;
  const Fc = window.FcApi;

  /* v2 key (spec §11.4). K1 = legacy file, still readable on load. */
  const K2 = "solin.pairings.v2";
  const K1 = "solin.pairings.v1";

  /* ---------- small shared bits ---------- */
  function fmt(v) { return Fc.fmt(v); }
  function unitFamilyOf(u) { return Fc.unitFamily(u) || null; }

  /* ---------- portions (design/PORTIONS.md — normative parts) ---------- */
  // §3: per_portion is a MacroBlock with EXACTLY these 7 keys in this order
  // (same canonical order as `totals`).
  const MACRO_KEYS = ["calories", "protein", "fat", "carbs", "fiber", "sugar", "sodium"];
  // §5: PORTIONS_MAX lives in the backend validation.py; mirror it here so
  // the UI can reject before it sends (defensive — the stepper min/max also
  // guards the happy path).
  const PORTIONS_MIN = 1;
  const PORTIONS_MAX = 999;

  /* HALF_UP 2 dp, exact (contract §6 / C2 ROUND_HALF_UP).
     Implemented with integer string math — no binary-float artifacts:
     69.90/4 = 17.475 must round UP to 17.48 (banker's would give 17.47).
     All incoming totals are already 2 dp JSON numbers, so the string is
     exact for the dividend and the quotient needs no digits beyond the
     3rd decimal. */
  function halfUp2(v) {
    if (v == null) return 0;
    if (!isFinite(v)) throw new Error("halfUp2: non-finite value " + v);
    let s = String(v).replace(/^[+-]/, "");
    const dot = s.indexOf(".");
    let ip, fp = "";
    if (dot === -1) { ip = s; } else { ip = s.slice(0, dot); fp = s.slice(dot + 1); }
    ip = String(ip || "0").replace(/^0+(?=\d)/, "");
    fp = (fp + "000").slice(0, 3);   // pad to exactly 3 fractional digits
    const d3 = (ip + fp) * 1;        // value * 1000, exact integer (< 2^53 here)
    const r = Math.floor(d3 / 10) + ((d3 % 10) >= 5 ? 1 : 0);  // HALF_UP 2dp
    return r / 100;
  }

  /* Split a canonical MacroBlock (7 keys) into per-portion values:
     per_portion[f] = halfUp2(totals[f] / n) for every f, same key order.
     Pure + deterministic → the same (totals, n) always yields the block
     the backend would return (fixture-verified in app/tests/portions.spec.js). */
  function perPortionOf(totals, n) {
    const out = {};
    for (const k of MACRO_KEYS) out[k] = halfUp2((Number(totals[k]) || 0) / n);
    return out;
  }

  /* Parse + validate the portions selector input (design §5 E1–E8):
     integral integer in [1, 999]; rejects 0, negatives, fractions (2.5),
     non-numeric and >999. Strict: the raw text itself must be an integer
     (not just parseInt-truncatable — "2.5" must FAIL, E5), only an
     optional leading +/- and surrounding whitespace is tolerated.
     Returns null (invalid) or the int — callers show a clear error,
     never silently clamp. */
  function parsePortions(raw) {
    const t = String(raw == null ? "" : raw).trim().replace(/^\+/, "");
    if (!/^-?\d+$/.test(t)) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < PORTIONS_MIN || n > PORTIONS_MAX) return null;
    return n;
  }

  const HU_UNIT_TO_FAMILY = {
    "g": "mass", "kg": "mass", "mg": "mass",
    "ml": "liquid", "l": "liquid", "pcs": "count", "db": "count",
  };
  // Local HU unit-word → canonical unit, when it belongs to the
  // product's family (evőkanál/teáskanál ≈ ml class; gerezd/db ≈ count).
  const HU_UNIT_MAP = {
    "g": "g", "kg": "kg", "mg": "mg",
    "ml": "ml", "l": "l",
    "db": "pcs", "darab": "pcs", "gerezd": "pcs",
  };
  // ml-equivalents (liquid family only):
  const ML_EQUIV = {
    "evőkanál": 15, "tbsp": 15,
    "teáskanál": 5, "tk": 5, "tsp": 5,
    "cup": 240,
  };

  function parseAmount(raw) {
    // Reuse the scale.js lenient parser (window.SolinScale) when present.
    const P = window.SolinScale && window.SolinScale.parseQty;
    if (P) {
      const r = P(String(raw == null ? "" : raw));
      return { amount: r.amount, unit: r.unit || null, ok: r.amount != null && r.amount > 0 };
    }
    const m = String(raw == null ? "" : raw).trim().match(/^([\d.]+)/);
    return { amount: m ? Number(m[1]) : null, unit: null,
             ok: m != null && Number(m[1]) > 0 };
  }

  /* ---------- pairing state (per recipe, session-scoped) ---------- */
  // rows: [{ ing_index, name, product_id, amount, unit, note }]
  let ROWS = null;         // currently mounted rows for the active recipe
  /* CUSTOM = "egyéb hozzávaló" rows (spec §11.2 R1, task t_a411a23e).
     Independent of the recipe ingredient list AND of inventory: unlimited
     rows, each with its own × delete; product-only actions (Auto-pár,
     "Kiválasztott termékek törlése") never touch them. Keyed by a
     module-serial key (splices never shift indices under a re-render). */
  let CUSTOM = [];         // [{key, name, qty, unit, price, currency, macros{7}}]
  let CKEY = 0;            // key generator for CUSTOM rows
  let ACTIVE_RECIPE = null;
  let PRODUCTS = [];       // cached product list for pickers
  let PORTIONS = 1;        // selected portion count for the mounted view
  let LAST_RES = null;     // last /macros/count response — cached so a
                           // portions change re-splits locally (zero latency,
                           // no stale fetch) instead of re-fetching
  let COUNTED_P = null;    // the portion count LAST_RES was computed FOR
                           // (server echo when present, selector value when
                           // absent). Lets renderResult detect a STALE
                           // server per_portion block (user changed the
                           // selector after the fetch) and re-split locally.

  /* In-recipe-view state (portions + last result), keyed by recipe id.
     DESIGN LOCK (designer, 2026-10-08): the portion value persists ACROSS
     NAVIGATION WITHIN THE RECIPE VIEW — detail.render() rebuilds the whole
     #recipe-detail DOM on every show, so plain module globals would die
     with it. A per-recipe in-memory map survives that (Browse → A → Browse
     → A keeps the count + the result block), while contract §12's
     "NOT persisted globally" / "not across sessions" is honored because
     nothing here touches localStorage and a page reload clears it. */
  const VIEW = {};         // { recipeId: { portions, res, ts } }

  /* ---- pairing storage (spec §11.4: key v1 → v2, additive shape) ----
     Load reads v2; when a recipe has no v2 record yet, the legacy v1
     file stays readable (rows without `source` are paired rows). Save
     always writes v2, so custom rows can never leak into a v1 reader. */
  function loadPairing(recipeId) {
    let v = S.load(K2, null);
    if (!v || !v[recipeId]) v = S.load(K1, {});
    return v[recipeId] || null;
  }
  function savePairing(recipeId, rows, custom) {
    const v = S.load(K2, {});
    const paired = (rows || []).map((r) => ({
      name: r.name, product_id: r.product_id || null,
      amount: r.amount != null ? Number(r.amount) : null,
      unit: r.unit || null, note: r.note || "",
    }));
    const cust = (custom || []).map((c) => ({
      name: c.name, product_id: null, source: "custom",
      amount: c.qty != null && String(c.qty).trim() !== "" ? Number(c.qty) : null,
      unit: c.unit || null, note: "",
      price: c.price != null && String(c.price).trim() !== "" ? Number(c.price) : null,
      currency: c.currency || "HUF",
      macros: Object.assign({}, c.macros || {}),
    }));
    v[recipeId] = { saved_at: new Date().toISOString(), version: 2,
                   rows: paired.concat(cust) };
    S.save(K2, v);
  }

  /* ---------- products cache (shared picker source) ---------- */
  async function ensureProducts() {
    if (PRODUCTS.length) return PRODUCTS;
    PRODUCTS = await Fc.listCached("pairing");
    return PRODUCTS;
  }

  /* ---------- best fuzzy product guess per ingredient ---------- */
  function guessProduct(ingName, products) {
    const norm = (s) => String(s || "").toLowerCase()
      .replace(/ö/g, "o").replace(/ő/g, "o").replace(/ü/g, "u").replace(/ű/g, "u")
      .replace(/á/g, "a").replace(/é/g, "e").replace(/í/g, "i")
      .replace(/\s+/g, " ").trim();
    const n = norm(ingName);
    if (!n) return null;
    let best = null, bestScore = 0;
    for (const p of products) {
      const pn = norm(p.name), pb = norm(p.brand);
      let score = 0;
      if (pn === n) score = 100;
      else if (pn.includes(n) || n.includes(pn)) score = 60 + pn.length;
      else {
        const words = new Set(n.split(" "));
        const pwords = (pn + " " + pb).split(" ");
        let hit = 0;
        pwords.forEach((w) => { if (words.has(w) && w.length > 2) hit++; });
        if (hit) score = hit * 15;
      }
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return bestScore >= 45 ? best : null; // weak guess → don't auto-pair
  }

  /* ---------- row state for the mounted recipe ---------- */
  function initRows(recipe) {
    const ings = recipe.ingredients || [];
    const saved = loadPairing(recipe.id);
    const all = (saved && saved.rows) || [];
    // paired hydration ignores custom rows (v2 files mix both kinds)
    const savedRow = (name) => all.find((r) => r.name === name && r.source !== "custom");
    ACTIVE_RECIPE = recipe.id;
    ROWS = ings.map((ing, i) => {
      const p = parseAmount(ing.qty);
      const srow = savedRow(ing.name);
      return {
        i, name: ing.name,
        baseAmount: p.amount, baseUnit: p.unit || null,
        baseText: String(ing.qty || ""),
        note: ing.note || "",
        product_id: srow ? (srow.product_id || null) : null,
        amount: srow ? (srow.amount != null ? srow.amount : p.amount) : p.amount,
        unit: srow ? (srow.unit || null) : null,
      };
    });
    // Custom rows hydrate from the saved file (v2 round-trip, spec §11.4).
    // Display-empty sentinels stay "" so the inputs render blank, not "0".
    CUSTOM = all
      .filter((r) => r.source === "custom")
      .map((r) => ({
        key: "c" + (++CKEY),
        name: r.name || "",
        qty: r.amount != null ? String(r.amount) : "",
        unit: r.unit || "",
        price: r.price != null ? String(r.price) : "",
        currency: r.currency || "HUF",
        macros: Object.assign(blankMacros(), r.macros || {}),
      }));
  }

  /* ---------- custom "egyéb hozzávaló" rows (spec §11.2) ---------- */
  const CUSTOM_UNITS = ["g", "kg", "ml", "dl", "db", "szelet", "szem",
                        "evőkanál", "teáskanál"];

  // 7 MacroBlock keys, raw-string storage so inputs round-trip verbatim.
  function blankMacros() {
    const m = {};
    MACRO_KEYS.forEach((k) => { m[k] = ""; });
    return m;
  }

  function blankCustomRow() {
    return { key: "c" + (++CKEY), name: "", qty: "", unit: "",
             price: "", currency: "HUF", macros: blankMacros() };
  }

  /* Validate one custom row + build its API item (spec §11.2 R2/R3,
     §11.4). Returns:
       {blank:true}                    → totally empty row: silently skipped
       {bad:[field,…], name}           → invalid: row goes red + ONE toast,
                                          EXCLUDED from the count, never
                                          clamped (an empty name WITH values
                                          is invalid too, and never sent)
       {item:{type:'custom',…}}        → valid → joins items[] AFTER the
                                          paired rows, in user-entry order.
     Macro values are TOTALS for the used quantity (not per-100), each
     0–9999 with ≤2 decimals — verified against the raw typed string. */
  function customItemOf(c) {
    const s = (v) => String(v == null ? "" : v).trim();
    const name = s(c.name);
    const macros = c.macros || {};
    const macroFilled = MACRO_KEYS.some((k) => s(macros[k]) !== "");
    const filled = !!(name || s(c.qty) !== "" || s(c.unit) !== "" ||
                     s(c.price) !== "" || macroFilled);
    if (!filled) return { blank: true };
    const bad = [];
    if (!name || name.length > 80) bad.push("name");
    if (s(c.qty) !== "" && !(Number(c.qty) > 0)) bad.push("quantity");
    if (s(c.unit).length > 10) bad.push("unit");
    if (s(c.price) !== "" && !(Number(c.price) > 0)) bad.push("price");
    const cur = s(c.currency).toUpperCase();
    if (s(c.price) !== "" && !/^[A-Z]{3}$/.test(cur)) bad.push("currency");
    MACRO_KEYS.forEach((k) => {
      const v = s(macros[k]);
      // 0–9999, max 2 decimals, non-negative — "abc"/"-5"/1.234 are
      // invalid and mark the row red (R3: nothing is clamped or repaired)
      if (v !== "" && (!/^\d+(\.\d{1,2})?$/.test(v) || Number(v) > 9999)) bad.push(k);
    });
    if (bad.length) return { bad: bad, name: name || "(név nélkül)" };
    const item = { type: "custom", name: name };
    if (s(c.qty) !== "") item.quantity = Number(c.qty);
    if (s(c.unit) !== "") item.unit = s(c.unit);
    if (s(c.price) !== "") { item.price = Number(c.price); item.currency = cur; }
    if (macroFilled) {
      const m = {};
      MACRO_KEYS.forEach((k) => { if (s(macros[k]) !== "") m[k] = Number(macros[k]); });
      item.macros = m;
    }
    return { item: item };
  }

  function productOf(id) {
    return (PRODUCTS || []).find((p) => p.id === id) || null;
  }

  /* ---------- picker options for a row's product select ---------- */
  function productOptions(selectedId) {
    const list = PRODUCTS || [];
    const opts = ['<option value="">— válassz terméket —</option>'];
    list.forEach((p) => {
      opts.push('<option value="' + esc(p.id) + '"' + (p.id === selectedId ? " selected" : "") + ">" +
        esc(p.name) + (p.brand ? " · " + esc(p.brand) : "") + "</option>");
    });
    return opts.join("");
  }

  /* ---------- unit options allowed for a product (family-gated) ---------- */
  function unitOptionsFor(product, selected) {
    const fam = product ? Fc.unitFamily(product.base_unit) : null;
    let units = fam ? Fc.UNIT_FAMILIES[fam] : ["g", "ml", "pcs"];
    // add a couple of HU convenience units that map into the same family
    if (fam === "liquid") units = units.concat(["evőkanál", "teáskanál"]);
    const seen = new Set(), out = [];
    units.forEach((u) => { if (!seen.has(u)) { seen.add(u); out.push(u); } });
    return out.map((u) =>
      '<option value="' + esc(u) + '"' + (u === selected ? " selected" : "") + ">" + esc(u) + "</option>"
    ).join("");
  }

  /* ---------- convert a typed amount to a base-family unit the engine accepts ----
     Returns {amount, unit} where unit ∈ {g,kg,mg,ml,l,pcs} and amount is the
     converted quantity. If the value can't be mapped (unknown unit → product
     base, or untyped unit → null), the result is the best-effort fallback. */
  function toEngine(row, product) {
    const fam = product ? Fc.unitFamily(product.base_unit) : null;
    const unit = String(row.unit || "").trim().toLowerCase();
    const amt = Number(row.amount);
    if (amt == null || isNaN(amt) || amt <= 0) return null;

    if (fam === "liquid") {
      if (ML_EQUIV[unit]) return { amount: amt * ML_EQUIV[unit], unit: "ml" };
      if (fam === unit)   return { amount: amt, unit: unit };
      if (Fc.unitFamily(unit) === "liquid") return { amount: amt, unit: product.base_unit };
      return { amount: amt, unit: product.base_unit };
    }
    if (fam === "count") {
      if (["pcs", "db", "darab", "gerezd", "fej"].includes(unit)) return { amount: amt, unit: "pcs" };
      return { amount: amt, unit: "pcs" };
    }
    // mass family (default)
    if (Fc.UNIT_FAMILIES.mass.includes(unit)) return { amount: amt, unit: unit };
    return { amount: amt, unit: product.base_unit };
  }

  /* =========================== RENDER ============================ */
  function renderCard(recipe) {
    initRows(recipe);
    // Restore this recipe's in-view portions state (see VIEW docs above).
    const vstate = VIEW[recipe.id] || null;
    PORTIONS = (vstate && parsePortions(vstate.portions) != null)
               ? parsePortions(vstate.portions) : 1;
    LAST_RES = vstate ? (vstate.res || null) : null;
    COUNTED_P = (vstate && vstate.counted != null) ? vstate.counted : null;
    const el = $("#pairing");
    const ingCount = (recipe.ingredients || []).length;
    el.innerHTML =
      '<div class="detail-section" id="pairing-section">' +
      '  <button class="sec-head" data-pg-toggle="1">Recept ↔ Termék párosítás <span class="pbadge" id="pg-badge">0/' + ingCount + ' termék</span></button>' +
      '  <div class="sec-body open" id="pairing-body">' +
      '    <p class="hint">Párosítsd a hozzávalókat a raktári <b>termékeidhez</b>' +
      '      (a Makrószámláló listából). A <b>ténylegesen használt mennyiséget</b> írd be' +
      '      (a recepti amount nem feltétlenül ez). Számlálás után a tényleges makrókat' +
      '      ÉS az étel árát látod. A párosítás elmenthető receptenként.</p>' +
      '    <div class="pg-actions">' +
      '      <button class="btn sm ghost" id="pg-autopair">✦ Auto-párosítás</button>' +
      '      <button class="btn sm primary" id="pg-count">Számolás →</button>' +
      '      <button class="btn sm" id="pg-save">💾 Párosítás mentése</button>' +
      '      <button class="btn sm ghost" id="pg-clear">Kiválasztott termékek törlése</button>' +
      // R1 (spec §11.2): ONE entry chip for custom extras, independent of
      // the ingredient list + inventory. Unlimited rows, each with its own ×.
      '      <button class="btn sm ghost" id="pg-add-custom" type="button">＋ Egyéb hozzávaló</button>' +
      '    </div>' +
      '    <div class="pg-portions">' +
      '      <label for="pg-portions-in">Portionok</label>' +
      '      <div class="pg-portions-ctl">' +
      '        <button type="button" class="btn sm ghost pgp-step" data-pg-step="-1" aria-label="eggyel kevesebb adag">−</button>' +
      '        <input id="pg-portions-in" type="number" inputmode="numeric" min="1" max="999" step="1" value="' + (PORTIONS != null ? PORTIONS : 1) + '" aria-label="adagok száma (1–999)" />' +
      '        <button type="button" class="btn sm ghost pgp-step" data-pg-step="1" aria-label="eggyel több adag">+</button>' +
      '      </div>' +
      '      <span class="hint sm" title="Ennyire oszlik a készült batch: minden makróérték el van osztva erre. Az ár a teljes batché és NEM oszlik.">a batch ennyi adag → az értékek portiónként</span>' +
      '      <span id="pg-portions-err" class="pg-err hidden" role="alert"></span>' +
      '    </div>' +
      '    <div id="pg-status" class="scale-status hidden" role="status"></div>' +
      // Result lives ABOVE the ingredient rows (t_d6c25424): after pressing
      // Számolás it appears directly below the button row + portions
      // selector — visible without scrolling past the paired ingredients.
      // Single #pg-result container (no duplicate result section); renderResult()
      // is the only writer and it replaces innerHTML wholesale.
      '    <div id="pg-result"></div>' +
      // unit-family datalist shared by all custom rows (spec §11.2 R2)
      '    <datalist id="pg-units" hidden>' +
      CUSTOM_UNITS.map((u) => '<option value="' + esc(u) + '"></option>').join("") +
      '</datalist>' +
      '    <ul class="pg-rows" id="pg-rows"></ul>' +
      '  </div>' +
      '</div>';
    renderRows();
    wireCard();
    refreshBadge();
    renderPortions();
    // ensure product cache so pickers are populated
    ensureProducts().then(() => { renderRows(); wireCard(); }).catch(() => {});
    // restored result? re-render it with the stored portion split (no fetch)
    if (LAST_RES) applyResult(LAST_RES);

    // collapsible
    // NOTE: the collapsible toggle is handled by detail.js's generic
    // .sec-head handler (render → box.querySelectorAll('.sec-head')).
    // Adding our own listener here would DOUBLE-toggle (open→close→open = net
    // no-op) — the classic "can't collapse the pairing panel" bug.
  }

  function rowHtml(row) {
    const p = row.product_id ? productOf(row.product_id) : null;
    const unopts = unitOptionsFor(p, row.unit || (p ? p.base_unit : "") || "");
    const baseHint = row.baseText ? '<span class="pg-basehint" title="Recepti amount (csak tájékoztató)">· ' + esc(row.baseText) + '</span>' : "";
    return '<li class="pg-row' + (row.product_id ? ' paired' : '') + '" data-row="' + row.i + '">' +
      '  <div class="pg-rowtop">' +
      '    <span class="pg-name">' + esc(row.name) + baseHint + '</span>' +
      '  </div>' +
      '  <div class="pg-controls">' +
      '    <select class="pg-prod" data-role="prod" aria-label="termék" title="Raktári termék">' + productOptions(row.product_id) + '</select>' +
      '    <input class="pg-amt" data-role="amt" type="number" inputmode="decimal" min="0" step="any" placeholder="mennyiség" value="' + (row.amount != null ? esc(row.amount) : "") + '" aria-label="tényleges mennyiség" />' +
      '    <select class="pg-unit" data-role="unit" aria-label="egység">' + unopts + '</select>' +
      '  </div>' +
      '</li>';
  }

  /* ---------- custom row markup (§11.2 R2 field set) ---------- */
  function custCell(label, inner) {
    return '<span class="pg-cust-cell"><span class="pg-cust-lbl">' + label + "</span>" + inner + "</span>";
  }

  function customRowHtml(c) {
    const key = esc(c.key);
    const num = (role, label, val, ph) =>
      custCell(label,
        '<input data-crole="' + role + '" type="number" step="any" inputmode="decimal" min="0" ' +
        'placeholder="' + esc(ph) + '" value="' + esc(val == null ? "" : val) + '" ' +
        'aria-label="' + esc(label) + '" />');
    const macroCells = MACRO_KEYS.map((k) => {
      const lbl = ({ calories: "kcal", protein: "P", fat: "Z", carbs: "C",
                    fiber: "rost", sugar: "cukor", sodium: "Na" })[k];
      return '<span class="pg-cust-cell"><span class="pg-cust-lbl">' + lbl + "</span>" +
        '<input data-crole="macros" data-macro="' + k + '" type="text" inputmode="decimal" ' +
        'value="' + esc((c.macros && c.macros[k]) || "") + '" aria-label="' + esc(lbl + ' (összesen)') + '" /></span>';
    }).join("");
    return '<li class="pg-row pg-custom' + (c.bad ? " bad" : "") + '" data-cust="' + key + '">' +
      '<div class="pg-rowtop">' +
        '<input class="pg-cust-name" data-crole="name" type="text" maxlength="80" ' +
          'placeholder="név (kötelező) – pl. Chilipehely" value="' + esc(c.name) + '" aria-label="megnevezés" />' +
        '<button type="button" class="pg-cust-del" data-cust-del="' + key + '" aria-label="sor törlése">×</button>' +
      "</div>" +
      '<div class="pg-cust-grid">' +
        num("qty", "menny.", c.qty, "mennyiség") +
        custCell("m. egység", '<input data-crole="unit" type="text" maxlength="10" list="pg-units" placeholder="g" value="' + esc(c.unit) + '" aria-label="mértékegység" />') +
        num("price", "ár", c.price, "ár (összesen)") +
        custCell("valuta", '<input data-crole="currency" type="text" maxlength="3" style="text-transform:uppercase" placeholder="HUF" value="' + esc(c.currency) + '" aria-label="valuta" />') +
        macroCells +
      "</div>" +
      "</li>";
  }

  function renderRows() {
    const ul = $("#pg-rows");
    if (!ul || !ROWS) return;
    // Paired rows first, then — under a sub-label — the custom extras,
    // in user-entry order (spec §11.3 display rule).
    let html = (ROWS || []).map(rowHtml).join("");
    if (CUSTOM && CUSTOM.length) {
      html += '<li class="pg-sublabel">Egyéb hozzávalók</li>' +
              CUSTOM.map(customRowHtml).join("");
    }
    ul.innerHTML = html;
  }

  function refreshBadge() {
    const b = $("#pg-badge");
    if (!b || !ROWS) return;
    const paired = ROWS.filter((r) => r.product_id).length;
    b.textContent = paired + "/" + ROWS.length + " termék" +
      (CUSTOM.length ? " · " + CUSTOM.length + " egyéb" : "");
    b.classList.toggle("on", paired > 0 || CUSTOM.length > 0);
  }

  function setStatus(kind, msg) {
    const el = $("#pg-status");
    if (!el) return;
    el.classList.remove("hidden", "ok", "err");
    if (!msg) { el.textContent = ""; el.classList.add("hidden"); return; }
    if (kind === "ok") el.classList.add("ok");
    if (kind === "err") el.classList.add("err");
    el.textContent = msg;
  }

  /* ---------- portions selector (design/PORTIONS.md UI decisions) ---------- */
  /* Sync the input's displayed value to the validated state.
     Invalid → keep what the user typed (they need to see/fix it), red err. */
  function renderPortions() {
    const inp = $("#pg-portions-in");
    const errEl = $("#pg-portions-err");
    if (!inp || !errEl) return;
    const raw = inp.value;
    const n = parsePortions(raw);
    if (n == null) {
      PORTIONS = 1; // fall back to the valid default for any send; UI shows err
      errEl.textContent = "Portionok: egész szám 1 és 999 között (pl. 1, 4, 6).";
      errEl.classList.remove("hidden");
      return;
    }
    PORTIONS = n;
    errEl.classList.add("hidden");
    if (document.activeElement !== inp) inp.value = String(n);
  }

  function setPortionsError(msg) {
    const errEl = $("#pg-portions-err");
    if (!errEl) return;
    if (msg) { errEl.textContent = msg; errEl.classList.remove("hidden"); }
    else errEl.classList.add("hidden");
  }

  /* Persist portions + last result into the in-recipe-view map (docs on
     VIEW above). Nothing is written to localStorage — contract §12. */
  function stashView() {
    if (ACTIVE_RECIPE == null) return;
    VIEW[ACTIVE_RECIPE] = { portions: PORTIONS, res: LAST_RES,
                            counted: COUNTED_P, ts: Date.now() };
  }

  /* Re-render the current result for the selected portion count.
     Uses LAST_RES (already computed for the whole batch) and splits
     client-side → immediate, no network, no stale-data flash. */
  function applyResult(res) {
    renderResult(res, PORTIONS);
    stashView();
  }

  /* ---------- interaction wiring (delegated on #pg-rows) ---------- */
  function wireCard() {
    const sec = $("#pairing-section");
    if (!sec) return;
    if (sec.dataset.wired) return;
    sec.dataset.wired = "1";

    sec.querySelector("#pg-autopair").addEventListener("click", async () => {
      ensureProducts().then((list) => {
        let n = 0;
        (ROWS || []).forEach((row) => {
          if (row.product_id) return;
          const g = guessProduct(row.name, list);
          if (g) { row.product_id = g.id; row.unit = row.unit || g.base_unit; n++; }
        });
        renderRows(); refreshBadge();
        toast(n ? n + " hozzávaló auto-párosítva" : "Nincs egyértelmű egyezés a raktári termékekben");
      });
    });

    sec.querySelector("#pg-count").addEventListener("click", doCount);
    sec.querySelector("#pg-save").addEventListener("click", saveCurrent);
    sec.querySelector("#pg-clear").addEventListener("click", () => {
      (ROWS || []).forEach((r) => { r.product_id = null; r.unit = null; });
      renderRows(); refreshBadge();
      $("#pg-result").innerHTML = "";
      // The cached result is stale now (its products/quantities are gone) —
      // drop it so a portions edit can't re-render old numbers. The portion
      // setting itself persists per recipe view (independent of products).
      LAST_RES = null; COUNTED_P = null;
      stashView();
      toast("Kiválasztott termékek törölve");
    });

    // portions selector: input change → validate + re-split locally;
    // stepper buttons → ±1 from the current valid value. Rapid changes are
    // safe: renderResult() is a pure re-render of cached data (no fetch in
    // flight to race), so stale values can never flash over fresh ones.
    const pin = sec.querySelector("#pg-portions-in");
    pin.addEventListener("input", () => { renderPortions(); if (LAST_RES) applyResult(LAST_RES); });
    pin.addEventListener("change", () => { renderPortions(); if (LAST_RES) applyResult(LAST_RES); });
    sec.querySelectorAll(".pgp-step").forEach((btn) => {
      btn.addEventListener("click", () => {
        const delta = Number(btn.dataset.pgStep);
        const base = parsePortions(pin.value) != null ? parsePortions(pin.value) : PORTIONS;
        const next = Math.min(999, Math.max(1, base + delta));
        pin.value = String(next);
        renderPortions();
        if (LAST_RES) applyResult(LAST_RES);
        pin.focus();
      });
    });

    // delegated row interactions: product change / amount+unit input
    const rowsEl = sec.querySelector("#pg-rows");
    rowsEl.addEventListener("change", (e) => {
      const li = e.target.closest && e.target.closest(".pg-row");
      if (!li) return;
      const row = ROWS[Number(li.dataset.row)];
      if (!row) return;
      if (e.target.dataset.role === "prod") {
        row.product_id = e.target.value || null;
        const p = row.product_id ? productOf(row.product_id) : null;
        if (p) {
          // reset unit to the product's base when the user switches product
          // (prevents a stale family-mismatch on the old product)
          if (row.unit && p.base_unit && Fc.unitFamily(row.unit) !== Fc.unitFamily(p.base_unit)) {
            row.unit = p.base_unit;
          } else if (!row.unit) {
            row.unit = p.base_unit;
          }
        } else {
          row.unit = null;
        }
        renderRows(); refreshBadge();
      }
    });
    rowsEl.addEventListener("input", (e) => {
      if (e.target.dataset.role !== "amt") return;
      const li = e.target.closest(".pg-row");
      const row = ROWS[Number(li.dataset.row)];
      const v = e.target.value.trim();
      row.amount = v === "" ? null : Number(v);
      refreshBadge();
    });

    /* ---- custom "egyéb hozzávaló" wiring (spec §11.2 R1, t_a411a23e) ---- */

    // ＋ entry chip: unlimited custom rows, independent of the ingredient
    // list and of inventory (R1). Lives in .pg-actions next to Számolás.
    const addBtn = sec.querySelector("#pg-add-custom");
    if (addBtn) addBtn.addEventListener("click", () => {
      CUSTOM.push(blankCustomRow());
      renderRows(); refreshBadge();
      const li = rowsEl && rowsEl.lastElementChild;
      if (li) { const f = li.querySelector("input"); if (f) f.focus(); }
    });

    // typing into a custom row keeps the model in sync WITHOUT a full
    // re-render (re-rendering on every keystroke would kill input focus).
    // bad-row red paint clears as soon as the row is edited.
    rowsEl.addEventListener("input", (e) => {
      const role = e.target.dataset && e.target.dataset.crole;
      if (!role) return;
      const li = e.target.closest && e.target.closest(".pg-custom");
      if (!li) return;
      const c = CUSTOM.find((r) => r.key === li.dataset.cust);
      if (!c) return;
      if (role === "macros") {
        const mk = e.target.dataset.macro;
        if (mk) c.macros[mk] = e.target.value;
      } else {
        c[role] = e.target.value;
      }
      if (c.bad) c.bad = false;
    });

    // per-row "×" delete — only ever removes custom rows, and product
    // actions (clear) never add/remove custom rows (R1).
    rowsEl.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest("[data-cust-del]");
      if (!btn) return;
      const i = CUSTOM.findIndex((r) => r.key === btn.dataset.custDel);
      if (i >= 0) CUSTOM.splice(i, 1);
      renderRows(); refreshBadge();
    });
  }

  /* ---------- count (POST /api/v1/inventory/macros/count) ---------- */
  /* items[] = paired rows (unchanged) → then valid custom rows, in
     user-entry order (spec §11.3/§11.4). Blank custom rows are skipped
     silently; INVALID ones are flagged (c.bad=true → red row), toated
     once in doCount and EXCLUDED from this request (R3: no clamping,
     nothing sent half-broken). Empty-name-with-values is invalid, never
     sent. The assembled custom-only refusal (no valid row at all) is
     refused client-side too — mirror of the server's VALIDATION_ERROR. */
  function collectItems() {
    const items = [];
    const bad = [];
    (ROWS || []).forEach((row) => {
      if (!row.product_id) return;
      const p = productOf(row.product_id);
      if (!p) return;
      const conv = toEngine(row, p);
      if (!conv) return;              // no amount → skip (user hasn't set one)
      items.push({
        product_id: row.product_id,
        quantity: conv.amount,
        unit: conv.unit,
        name_override: row.name,       // show the recipe ingredient name in the row
      });
    });
    (CUSTOM || []).forEach((c) => {
      const built = customItemOf(c);
      if (built.blank) return;
      if (built.bad) { c.bad = true; bad.push(built.name); return; }
      c.bad = false;
      items.push(built.item);
    });
    return { items: items, bad: bad };
  }

  async function doCount() {
    // Validate portions BEFORE any work (cheap, per design §5 — reject,
    // never clamp). renderPortions() mirrors a bad input into the err tip.
    renderPortions();
    if (parsePortions($("#pg-portions-in").value) == null) {
      setStatus("err", "Portionok: egész szám 1 és 999 között — javítsd, mielőtt számolsz.");
      return;
    }
    const out = $("#pg-result");
    const built = collectItems();
    const items = built.items;
    // R3: one toast per Számolás press, listing the red rows; they are
    // already excluded from `items` (renderRows repaints them red).
    if (built.bad.length) {
      renderRows();
      toast("Érvénytelen egyéb sor (nem számít be): " +
        built.bad.slice(0, 3).join(", ") + (built.bad.length > 3 ? " …" : ""));
    }
    if (!items.length) {
      setStatus("err", built.bad.length
        ? "Add hozzá vagy javítsd meg legalább egy adatot (termék-párosítás vagy egyéb sor)."
        : "Válassz legalább 1 hozzávalóhoz raktári terméket ÉS adj meg mennyiséget (vagy adj hozzá egyéb sort).");
      return;
    }
    setStatus("ok", "Számolom a tényleges makrókat és az étel árát…");
    out.innerHTML = "";
    let res;
    try {
      // Pass portions to the backend (contract §2). A pre-portions backend
      // ignores the extra key and still returns the whole-batch `totals` —
      // applyResult() then splits client-side, so both backend generations
      // produce the same exact per-portion numbers.
      res = await Fc.countMacros(items, PORTIONS);
    } catch (e) {
      if (e && e.status === 400 && e.code === "PORTIONS_INVALID") {
        setPortionsError((e.message || "portions must be an integer between 1 and 999") +
          " (400 PORTIONS_INVALID)");
      }
      setStatus("err", "Számolási hiba: " + e.message);
      return;
    }
    LAST_RES = res;
    // What count was this actually computed for? Trust the server echo;
    // if a pre-portions backend ignored the field, use the value we sent.
    COUNTED_P = (res.portions != null && Number.isInteger(res.portions)
                 && res.portions >= 1 && res.portions <= 999)
                ? res.portions : PORTIONS;
    setStatus("ok", "Kész — tényleges makrók + ár az alábbiakban.");
    applyResult(res);
  }

  function warnLabel(code) {
    return ({
      CROSS_CURRENCY_EXCLUDED: "Ár kizárva (másik valuta)",
      PRODUCT_NOT_FOUND: "Nincs ilyen termék",
      UNITS_INCOMPATIBLE: "Egység nem konvertálható",
    })[code] || code;
  }

  /* One macro line for a MacroBlock (7 keys, canonical order).
     `title` = the Hungarian label shown as the lead (design:
     e.g. "Per portion (of 4): …"). */
  function macroBlockLine(pp, lead) {
    return '<div class="pg-macroline">' +
      '  <span class="pg-macroline-lead">' + lead + '</span>' +
      '  <span class="pg-macroline-vals">' +
      '    <span><b>' + fmt(pp.calories) + '</b> kcal</span>' +
      '    <span><b>' + fmt(pp.protein) + '</b> g P</span>' +
      '    <span><b>' + fmt(pp.carbs) + '</b> g C</span>' +
      '    <span><b>' + fmt(pp.fat) + '</b> g Z</span>' +
      '    <span><b>' + fmt(pp.fiber) + '</b> g rost</span>' +
      '    <span><b>' + fmt(pp.sugar) + '</b> g cukor</span>' +
      '    <span><b>' + fmt(pp.sodium) + '</b> mg Na</span>' +
      '  </span>' +
      '</div>';
  }

  function renderResult(res, nPort) {
    const out = $("#pg-result");
    const pi = res.per_ingredient || [];
    const t = res.totals || {};
    // Display count = the (validated) selector value the caller passes.
    // The server's `portions` echo is deliberately NOT a display source —
    // it is only "what THIS response was computed for" and is consumed
    // into COUNTED_P at fetch time (doCount). Basing N on the echo would
    // make a post-fetch selector change stick to the old count.
    const N = (nPort != null && Number.isInteger(nPort)
               && nPort >= 1 && nPort <= 999)
              ? nPort : 1;
    // per_portion: trust the server block ONLY when it was computed for
    // THIS displayed count (COUNTED_P matches; null = fresh/test use →
    // trust). If the user changed the selector after the fetch, the server
    // block belongs to the OLD count → re-split the whole-batch totals
    // client-side (r2 HALF_UP, fixture-verified) so values and the lead agree.
    const pp = (res.per_portion && typeof res.per_portion === "object"
                && (COUNTED_P == null || COUNTED_P === N))
      ? res.per_portion
      : perPortionOf(t, N);
    const rows = pi.map((r) => {
      const isCustom = r.source === "custom";   // additive API key, spec §11.4
      const warns = (r.warnings || []).map((w) => {
        const code = (typeof w === "string") ? w : (w && w.code) || "?";
        return '<span class="pg-warn sm" title="' + esc(r.product_id || r.name || "") + '">' + esc(warnLabel(code)) + "</span>";
      }).join("");
      const nameCell = esc(r.name || r.product_id) +
        (isCustom ? ' <span class="pg-egyeb" title="Egyéb hozzávaló (kézzel megadva)">egyéb</span>' : "");
      return "<tr>" +
        "<td>" + nameCell + "</td>" +
        '<td class="num">' + fmt(r.quantity) + " " + esc(r.unit || "") + "</td>" +
        '<td class="num">' + fmt(r.macros && r.macros.calories) + "</td>" +
        '<td class="num">' + fmt(r.macros && r.macros.protein) + "</td>" +
        '<td class="num">' + fmt(r.macros && r.macros.carbs) + "</td>" +
        '<td class="num">' + fmt(r.macros && r.macros.fat) + "</td>" +
        '<td class="num">' + (r.cost != null ? fmt(r.cost) : "—") + "</td>" +
        "<td>" + warns + "</td>" +
        "</tr>";
    }).join("");
    const cost = res.total_cost;   // WHOLE-BATCH cost — never divided (§7)
    // Per-portion price VIEW (t_55b88129): trust the server's
    // per_portion_cost ONLY when it was computed for THIS displayed count
    // (same stale-echo rule as per_portion); otherwise re-split the whole-
    // batch total client-side (r2 HALF_UP). null when there is no cost.
    const ppcFresh = (res.per_portion_cost && typeof res.per_portion_cost === "object"
                     && (COUNTED_P == null || COUNTED_P === N));
    const ppc = ppcFresh
      ? res.per_portion_cost
      : (cost && N > 1
         ? { amount: halfUp2(Number(cost.amount) / N), currency: cost.currency }
         : (cost && N === 1 ? cost : null));
    const warnChips = (res.warnings || []).map((w) => {
      const code = (typeof w === "string") ? w : (w && w.code) || "";
      return '<span class="pg-warn">' + esc(warnLabel(code)) + "</span>";
    }).join("");
    // Per-portion lead + whole-batch secondary (design UI decision:
    // per-portion PROMINENT, totals kept as a comparison block).
    const portionsLead = (N > 1)
      ? ("Portiónként (a " + N + " adagból)")
      : ("Teljes adag (1/1)");
    out.innerHTML =
      '<div class="card pg-result-card">' +
      '  <h4>Tényleges makrók (a használt termékeid alapján)</h4>' +
      '  <div class="pg-macro">' +
      '    <h4 class="pg-macro-lead">PORTIÓNKÉNT</h4>' +
      '    ' + macroBlockLine(pp, portionsLead) +
      '  </div>' +
      '  <table class="pg-table">' +
      '    <thead><tr>' +
      '      <th>Hozzávaló</th><th class="num">Menny.</th><th class="num">kcal</th>' +
      '      <th class="num">P</th><th class="num">C</th><th class="num">Z</th>' +
      '      <th class="num">Ár</th><th></th>' +
      '    </tr></thead>' +
      '    <tbody>' + rows + "</tbody>" +
      "  </table>" +
      '  <div class="pg-total">' +
      '    <h4>ÖSSZESÍTÉS — teljes batch' + (N > 1 ? " (" + N + " adag)" : "") + '</h4>' +
      '    ' + macroBlockLine(t, "Teljes batch összesen") +
      '    <div class="pg-totalprice">' +
      '      <span class="lbl">AZ ÉTEL ÁRA (teljes batch)</span>' +
      '      <span class="val">' + (cost ? fmt(cost.amount) + " " + esc(cost.currency || "") : "— (nincs ár a termékeken)") + "</span>" +
      (ppc ? ('      <span class="lbl">ÁR / ADAG</span>' +
              '      <span class="val">' + fmt(ppc.amount) + " " + esc(ppc.currency || "") + "</span>") : "") +
      "    </div>" +
      (warnChips ? '<div class="pg-warns">' + warnChips + "</div>" : "") +
      "  </div>" +
      "</div>";
  }

  /* ---------- save / load pairing per recipe ---------- */
  function saveCurrent() {
    if (!ACTIVE_RECIPE) return;
    const paired = (ROWS || []).filter((r) => r.product_id).length;
    // Custom rows save too (spec §11.4: a v2 file with source:"custom"
    // rows must save/load/round-trip). Name-less custom rows are drafts.
    const custom = (CUSTOM || []).filter((c) => String(c.name || "").trim() !== "").length;
    if (!paired && !custom) { toast("Nincs mit menteni — egy termék sincs kiválasztva és nincs megadott egyéb sor."); return; }
    savePairing(ACTIVE_RECIPE, ROWS, CUSTOM);
    toast("Párosítás elmentve ehhez a recepthez (" + paired + " termék" +
      (custom ? " · " + custom + " egyéb" : "") + ")");
  }

  /* =========================== exports ============================ */
  return {
    renderCard,
    // Test/QA surface (used by app/tests/portions.spec.js under Node):
    // the parts of this module that don't need a full browser DOM.
    __test: {
      MACRO_KEYS,
      halfUp2, perPortionOf, parsePortions, renderResult,
      // Custom-row surface (spec §11.2 R2/R3) — pure, DOM-free so the
      // Node spec can unit-test validation + the API item shape.
      customItemOf, blankCustomRow,
      // Set/clear the "LAST_RES was computed for this count" context so a
      // spec can exercise the stale-server-echo path (see renderResult).
      setLastCountFor: (n) => { COUNTED_P = n; },
    },
  };
})();
