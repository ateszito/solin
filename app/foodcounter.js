/* ============================================================
   Solin v3 — foodcounter.js
   "Real Macros & Price" — product inventory CRUD + meal macro
   /price counter, against POST /api/v1/inventory/macros/count.

   Written in chunks (see footer) to stay inside response-size
   limits; each IIFE section below is self-contained.
   Hungarian copy, matching the existing app registers
   (toasts are HU, view headings follow the existing EN+HU mix
   of inventory.js / match.js).

   API base: window.SolinCfg.apiBase() — baked to
   https://solin-dev.ateszito.com on the dev deploy, so all
   /api/v1/... calls are same-origin over https.
   Media URLs arrive root-relative (/api/v1/media/...) and are
   rendered as-is.
   ============================================================ */
"use strict";
window.FoodCounter = (function () {
  const { $, $$, S, esc, toast } = window.Solin;
  // module-internal state (declared ONCE, up front — all sections share it)
  const FC = (window.__FC = window.__FC || {});

  /* ---- API helpers ------------------------------------------------ */
  function apiBase() {
    const b = window.SolinCfg && window.SolinCfg.apiBase;
    return (typeof b === "function" ? b() : b) || "";
  }
  const API = apiBase() + "/api/v1/inventory";

  // One fetch wrapper: parse JSON + normalize the C8 error shape
  // {code,message,fields?} so views always toast `message`.
  // Note: no trailing slash after the inventory root — FastAPI 307-redirects
  // `/inventory/` → `/inventory`, which drops custom headers on non-GET.
  async function api(path, options) {
    const url = (API + (path || "")).replace(/\/+$/, "");
    const res = await fetch(url, options);
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      const msg = (body && body.message) || (res.status + " " + res.statusText);
      const err = new Error(msg);
      err.status = res.status;
      err.code = body && body.code;
      throw err;
    }
    return res.status === 204 ? null : body;
  }
  async function listProducts(search) {
    const q = search ? "?limit=50&search=" + encodeURIComponent(search) : "?limit=50";
    return (await api(q)).items;
  }

  /* ============================================================
     SECTION 1/4 — view bootstrap + product list + detail panel
     ============================================================ */

  /* ---- list rendering ------------------------------------------- */
  function macroChips(m) {
    if (!m) return "";
    const c = (v, label) =>
      `<span class="fc-chip" title="${label}">${label} ${fmt(v)}</span>`;
    return [
      c(m.calories, "kcal"),
      c(m.protein, "P"),
      c(m.carbs, "C"),
      c(m.fat, "F"),
    ].join("");
  }
  function fmt(v) {
    if (v == null) return "–";
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    return (Math.round(n * 100) / 100).toString();
  }
  function imgSrc(url) {
    // backend returns root-relative /api/v1/media/... — render as-is;
    // tolerate absolute URLs too.
    if (!url) return "";
    if (/^(https?:)?\/\//.test(url)) return url;
    return url.startsWith("/") ? url : "/" + url;
  }

  function render() {
    renderList();
    renderCounter();
    renderMeals();
  }

  async function renderList() {
    const box = $("#fc-product-list");
    box.innerHTML = '<li class="hint">Bövegszám letöltése…</li>';
    // keep search filter in sync with the input
    const q = ($("#fc-search") || {}).value || "";
    let items;
    try {
      items = await listProducts(q.trim());
    } catch (e) {
      box.innerHTML = `<li class="hint">Hiba: ${esc(e.message)}</li>`;
      return;
    }
    FC.products = items; // cache for product picker + detail lookups
    const countEl = $("#fc-count");
    if (countEl) countEl.textContent = items.length + " termék";
    if (!items.length) {
      box.innerHTML = '<li class="hint">Még nincs termék — hozz létre egyet felül.</li>';
      return;
    }
    box.innerHTML = items.map((p) => {
      const img = p.images && p.images.product_photo && p.images.product_photo.url;
      const nPrices = (p.prices || []).length;
      return `<li class="fc-product" data-open="${esc(p.id)}" role="button" tabindex="0"
        aria-label="${esc(p.name)} részletei">
        <span class="fc-thumb">${img
          ? `<img src="${esc(imgSrc(img))}" alt="" loading="lazy" />`
          : '<span class="fc-thumb-none">▣</span>'}</span>
        <span class="fc-main">
          <span class="fc-name">${esc(p.name)}${p.brand ? `<small> · ${esc(p.brand)}</small>` : ""}</span>
          ${macroChips(p.macros_per_100)}
          <span class="fc-chip muted">${nPrices} ár</span>
        </span>
        <span class="fc-open" aria-hidden="true">›</span>
      </li>`;
    }).join("");
    $$("#fc-product-list [data-open]").forEach((li) => {
      const open = () => openDetail(li.dataset.open);
      li.addEventListener("click", open);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  }

  /* ---- detail panel ------------------------------------------------ */
  async function openDetail(id) {
    const panel = $("#fc-detail");
    panel.hidden = false;
    panel.innerHTML = '<p class="hint">Betöltés…</p>';
    let p;
    try {
      p = await api("/" + encodeURIComponent(id));
    } catch (e) {
      panel.innerHTML = `<p class="hint">Hiba: ${esc(e.message)}</p>`;
      return;
    }
    FC.detailId = id;
    const m = p.macros_per_100 || {};
    const priceRows = (p.prices || []).map((pr) =>
      `<div class="fc-price"><span>${fmt(pr.amount)} ${esc(pr.currency)}</span>` +
      `<small>${pr.pack_size ? fmt(pr.pack_size) + " " + esc(p.base_unit || "") : "csomag"}` +
      `${pr.source ? " · " + esc(pr.source) : ""}</small></div>`
    ).join("") || '<p class="hint">Nincs rögzített ár.</p>';
    const slot = (name, label) => {
      const s = p.images && p.images[name];
      return `<div class="fc-slot">
        <span class="fc-slot-label">${label}</span>
        ${s && s.url
          ? `<img src="${esc(imgSrc(s.url))}" alt="${label}" />`
          : '<span class="fc-thumb-none">▢</span>'}
      </div>`;
    };
    panel.innerHTML = `
      <div class="fc-detail-head">
        <button class="fc-back" data-fcback="1">← Vissza a listához</button>
        <span style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" data-fcedit="${esc(p.id)}">✎ Szerkesztés</button>
          <button class="btn sm danger" data-fcdel="${esc(p.id)}" data-fcdelnm="${esc(p.name)}">🗑 Törlés</button>
        </span>
      </div>
      <h3>${esc(p.name)}${p.brand ? ` <small>· ${esc(p.brand)}</small>` : ""}</h3>
      <p class="hint">Alapegység: ${esc(p.base_unit || "–")}` +
      (p.serving_size != null ? ` · adag: ${fmt(p.serving_size)} ${esc(p.base_unit || "")}` +
        (p.serving_label ? ` (${esc(p.serving_label)})` : "") : "") + `</p>
      <h4>Tápanyány / 100 ${esc(p.base_unit || "egység")}</h4>
      <div class="fc-macro-grid">
        <div><b>${fmt(m.calories)}</b><small>kcal</small></div>
        <div><b>${fmt(m.protein)}</b><small>fehérje</small></div>
        <div><b>${fmt(m.carbs)}</b><small>szénhidrát</small></div>
        <div><b>${fmt(m.fat)}</b><small>zsír</small></div>
        <div><b>${fmt(m.fiber)}</b><small>rost</small></div>
        <div><b>${fmt(m.sugar)}</b><small>cukor</small></div>
        <div><b>${fmt(m.sodium)}</b><small>nátrium</small></div>
      </div>
      <h4>Árak ${((p.prices||[]).length ? "(" + (p.prices||[]).length + ")" : "")}</h4>
      ${priceRows}
      <h4>Fotók</h4>
      <div class="fc-slots">
        ${slot("product_photo", "Termékfotó")}
        ${slot("label_photo", "Címkefotó (a makrókkal)")}
      </div>`;
    const back = () => { panel.hidden = true; panel.innerHTML = ""; FC.detailId = null; };
    panel.querySelector("[data-fcback]").addEventListener("click", back);
    panel.querySelector("[data-fcedit]").addEventListener("click", () => openForm(id));
    const del = panel.querySelector("[data-fcdel]");
    del.addEventListener("click", async () => {
      if (!confirm(`Biztosan törlöd: ${del.dataset.fcdelnm}?`)) return;
      try {
        await api("/" + encodeURIComponent(id), { method: "DELETE" });
        toast("Törlve: " + del.dataset.fcdelnm);
        back();
        renderList();
      } catch (e) { toast("Törlési hiba: " + e.message); }
    });
  }

  /* ============================================================
     SECTION 2/4 — product create/edit form + photo upload
     ============================================================ */
  function openForm(idOrNull) {
    const panel = $("#fc-detail");
    const isEdit = !!idOrNull;
    panel.hidden = false;
    if (isEdit) fillForm(idOrNull);
    else resetForm();
  }

  async function fillForm(id) {
    // `id` being present IS the edit case — derive isEdit in THIS scope.
    // (Bug: the template below referenced isEdit, which was previously only
    //  declared in openForm's block → `isEdit is not defined` → panel stuck
    //  on "Betöltés…" forever. openForm no longer needs its own isEdit.)
    const isEdit = !!id;
    const panel = $("#fc-detail");
    panel.innerHTML = '<p class="hint">Betöltés…</p>';
    let p;
    try { p = await api("/" + encodeURIComponent(id)); }
    catch (e) { panel.innerHTML = `<p class="hint">Hiba: ${esc(e.message)}</p>`; return; }

    const m = p.macros_per_100 || {};
    const macroField = (k, label) =>
      `<label>${label}
        <input type="number" step="any" data-macro="${k}" value="${m[k] != null ? m[k] : ""}" /></label>`;

    let priceRowsHtml = "";
    (p.prices || []).forEach((pr) => {
      priceRowsHtml += priceRowHtml(pr.amount, pr.currency, pr.pack_size, pr.source);
    });

    const slotField = (slot, label) => {
      const s = p.images && p.images[slot];
      return `<div class="fc-slot-upload">
        <span class="fc-slot-label">${label}</span>
        ${s && s.url
          ? `<img src="${esc(imgSrc(s.url))}" alt="" data-slot-preview="${slot}" />`
          : ""}
        <input type="file" accept="image/jpeg,image/png,image/webp"
               data-slot-file="${slot}"
               aria-label="${label} feltöltése" />
        <small class="hint">JPG / PNG / WebP, max. 10 MB — új feltöltés felülírja</small>
      </div>`;
    };

    panel.innerHTML = `
      <div class="fc-detail-head">
        <button class="fc-back" data-fcback="1">← Vissza</button>
      </div>
      <h3>${isEdit ? "Termék szerkesztése" : "Új termék"}</h3>
      <form id="fc-form" class="fc-form" novalidate>
        <input type="hidden" name="id" value="${isEdit ? esc(id) : ""}" />
        <label>Név *<input required name="name" value="${esc(p.name || "")}" /></label>
        <label>Márka<input name="brand" value="${esc(p.brand || "")}" /></label>
        <div class="fc-row">
          <label>Alapegység
            <select name="base_unit">
              ${["g","ml","kg","l","pcs"].map((u) =>
                `<option value="${u}" ${p.base_unit === u ? "selected" : ""}>${u}</option>`).join("")}
            </select>
          </label>
          <label>Adagméret (szabadon)<input type="number" step="any" name="serving_size" value="${p.serving_size != null ? p.serving_size : ""}" /></label>
        </div>
        <label>Adag felirat (pl. "1 db")<input name="serving_label" value="${esc(p.serving_label || "")}" /></label>

        <h4>Tápanyány per 100 egység (opcionális, tizedestört)</h4>
        <div class="fc-macro-inputs">
          ${macroField("calories", "Kalória (kcal)")}
          ${macroField("protein", "Fehérje (g)")}
          ${macroField("carbs", "Szénhidrát (g)")}
          ${macroField("fat", "Zsír (g)")}
          ${macroField("fiber", "Rost (g)")}
          ${macroField("sugar", "Cukor (g)")}
          ${macroField("sodium", "Nátrium (mg)")}
          <button type="button" class="btn sm ghost" data-macroclear="1">üres</button>
        </div>

        <h4>Árak (0..N — több ároptió is bejő)</h4>
        <div id="fc-prices">${priceRowsHtml}</div>
        <button type="button" class="btn sm ghost" data-addprice="1">+ ár sor</button>

        <h4>Fotók</h4>
        ${slotField("product_photo", "Termékfotó")}
        ${slotField("label_photo", "Címkefotó (a makrókkal)")}

        <div class="fc-form-actions">
          <button type="submit" class="btn primary">Mentés</button>
          <span class="hint" id="fc-form-err"></span>
        </div>
      </form>`;

    panel.querySelector("[data-fcback]").addEventListener("click", () => openDetail(p.id));
    panel.querySelector("[data-macroclear]").addEventListener("click", () => {
      panel.querySelectorAll("[data-macro]").forEach((i) => { i.value = ""; });
    });
    panel.querySelector("[data-addprice]").addEventListener("click", () => {
      panel.querySelector("#fc-prices").insertAdjacentHTML("beforeend", priceRowHtml("", "", "", ""));
    });
    panel.querySelector("#fc-form").addEventListener("submit", (e) => { e.preventDefault(); submitForm(p.id); });
  }

  function resetForm() {
    const panel = $("#fc-detail");
    FC.editingId = null;
    panel.innerHTML = `
      <div class="fc-detail-head">
        <button class="fc-back" data-fcback="1">← Vissza a listához</button>
      </div>
      <h3>Új termék</h3>
      <form id="fc-form" class="fc-form" novalidate>
        <input type="hidden" name="id" value="" />
        <label>Név *<input required name="name" /></label>
        <label>Márka<input name="brand" /></label>
        <div class="fc-row">
          <label>Alapegység
            <select name="base_unit">
              ${["g","ml","kg","l","pcs"].map((u) => `<option value="${u}">${u}</option>`).join("")}
            </select>
          </label>
          <label>Adagméret (szabadon)<input type="number" step="any" name="serving_size" /></label>
        </div>
        <label>Adag felirat (pl. "1 db")<input name="serving_label" /></label>
        <h4>Tápanyány per 100 egység (opcionális)</h4>
        <div class="fc-macro-inputs">
          <label>Kalória (kcal)<input type="number" step="any" data-macro="calories" /></label>
          <label>Fehérje (g)<input type="number" step="any" data-macro="protein" /></label>
          <label>Szénhidrát (g)<input type="number" step="any" data-macro="carbs" /></label>
          <label>Zsír (g)<input type="number" step="any" data-macro="fat" /></label>
          <label>Rost (g)<input type="number" step="any" data-macro="fiber" /></label>
          <label>Cukor (g)<input type="number" step="any" data-macro="sugar" /></label>
          <label>Nátrium (mg)<input type="number" step="any" data-macro="sodium" /></label>
          <button type="button" class="btn sm ghost" data-macroclear="1">üres</button>
        </div>
        <h4>Árak (0..N)</h4>
        <div id="fc-prices"></div>
        <button type="button" class="btn sm ghost" data-addprice="1">+ ár sor</button>
        <h4>Fotók</h4>
        ${slotFieldHtml("product_photo", "Termékfotó")}
        ${slotFieldHtml("label_photo", "Címkefotó (a makrókkal)")}
        <div class="fc-form-actions">
          <button type="submit" class="btn primary">Mentés</button>
          <span class="hint" id="fc-form-err"></span>
        </div>
      </form>`;
    panel.querySelector("[data-fcback]").addEventListener("click", () => {
      panel.hidden = true; panel.innerHTML = ""; FC.editingId = null;
    });
    panel.querySelector("[data-macroclear]").addEventListener("click", () => {
      panel.querySelectorAll("[data-macro]").forEach((i) => { i.value = ""; });
    });
    panel.querySelector("[data-addprice]").addEventListener("click", () => {
      panel.querySelector("#fc-prices").insertAdjacentHTML("beforeend", priceRowHtml("", "", "", ""));
    });
    panel.querySelector("#fc-form").addEventListener("submit", (e) => { e.preventDefault(); submitForm(null); });
  }

  // slotField without needing a product doc (new-product form)
  function slotFieldHtml(slot, label) {
    return `<div class="fc-slot-upload">
      <span class="fc-slot-label">${label}</span>
      <input type="file" accept="image/jpeg,image/png,image/webp"
             data-slot-file="${slot}" aria-label="${label} feltöltése" />
      <small class="hint">JPG / PNG / WebP, max. 10 MB — új feltöltés felülírja</small>
    </div>`;
  }

  function priceRowHtml(amount, currency, pack, source) {
    return `<div class="fc-price-row">
      <input type="number" step="any" data-pr="amount" placeholder="összeg" value="${amount != null && amount !== "" ? esc(amount) : ""}" />
      <select data-pr="currency">
        ${["USD","EUR","HUF"].map((c) => `<option value="${c}" ${currency === c ? "selected" : ""}>${c}</option>`).join("")}
      </select>
      <input type="number" step="any" data-pr="pack_size" placeholder="csomag (egység)" value="${pack != null && pack !== "" ? esc(pack) : ""}" />
      <input type="text" data-pr="source" placeholder="forrás (szabad)" value="${esc(source || "")}" />
      <button type="button" class="btn sm ghost" data-rmpr="1" aria-label="sor törlése">×</button>
    </div>`;
  }

  (function bindPriceRowDelete() {
    // delegate on the shared main element so both edit + new forms work
    document.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-rmpr]");
      if (rm) rm.closest(".fc-price-row").remove();
    });
  })();

  function collectForm(formEl) {
    const g = (n) => {
      const el = formEl.querySelector(`[name="${n}"]`);
      return el ? el.value.trim() : "";
    };
    const num = (v) => (v === "" ? null : Number(v));
    const body = { name: g("name") };
    if (!body.name) return null;
    const brand = g("brand"); if (brand) body.brand = brand;
    body.base_unit = g("base_unit") || "g";
    const ss = num(g("serving_size")); if (ss != null) body.serving_size = ss;
    const sl = g("serving_label"); if (sl) body.serving_label = sl;

    const mac = {};
    let anyMac = false;
    formEl.querySelectorAll("[data-macro]").forEach((i) => {
      const v = i.value.trim();
      if (v !== "") { const n = Number(v); if (!isNaN(n)) { mac[i.dataset.macro] = n; anyMac = true; } }
    });
    if (anyMac) {
      // C4 rule: when the macro block is present, ALL seven keys are
      // mandatory. Blank fields the user left empty become 0.
      const ALL_MACROS = ["calories", "protein", "carbs", "fat", "fiber", "sugar", "sodium"];
      body.macros_per_100 = {};
      ALL_MACROS.forEach((k) => { body.macros_per_100[k] = (k in mac) ? mac[k] : 0; });
    }

    const prices = [];
    formEl.querySelectorAll(".fc-price-row").forEach((row) => {
      const amt = row.querySelector('[data-pr="amount"]').value.trim();
      const cur = row.querySelector('[data-pr="currency"]').value;
      const pk  = row.querySelector('[data-pr="pack_size"]').value.trim();
      const src = row.querySelector('[data-pr="source"]').value.trim();
      if (amt === "" && !cur && pk === "" && !src) return; // blank row
      const entry = { amount: Number(amt), currency: cur || "USD" };
      if (pk !== "") { const n = Number(pk); if (!isNaN(n)) entry.pack_size = n; }
      if (src) entry.source = src;
      prices.push(entry);
    });
    body.prices = prices;
    return body;
  }

  async function submitForm(id) {
    const formEl = $("#fc-form");
    const body = collectForm(formEl);
    const errEl = $("#fc-form-err");
    if (errEl) errEl.textContent = "";
    if (!body) { toast("A termék neve kötelező"); return; }
    if (body.prices.some((pr) => pr.amount == null || isNaN(pr.amount))) {
      toast("Ársor: a összeg legyen szám");
      if (errEl) errEl.textContent = "Ársor: a összeg legyen szám";
      return;
    }
    // backend (validation.py:189) requires pack_size > 0 on EVERY price row
    if (body.prices.some((pr) => pr.pack_size == null || isNaN(pr.pack_size) || pr.pack_size <= 0)) {
      toast("Ársor: minden sorhoz adj meg csomagméretet");
      if (errEl) errEl.textContent = "Ársor: minden sorhoz adj meg csomagméretet";
      return;
    }
    try {
      let doc;
      if (id) doc = await api("/" + encodeURIComponent(id), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      else doc = await api("", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const newId = doc && doc.id ? doc.id : null;

      // upload any chosen photos (multipart), one slot at a time
      for (const slot of ["product_photo", "label_photo"]) {
        const fi = formEl.querySelector(`[data-slot-file="${slot}"]`);
        if (!fi || !fi.files || !fi.files[0]) continue;
        const f = fi.files[0];
        if (f.size > 10 * 1024 * 1024) { toast(`Túl nagy: ${f.name} (max 10 MB)`); continue; }
        const fd = new FormData();
        fd.append("file", f);
        await api(`/${encodeURIComponent(newId)}/images/${slot}`, { method: "POST", body: fd });
      }

      toast("Mentve: " + (body.name || doc.name));
      renderList();
      const panel = $("#fc-detail");
      if (newId) openDetail(newId);
      else { panel.hidden = true; panel.innerHTML = ""; }
    } catch (e) {
      toast("Mentési hiba: " + e.message);
      if (errEl) errEl.textContent = e.message;
    }
  }

  /* ============================================================
     SECTION 3/4 — macro counter (pair products → count)
     ============================================================ */

  // ---- product picker ---------------------------------------------
  // search box over FC.products (already loaded by renderList)
  function pickerOptions(selectedId) {
    const opts = FC.products || [];
    return opts.map((p) =>
      `<option value="${esc(p.id)}" ${p.id === selectedId ? "selected" : ""}>` +
      `${esc(p.name)}${p.brand ? " · " + esc(p.brand) : ""}</option>`
    ).join("");
  }

  function unitOptions(baseUnit, selected) {
    // offer the product's base unit + the common g/ml/pcs/pcs variants
    const all = ["g", "kg", "ml", "l", "pcs"];
    if (baseUnit && !all.includes(baseUnit)) all.push(baseUnit);
    const seen = new Set();
    const out = [];
    all.forEach((u) => { if (!seen.has(u)) { seen.add(u); out.push(u); } });
    return out.map((u) =>
      `<option value="${u}" ${u === selected ? "selected" : ""}>${u}</option>`
    ).join("");
  }

  function renderCounter() {
    // static panel lives in index.html; just (re)bind per-row handlers
    $$("#fc-rows [data-crm]").forEach((b) => b.remove());
    bindCounter();
  }

  function addRow(productId, qty, unit) {
    const wrap = $("#fc-rows");
    const p = (FC.products || []).find((x) => x.id === productId) || null;
    const div = document.createElement("div");
    div.className = "fc-row";
    div.innerHTML = `
      <select data-cp class="grow" aria-label="termék">
        ${pickerOptions(productId || (p && p.id) || "")}
      </select>
      <input type="number" step="any" min="0" data-cq value="${qty != null ? esc(qty) : ""}" placeholder="mennyiség" aria-label="mennyiség" />
      <select data-cu aria-label="egység">${unitOptions(p && p.base_unit, unit || (p && p.base_unit) || "g")}</select>
      <button class="btn sm ghost" data-crm="1" aria-label="sor törlése">×</button>`;
    wrap.appendChild(div);
    return div;
  }

  let _bound = false;
  function bindCounter() {
    const wrap = $("#fc-rows");
    if (_bound) return;
    _bound = true;
    wrap.addEventListener("click", async (e) => {
      const rm = e.target.closest("[data-crm]");
      if (rm) { rm.closest(".fc-row").remove(); return; }
    });
    wrap.addEventListener("change", (e) => {
      const sel = e.target.closest && e.target.closest("select[data-cp]");
      if (sel) {
        const p = (FC.products || []).find((x) => x.id === sel.value);
        const u = sel.closest(".fc-row").querySelector("select[data-cu]");
        if (p && u) u.innerHTML = unitOptions(p.base_unit, p.base_unit || "g");
      }
    });
    $("#fc-addrow").addEventListener("click", () => addRow("", "", "g"));
    // clear all counter rows
    const clr = $("#fc-clear-rows");
    if (clr) clr.addEventListener("click", () => { wrap.innerHTML = ""; });
    $("#fc-count-btn").addEventListener("click", doCount);
    $("#fc-load-canonical").addEventListener("click", loadCanonical);
    // product list: search + "+" create entry
    const sbtn = $("#fc-search-btn");
    if (sbtn) sbtn.addEventListener("click", () => renderList());
    const sin = $("#fc-search");
    if (sin) sin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); renderList(); } });
    const nbtn = $("#fc-new");
    if (nbtn) nbtn.addEventListener("click", () => openForm(null));
    document.addEventListener("click", (e) => {
      // delegated: recount buttons on saved meals
      const rc = e.target.closest("[data-recount]");
      if (rc) recountMeal(rc.dataset.recount);
      const rm = e.target.closest("[data-meal-rm]");
      if (rm) removeMeal(rm.dataset.mealRm);
    });
  }

  function readRows() {
    const rows = $$("#fc-rows .fc-row");
    const items = [];
    rows.forEach((r) => {
      const idp = r.querySelector("select[data-cp]").value;
      const qy = r.querySelector("[data-cq]").value.trim();
      const un = r.querySelector("select[data-cu]").value;
      if (!idp || qy === "") return;
      items.push({ product_id: idp, quantity: Number(qy), unit: un || "g" });
    });
    return items;
  }

  async function doCount() {
    const items = readRows();
    const out = $("#fc-result");
    if (!items.length) { toast("Addj hozzá legalább 1 sort termékekkel"); return; }
    out.innerHTML = '<p class="hint">Számolás…</p>';
    let res;
    try {
      res = await api("/macros/count", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
    } catch (e) {
      out.innerHTML = `<p class="hint">Hiba: ${esc(e.message)}</p>`;
      return;
    }
    FC.lastResult = res;
    FC.lastItems = items;
    renderResult(res);
    renderMeals();
  }

  function costText(c) {
    if (!c && c !== 0) return "—";
    if (typeof c === "object") return `${fmt(c.amount)} ${esc(c.currency || "")}`;
    return fmt(c);
  }
  const warnLabel = (code) => ({
    CROSS_CURRENCY_EXCLUDED: "Ár kizárva (két valuta): " + code,
    PRODUCT_NOT_FOUND: "Nem található termék",
    UNITS_INCOMPATIBLE: "Egységek nem hozhatók össze",
  }[code] || code);

  function renderResult(res) {
    const out = $("#fc-result");
    const pi = res.per_ingredient || [];
    const warnChips = (res.warnings || []).map((w) =>
      `<span class="fc-warn" title="${esc((w && w.product_id) || "")}">${esc(warnLabel(typeof w === "string" ? w : (w && w.code) || "?"))}</span>`
    ).join("");
    const rows = pi.map((r) => `
      <tr>
        <td>${esc(r.name || r.product_id)}</td>
        <td class="num">${fmt(r.quantity)} ${esc(r.unit || "")}</td>
        <td class="num">${fmt(r.macros && r.macros.calories)}</td>
        <td class="num">${fmt(r.macros && r.macros.protein)}</td>
        <td class="num">${fmt(r.macros && r.macros.carbs)}</td>
        <td class="num">${fmt(r.macros && r.macros.fat)}</td>
        <td class="num">${costText(r.cost)}</td>
        <td>${(r.warnings || []).map((w) =>
          `<span class="fc-warn sm">${esc(typeof w === "string" ? w : (w && w.code) || "?")}</span>`
        ).join("")}</td>
      </tr>`).join("");
    const t = res.totals || {};
    out.innerHTML = `
      <div class="card fc-result-card">
        <table class="fc-table">
          <thead><tr>
            <th>Termék</th><th class="num">Mennyiség</th><th class="num">kcal</th>
            <th class="num">P</th><th class="num">C</th><th class="num">F</th>
            <th class="num">Ár</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fc-totals">
          <h4>ÖSSZESÍTÉS</h4>
          <div class="fc-tt">
            <span><b>${fmt(t.calories)}</b> kcal</span>
            <span><b>${fmt(t.protein)}</b> P</span>
            <span><b>${fmt(t.carbs)}</b> C</span>
            <span><b>${fmt(t.fat)}</b> F</span>
            <span><b>${fmt(t.fiber)}</b> rost</span>
            <span><b>${fmt(t.sugar)}</b> cukor</span>
            <span><b>${fmt(t.sodium)}</b> nátrium</span>
          </div>
          <div class="fc-total-cost">
            <span class="lbl">ÖSSZES ÁR</span>
            <span class="val">${costText(res.total_cost)}</span>
          </div>
          ${warnChips ? `<div class="fc-warns">${warnChips}</div>` : ""}
          <div class="fc-actions">
            <button class="btn sm" data-meal-name>💾 Mentés</button>
            <button class="btn sm ghost" id="fc-clear-result">✕ Törölve</button>
          </div>
        </div>
      </div>`;
    // save button (inline)
    const sv = out.querySelector("[data-meal-name]");
    if (sv) sv.addEventListener("click", saveMealFromResult);
    const cl = out.querySelector("#fc-clear-result");
    if (cl) cl.addEventListener("click", () => { out.innerHTML = ""; });
  }

  // ---- save + recount my prepared foods (localStorage) ---------------
  function newId() {
    try { return crypto.randomUUID(); } catch (e) {
      return "meal-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    }
  }
  async function saveMealFromResult() {
    if (!FC.lastResult) { toast("Előbb számolj egy ételt"); return; }
    const name = prompt("Az étel neve (pl. 'Csirke rizsel')", "");
    if (!name) return;
    const meals = S.getMeals();
    meals.unshift({
      id: newId(),
      name,
      items: FC.lastItems,
      totals: FC.lastResult.totals,
      total_cost: FC.lastResult.total_cost,
      warnings: FC.lastResult.warnings || [],
      saved_at: new Date().toISOString(),
    });
    S.saveMeals(meals);
    toast("Mentve: " + name);
    renderMeals();
  }
  async function recountMeal(id) {
    const meals = S.getMeals();
    const m = meals.find((x) => x.id === id);
    if (!m) return;
    // preload rows + count
    const wrap = $("#fc-rows");
    wrap.innerHTML = "";
    (m.items || []).forEach((it) => addRow(it.product_id, it.quantity, it.unit));
    toast("Újraszámlálás: " + m.name);
    doCount();
  }
  async function removeMeal(id) {
    let meals = S.getMeals();
    const m = meals.find((x) => x.id === id);
    if (m && !confirm("Törlöd: " + m.name + "?")) return;
    meals = meals.filter((x) => x.id !== id);
    S.saveMeals(meals);
    renderMeals();
  }
  async function renderMeals() {
    const box = $("#fc-meals");
    if (!box) return;
    const meals = S.getMeals();
    if (!meals.length) {
      box.innerHTML = '<p class="hint">Nincs mentett étel.</p>';
      return;
    }
    box.innerHTML = meals.map((m) => `
      <div class="fc-meal">
        <div class="fc-meal-h">
          <b>${esc(m.name)}</b>
          <small>${new Date(m.saved_at).toLocaleDateString("hu-HU")}</small>
        </div>
        <div class="fc-meal-t">
          <span>${fmt(m.totals && m.totals.calories)} kcal</span>
          <span>${costText(m.total_cost)}</span>
          ${(m.warnings||[]).length ? `<span class="fc-warn sm">${m.warnings.length} figyelmeztés</span>` : ""}
        </div>
        <div class="fc-meal-a">
          <button class="btn sm ghost" data-recount="${esc(m.id)}">↻ Újraszámlálás</button>
          <button class="btn sm ghost" data-meal-rm="${esc(m.id)}">🗑</button>
        </div>
      </div>`).join("");
  }

  // ---- canonical demo loader (767.40 kcal / 2.05 USD) -------------
  async function loadCanonical() {
    // seed p1 (chicken breast), p2 (basmati), p3 (veg oil)
    const ids = ["p1", "p2", "p3"];
    const wrap = $("#fc-rows");
    wrap.innerHTML = "";
    ids.forEach((id, i) => {
      const qtys = [200, 100, 10];
      const units = ["g", "g", "ml"];
      addRow(id, qtys[i], units[i]);
    });
    toast("Elvárt példa betöltve: p1 200 g + p2 100 g + p3 10 ml");
    doCount();
  }

  /* ============================================================
     SECTION 4/4 — module exports
     ============================================================ */
  return {
    render,
    products: FC.products,
    // expose a couple of helpers for browser-level testing / QA hooks
    addRow, doCount, batchCanonical: loadCanonical,
    // convenience for QA: seed one row and count
    seedCanonical: loadCanonical,
  };
})();
