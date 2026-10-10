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

   Data: localStorage solin.pairings.v1
     { "<recipeId>": { saved_at, rows: [{name, product_id|null,
          amount:number|null, unit:string|null, note}] } }

   Hungarian copy to match the app registers (detail.js / foodcounter.js).
   ============================================================ */
window.Pairing = (function () {
  "use strict";
  const { $, $$, S, esc, toast } = window.Solin;
  const Fc = window.FcApi;

  const K = "solin.pairings.v1";

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

  function loadPairing(recipeId) {
    const v = S.load(K, {});
    return v[recipeId] || null;
  }
  function savePairing(recipeId, rows) {
    const v = S.load(K, {});
    v[recipeId] = {
      saved_at: new Date().toISOString(),
      rows: rows.map((r) => ({
        name: r.name, product_id: r.product_id || null,
        amount: r.amount != null ? Number(r.amount) : null,
        unit: r.unit || null, note: r.note || "",
      })),
    };
    S.save(K, v);
  }
  function deletePairing(recipeId) {
    const v = S.load(K, {});
    delete v[recipeId];
    S.save(K, v);
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
    const savedRow = (name) => saved && (saved.rows || []).find((r) => r.name === name);
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

  function renderRows() {
    const ul = $("#pg-rows");
    if (!ul || !ROWS) return;
    ul.innerHTML = (ROWS || []).map(rowHtml).join("");
  }

  function refreshBadge() {
    const b = $("#pg-badge");
    if (!b || !ROWS) return;
    const paired = ROWS.filter((r) => r.product_id).length;
    b.textContent = paired + "/" + ROWS.length + " termék";
    b.classList.toggle("on", paired > 0);
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
  }

  /* ---------- count (POST /api/v1/inventory/macros/count) ---------- */
  function collectItems() {
    const items = [];
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
    return items;
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
    const items = collectItems();
    if (!items.length) {
      setStatus("err", "Válassz legalább 1 hozzávalóhoz raktári terméket ÉS adj meg mennyiséget.");
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
      const warns = (r.warnings || []).map((w) => {
        const code = (typeof w === "string") ? w : (w && w.code) || "?";
        return '<span class="pg-warn sm" title="' + esc(r.product_id || "") + '">' + esc(warnLabel(code)) + "</span>";
      }).join("");
      return "<tr>" +
        "<td>" + esc(r.name || r.product_id) + "</td>" +
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
      "    </div>" +
      (warnChips ? '<div class="pg-warns">' + warnChips + "</div>" : "") +
      "  </div>" +
      "</div>";
  }

  /* ---------- save / load pairing per recipe ---------- */
  function saveCurrent() {
    if (!ACTIVE_RECIPE) return;
    const paired = (ROWS || []).filter((r) => r.product_id).length;
    if (!paired) { toast("Nincs mit menteni — egy termék sincs kiválasztva."); return; }
    savePairing(ACTIVE_RECIPE, ROWS);
    toast("Párosítás elmentve ehhez a recepthez (" + paired + " termék)");
  }

  /* =========================== exports ============================ */
  return {
    renderCard,
    // Test/QA surface (used by app/tests/portions.spec.js under Node):
    // the parts of this module that don't need a full browser DOM.
    __test: {
      MACRO_KEYS,
      halfUp2, perPortionOf, parsePortions, renderResult,
      // Set/clear the "LAST_RES was computed for this count" context so a
      // spec can exercise the stale-server-echo path (see renderResult).
      setLastCountFor: (n) => { COUNTED_P = n; },
    },
  };
})();
