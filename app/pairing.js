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
      '    <ul class="pg-rows" id="pg-rows"></ul>' +
      '    <div id="pg-status" class="scale-status hidden" role="status"></div>' +
      '    <div id="pg-result"></div>' +
      '  </div>' +
      '</div>';
    renderRows();
    wireCard();
    refreshBadge();
    // ensure product cache so pickers are populated
    ensureProducts().then(() => { renderRows(); wireCard(); }).catch(() => {});

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
      (ROWS || []).forEach((row) => { row.product_id = null; row.unit = null; });
      renderRows(); refreshBadge();
      $("#pg-result").innerHTML = "";
      toast("Kiválasztott termékek törölve");
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
      res = await Fc.countMacros(items);
    } catch (e) {
      setStatus("err", "Számolási hiba: " + e.message);
      return;
    }
    setStatus("ok", "Kész — tényleges makrók + ár az alábbiakban.");
    renderResult(res);
  }

  function warnLabel(code) {
    return ({
      CROSS_CURRENCY_EXCLUDED: "Ár kizárva (másik valuta)",
      PRODUCT_NOT_FOUND: "Nincs ilyen termék",
      UNITS_INCOMPATIBLE: "Egység nem konvertálható",
    })[code] || code;
  }

  function renderResult(res) {
    const out = $("#pg-result");
    const pi = res.per_ingredient || [];
    const t = res.totals || {};
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
    const cost = res.total_cost;
    const warnChips = (res.warnings || []).map((w) => {
      const code = (typeof w === "string") ? w : (w && w.code) || "";
      return '<span class="pg-warn">' + esc(warnLabel(code)) + "</span>";
    }).join("");
    out.innerHTML =
      '<div class="card pg-result-card">' +
      '  <h4>Tényleges makrók (a használt termékeid alapján)</h4>' +
      '  <table class="pg-table">' +
      '    <thead><tr>' +
      '      <th>Hozzávaló</th><th class="num">Menny.</th><th class="num">kcal</th>' +
      '      <th class="num">P</th><th class="num">C</th><th class="num">Z</th>' +
      '      <th class="num">Ár</th><th></th>' +
      '    </tr></thead>' +
      '    <tbody>' + rows + "</tbody>" +
      "  </table>" +
      '  <div class="pg-total">' +
      '    <h4>ÖSSZESÍTÉS</h4>' +
      '    <div class="pg-tt">' +
      '      <span><b>' + fmt(t.calories) + "</b> kcal</span>" +
      '      <span><b>' + fmt(t.protein) + "</b> g fehérje</span>" +
      '      <span><b>' + fmt(t.carbs) + "</b> g szénhidrát</span>" +
      '      <span><b>' + fmt(t.fat) + "</b> g zsír</span>" +
      '      <span><b>' + fmt(t.fiber) + "</b> rost</span>" +
      '      <span><b>' + fmt(t.sugar) + "</b> cukor</span>" +
      '      <span><b>' + fmt(t.sodium) + "</b> nátrium</span>" +
      "    </div>" +
      '    <div class="pg-totalprice">' +
      '      <span class="lbl">AZ ÉTEL ÁRA</span>' +
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
  return { renderCard };
})();
