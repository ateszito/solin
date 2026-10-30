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
    if (res.status === 204) return null;
    if (!body) {
      throw new Error(`API ${url} returned non-JSON response (${res.status})`);
    }
    return body;
  }
  async function listProducts(search) {
    const q = search ? "?limit=50&search=" + encodeURIComponent(search) : "?limit=50";
    // Errors propagate: the list view must be able to tell "backend
    // unreachable" apart from "no products yet".
    const res = await api(q);
    return (res && Array.isArray(res.items)) ? res.items : [];
  }

  /* ============================================================
     SECTION 1/4 — view bootstrap + product list + detail panel
     ============================================================ */

  /* ---- Lightbox / Image Zoom Viewer ---------------------------- */
  function openImageViewer(src, title) {
    if (!src) return;
    let overlay = document.querySelector("#solin-lightbox");
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = "solin-lightbox";
    overlay.className = "solin-lightbox-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    let scale = 1.0;
    let translateX = 0;
    let translateY = 0;
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialPinchDist = null;

    overlay.innerHTML = `
      <div class="solin-lightbox-header">
        <span class="solin-lightbox-title">${esc(title || "Fotó nagyítása")}</span>
        <div class="solin-lightbox-tools">
          <button type="button" class="btn sm ghost" id="lb-zoom-out" title="Kicsinyítés">－</button>
          <button type="button" class="btn sm ghost" id="lb-zoom-reset" title="Alaphelyzet">100%</button>
          <button type="button" class="btn sm ghost" id="lb-zoom-in" title="Nagyítás">＋</button>
          <button type="button" class="btn sm ghost lb-close" id="lb-close" title="Bezárás">✕</button>
        </div>
      </div>
      <div class="solin-lightbox-viewport" id="lb-viewport">
        <img id="lb-img" class="solin-lightbox-img" src="${esc(src)}" alt="" draggable="false" />
      </div>
      <div class="solin-lightbox-footer">
        <span>💡 Két ujjal (pinch) vagy a ＋ / － gombokkal nagyíthatsz és mozgathatod a képet</span>
      </div>
    `;

    document.body.appendChild(overlay);

    const imgEl = overlay.querySelector("#lb-img");
    const viewport = overlay.querySelector("#lb-viewport");
    const resetBtn = overlay.querySelector("#lb-zoom-reset");

    function updateTransform() {
      scale = Math.max(0.5, Math.min(scale, 5.0));
      imgEl.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      if (resetBtn) resetBtn.textContent = `${Math.round(scale * 100)}%`;
      viewport.style.cursor = scale > 1 ? "grab" : "default";
    }

    const close = () => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
    };

    function onKeyDown(e) {
      if (e.key === "Escape") close();
      else if (e.key === "+" || e.key === "=") { scale += 0.25; updateTransform(); }
      else if (e.key === "-") { scale -= 0.25; updateTransform(); }
      else if (e.key === "0") { scale = 1; translateX = 0; translateY = 0; updateTransform(); }
    }
    document.addEventListener("keydown", onKeyDown);

    overlay.querySelector("#lb-close").addEventListener("click", close);
    overlay.querySelector("#lb-zoom-in").addEventListener("click", () => { scale += 0.35; updateTransform(); });
    overlay.querySelector("#lb-zoom-out").addEventListener("click", () => { scale -= 0.35; updateTransform(); });
    overlay.querySelector("#lb-zoom-reset").addEventListener("click", () => { scale = 1; translateX = 0; translateY = 0; updateTransform(); });

    // Double-tap or double-click to toggle zoom
    let lastTap = 0;
    viewport.addEventListener("click", (e) => {
      if (e.target === viewport) close();
    });
    imgEl.addEventListener("click", () => {
      const now = Date.now();
      if (now - lastTap < 300) {
        if (scale > 1.2) {
          scale = 1; translateX = 0; translateY = 0;
        } else {
          scale = 2.5;
        }
        updateTransform();
      }
      lastTap = now;
    });

    // Mouse wheel zoom
    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.2 : -0.2;
      scale += delta;
      updateTransform();
    }, { passive: false });

    // Mouse drag
    viewport.addEventListener("mousedown", (e) => {
      if (e.target !== imgEl && e.target !== viewport) return;
      isDragging = true;
      startX = e.clientX - translateX;
      startY = e.clientY - translateY;
      viewport.style.cursor = "grabbing";
    });
    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      translateX = e.clientX - startX;
      translateY = e.clientY - startY;
      updateTransform();
    });
    window.addEventListener("mouseup", () => {
      isDragging = false;
      viewport.style.cursor = scale > 1 ? "grab" : "default";
    });

    // Touch events (mobile pinch-to-zoom + pan)
    function touchDist(t1, t2) {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    viewport.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        isDragging = true;
        startX = e.touches[0].clientX - translateX;
        startY = e.touches[0].clientY - translateY;
      } else if (e.touches.length === 2) {
        isDragging = false;
        initialPinchDist = touchDist(e.touches[0], e.touches[1]);
      }
    }, { passive: true });

    viewport.addEventListener("touchmove", (e) => {
      if (e.touches.length === 1 && isDragging) {
        translateX = e.touches[0].clientX - startX;
        translateY = e.touches[0].clientY - startY;
        updateTransform();
      } else if (e.touches.length === 2 && initialPinchDist != null) {
        const dist = touchDist(e.touches[0], e.touches[1]);
        const factor = dist / initialPinchDist;
        scale = Math.max(0.5, Math.min(5.0, scale * factor));
        initialPinchDist = dist;
        updateTransform();
      }
    }, { passive: true });

    viewport.addEventListener("touchend", () => {
      isDragging = false;
      initialPinchDist = null;
    }, { passive: true });
  }

  /* ---- list rendering with macro progress bars ------------------- */
  function macroVisualBars(m, nPrices) {
    if (!m) return "";
    const cal = m.calories != null ? Math.round(m.calories) : null;
    const p = m.protein != null ? Number(m.protein) : 0;
    const f = m.fat != null ? Number(m.fat) : 0;
    const c = m.carbs != null ? Number(m.carbs) : 0;
    const s = m.sugar != null ? Number(m.sugar) : null;
    const fib = m.fiber != null ? Number(m.fiber) : null;

    const bar = (label, shortL, val, cls) => {
      if (val == null || isNaN(val) || val <= 0) return "";
      const pct = Math.min(100, Math.max(0, val));
      return `
        <div class="fc-bar-item ${cls}" title="${label}: ${fmt(val)} g / 100g">
          <div class="fc-bar-header">
            <span class="fc-bar-tag">${shortL}</span>
            <span class="fc-bar-val">${fmt(val)}<small>g</small></span>
          </div>
          <div class="fc-bar-track">
            <div class="fc-bar-fill" style="width: ${pct}%;"></div>
          </div>
        </div>
      `;
    };

    return `
      <div class="fc-macro-summary">
        <div class="fc-macro-head-row">
          ${cal != null ? `<span class="fc-cal-badge">🔥 <b>${cal}</b> kcal<small>/100g</small></span>` : ""}
          <span class="fc-chip muted">${nPrices} ár</span>
        </div>
        <div class="fc-macro-bars">
          ${bar("Fehérje", "Fehérje", p, "bar-p")}
          ${bar("Zsír", "Zsír", f, "bar-f")}
          ${bar("Szénhidrát", "Szénhidrát", c, "bar-c")}
          ${s != null && s > 0 ? bar("Cukor", "Cukor", s, "bar-s") : ""}
          ${fib != null && fib > 0 ? bar("Rost", "Rost", fib, "bar-fib") : ""}
        </div>
      </div>
    `;
  }

  function fmt(v) {
    if (v == null) return "–";
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    return (Math.round(n * 100) / 100).toString();
  }
  function imgSrc(url) {
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
    const sk = '<li class="fc-product skeleton" aria-hidden="true"><span class="fc-thumb-none sk-block"></span>' +
      '<span class="fc-main"><span class="sk-line" style="width:55%"></span><span class="sk-line" style="width:80%"></span></span></li>';
    box.innerHTML = '<li class="sr-only" role="status">Termékek betöltése…</li>' + sk + sk + sk;
    const q = ($("#fc-search") || {}).value || "";
    let items;
    try {
      items = await listProducts(q.trim());
    } catch (e) {
      console.warn("[FoodCounter] listProducts failed:", e);
      FC.products = FC.products || [];
      box.innerHTML = `<li class="hint">A terméklista most nem érhető el (${esc(e.message)}). ` +
        `<button type="button" class="btn sm" data-fc-retry>Újrapróbálás</button></li>`;
      const retry = box.querySelector("[data-fc-retry]");
      if (retry) retry.addEventListener("click", () => renderList());
      return;
    }
    FC.products = items;
    const countEl = $("#fc-count");
    if (countEl) countEl.textContent = items.length + " termék";
    if (!items.length) {
      box.innerHTML = q.trim()
        ? `<li class="hint">Nincs találat erre: „${esc(q.trim())}”.</li>`
        : '<li class="hint">Még nincs termék — az „+ Új termék” gombbal hozhatsz létre egyet.</li>';
      return;
    }
    box.innerHTML = items.map((p) => {
      const img = p.images && p.images.product_photo && p.images.product_photo.url;
      const nPrices = (p.prices || []).length;
      return `<li class="fc-product" data-open="${esc(p.id)}" role="button" tabindex="0"
        aria-label="${esc(p.name)} részletei">
        <span class="fc-thumb" ${img ? `data-view-img="${esc(imgSrc(img))}" title="Fotó nagyítása"` : ""}>${img
          ? `<img src="${esc(imgSrc(img))}" alt="" loading="lazy" />`
          : '<span class="fc-thumb-none">▣</span>'}</span>
        <span class="fc-main">
          <span class="fc-name">${esc(p.name)}${p.brand ? `<small> · ${esc(p.brand)}</small>` : ""}</span>
          ${macroVisualBars(p.macros_per_100, nPrices)}
        </span>
        <span class="fc-open" aria-hidden="true">›</span>
      </li>`;
    }).join("");

    $$("#fc-product-list [data-open]").forEach((li) => {
      const id = li.dataset.open;
      const thumb = li.querySelector("[data-view-img]");
      if (thumb) {
        thumb.addEventListener("click", (e) => {
          e.stopPropagation();
          const pName = li.querySelector(".fc-name")?.textContent || "Termékfotó";
          openImageViewer(thumb.dataset.viewImg, pName);
        });
      }
      const open = () => openDetail(id);
      li.addEventListener("click", open);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  }

  /* ---- detail panel ------------------------------------------------ */
  async function openDetail(id) {
    const panel = $("#fc-detail");
    panel.hidden = false;
    panel.innerHTML = '<div class="skeleton" aria-busy="true"><span class="sk-line" style="width:40%;height:18px"></span>' +
      '<span class="sk-line" style="width:70%"></span><span class="sk-block" style="height:64px"></span></div>';
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    let p;
    try {
      p = await api("/" + encodeURIComponent(id));
    } catch (e) {
      panel.innerHTML = `<p class="hint">Nem sikerült betölteni a terméket (${esc(e.message)}).</p>`;
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
          ? `<img src="${esc(imgSrc(s.url))}" alt="${label}" title="Koppints a fotó nagyításához" />`
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
      <h4>Tápanyag / 100 ${esc(p.base_unit || "egység")}</h4>
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
      <h4>Fotók <small class="hint">(koppints a nagyításhoz)</small></h4>
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
        toast("Törölve: " + del.dataset.fcdelnm);
        back();
        renderList();
      } catch (e) { toast("Törlési hiba: " + e.message); }
    });

    // Wire photos to lightbox
    panel.querySelectorAll(".fc-slot img").forEach((imgEl) => {
      imgEl.style.cursor = "zoom-in";
      imgEl.addEventListener("click", () => {
        openImageViewer(imgEl.src, p.name || "Termékfotó");
      });
    });
  }

  /* ============================================================
     SECTION 2/4 — product create/edit form + photo upload
     ============================================================ */
  function openForm(idOrNull) {
    FC.stagedSlots = {};
    const panel = $("#fc-detail");
    const isEdit = !!idOrNull;
    panel.hidden = false;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    if (isEdit) fillForm(idOrNull);
    else resetForm();
  }

  async function fillForm(id) {
    const isEdit = !!id;
    const panel = $("#fc-detail");
    panel.innerHTML = '<p class="hint">Betöltés…</p>';
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
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
          ? `<img src="${esc(imgSrc(s.url))}" alt="" data-slot-preview="${slot}" title="Koppints a nagyításhoz" />`
          : ""}
        <input type="file" accept="image/jpeg,image/png,image/webp"
               data-slot-file="${slot}"
               aria-label="${label} feltöltése" />
        <div data-slot-status="${slot}"></div>
        <small class="hint">JPG / PNG / WebP — automatikusan optimalizálva a feltöltéshez</small>
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

        <h4>Tápanyag / 100 egység (opcionális, tizedestört)</h4>
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

    // Wire existing preview images to lightbox
    panel.querySelectorAll(".fc-slot-upload img").forEach((imgEl) => {
      imgEl.style.cursor = "zoom-in";
      imgEl.addEventListener("click", () => openImageViewer(imgEl.src, "Feltöltött fotó"));
    });

    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => {
      const nameInp = panel.querySelector('input[name="name"]');
      if (nameInp) nameInp.focus();
    }, 120);

    bindSlotUploads(panel);
  }

  function resetForm() {
    const panel = $("#fc-detail");
    FC.editingId = null;
    FC.stagedSlots = {};
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
        <h4>Tápanyag / 100 egység (opcionális)</h4>
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

    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => {
      const nameInp = panel.querySelector('input[name="name"]');
      if (nameInp) nameInp.focus();
    }, 120);

    bindSlotUploads(panel);
  }

  // slotField without needing a product doc (new-product form)
  function slotFieldHtml(slot, label) {
    return `<div class="fc-slot-upload">
      <span class="fc-slot-label">${label}</span>
      <input type="file" accept="image/jpeg,image/png,image/webp"
             data-slot-file="${slot}" aria-label="${label} feltöltése" />
      <div data-slot-status="${slot}"></div>
      <small class="hint">JPG / PNG / WebP — automatikusan optimalizálva a feltöltéshez</small>
    </div>`;
  }

  /* ---- Image Compression & OCR Binding ---- */
  function bindSlotUploads(panel) {
    FC.stagedSlots = FC.stagedSlots || {};
    panel.querySelectorAll("[data-slot-file]").forEach((input) => {
      const slot = input.dataset.slotFile;
      const statusEl = panel.querySelector(`[data-slot-status="${slot}"]`);

      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;

        if (statusEl) {
          statusEl.innerHTML = `<span class="hint" style="color:var(--text-2);">📷 Kép tömörítése és optimalizálása...</span>`;
        }

        try {
          const comp = await (window.SolinImg
            ? SolinImg.compress(file)
            : Promise.resolve({ file: file, blob: file, compressedSize: file.size, originalSize: file.size }));
          FC.stagedSlots[slot] = comp;

          // Render / update preview thumbnail
          let previewEl = panel.querySelector(`[data-slot-preview="${slot}"]`);
          if (previewEl && comp.dataUrl) {
            previewEl.src = comp.dataUrl;
            previewEl.style.cursor = "zoom-in";
            previewEl.onclick = () => openImageViewer(previewEl.src, "Feltöltött fotó");
          } else if (comp.dataUrl) {
            const wrap = input.closest(".fc-slot-upload");
            if (wrap && !wrap.querySelector(`img[data-slot-preview="${slot}"]`)) {
              const img = document.createElement("img");
              img.src = comp.dataUrl;
              img.dataset.slotPreview = slot;
              img.style.cursor = "zoom-in";
              img.title = "Koppints a fotó nagyításához";
              img.addEventListener("click", () => openImageViewer(img.src, "Feltöltött fotó"));
              input.insertAdjacentElement("beforebegin", img);
            }
          }

          const ratioText = comp.ratio ? ` (-${comp.ratio}%)` : "";
          const origText = window.SolinImg ? SolinImg.formatBytes(file.size) : `${Math.round(file.size / 1024)} KB`;
          const compText = window.SolinImg ? SolinImg.formatBytes(comp.compressedSize) : `${Math.round(comp.compressedSize / 1024)} KB`;

          if (statusEl) {
            statusEl.innerHTML = `
              <div class="fc-slot-preview-wrap">
                <span class="fc-compress-badge">✓ Optimalizálva: ${origText} → ${compText}${ratioText}</span>
              </div>
            `;
          }

          // If label_photo: run OCR to extract nutrition data
          if (slot === "label_photo") {
            runLabelOcr(panel, comp, statusEl);
          }
        } catch (err) {
          console.error("Compression error:", err);
          if (statusEl) {
            statusEl.innerHTML = `<span class="hint err">Hiba az optimalizálás során: ${esc(err.message)}</span>`;
          }
        }
      });
    });
  }

  async function runLabelOcr(panel, comp, statusEl) {
    if (!window.SolinImg || !SolinImg.extractNutrition) return;

    let ocrBox = statusEl.querySelector(".fc-ocr-box");
    if (!ocrBox) {
      ocrBox = document.createElement("div");
      ocrBox.className = "fc-ocr-box";
      statusEl.appendChild(ocrBox);
    }
    ocrBox.innerHTML = `
      <div class="fc-ocr-status">
        <span class="fc-ocr-spinner"></span>
        <span class="fc-ocr-text">🔍 Címke olvasása (makrók kiolvasása)...</span>
      </div>
    `;

    try {
      const imgSource = comp.canvas || comp.dataUrl || comp.blob;
      const res = await SolinImg.extractNutrition(imgSource, (prog) => {
        const textEl = ocrBox.querySelector(".fc-ocr-text");
        if (textEl && prog.message) textEl.textContent = prog.message;
      });

      const macros = res && res.macros ? res.macros : {};
      const MACRO_KEYS = ["calories", "protein", "carbs", "fat", "fiber", "sugar", "sodium"];
      const detected = {};
      let count = 0;
      MACRO_KEYS.forEach((k) => {
        if (macros[k] != null && !isNaN(macros[k])) {
          detected[k] = macros[k];
          count++;
        }
      });

      if (count === 0) {
        ocrBox.className = "fc-ocr-box";
        ocrBox.innerHTML = `
          <div class="hint" style="margin:0;">
            ℹ️ Nem sikerült egyértelmű makrókat felismerni a képen. A mezők manuálisan kitölthetők.
          </div>
        `;
        return;
      }

      // Check if existing macro values exist in form
      const formEl = panel.querySelector("#fc-form");
      const existing = {};
      let hasExisting = false;
      MACRO_KEYS.forEach((k) => {
        const inp = formEl.querySelector(`[data-macro="${k}"]`);
        if (inp && inp.value.trim() !== "") {
          const num = Number(inp.value.trim());
          if (!isNaN(num)) {
            existing[k] = num;
            hasExisting = true;
          }
        }
      });

      const labels = {
        calories: "Kalória (kcal)",
        protein: "Fehérje (g)",
        carbs: "Szénhidrát (g)",
        fat: "Zsír (g)",
        fiber: "Rost (g)",
        sugar: "Cukor (g)",
        sodium: "Nátrium (mg)"
      };

      const photoSrc = comp.dataUrl || (comp.blob ? URL.createObjectURL(comp.blob) : null);

      if (hasExisting) {
        showMacroCompareModal(existing, detected, labels, (editedMacros) => {
          applyMacros(formEl, editedMacros || detected);
          ocrBox.className = "fc-ocr-box fc-ocr-success";
          ocrBox.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <span>✓ Makrók sikeresen frissítve a fotó alapján!</span>
              ${photoSrc ? `<button type="button" class="btn sm ghost fc-zoom-label-btn" style="padding:2px 8px;font-size:12px;">🔍 Fotó ellenőrzése</button>` : ""}
            </div>
          `;
          if (photoSrc) {
            const btn = ocrBox.querySelector(".fc-zoom-label-btn");
            if (btn) btn.addEventListener("click", () => openImageViewer(photoSrc, "Címkefotó"));
          }
          toast("✓ Makrók frissítve a címkefotó alapján!");
        }, photoSrc);
      } else {
        applyMacros(formEl, detected);
        ocrBox.className = "fc-ocr-box fc-ocr-success";
        ocrBox.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <span>✓ ${count} makró automatikusan beillesztve a fotóból!</span>
            ${photoSrc ? `<button type="button" class="btn sm ghost fc-zoom-label-btn" style="padding:2px 8px;font-size:12px;">🔍 Fotó ellenőrzése</button>` : ""}
          </div>
        `;
        if (photoSrc) {
          const btn = ocrBox.querySelector(".fc-zoom-label-btn");
          if (btn) btn.addEventListener("click", () => openImageViewer(photoSrc, "Címkefotó"));
        }
        toast("✓ Makrók automatikusan beillesztve a fotóból!");
      }
    } catch (err) {
      console.warn("[FoodCounter] OCR extraction error:", err);
      ocrBox.className = "fc-ocr-box";
      ocrBox.innerHTML = `
        <div class="hint" style="margin:0;">
          ℹ️ Címkeolvasás: ${esc(err.message || "nem sikerült automatikusan")}
        </div>
      `;
    }
  }

  function applyMacros(formEl, macros) {
    for (const [k, v] of Object.entries(macros)) {
      if (v == null) continue;
      const inp = formEl.querySelector(`[data-macro="${k}"]`);
      if (inp) {
        inp.value = v;
        inp.classList.remove("macro-updated-flash");
        void inp.offsetWidth; // trigger reflow for smooth re-trigger
        inp.classList.add("macro-updated-flash");
      }
    }
  }

  function showMacroCompareModal(current, detected, labels, onConfirm, photoSrc) {
    let overlay = document.querySelector("#fc-macro-modal");
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = "fc-macro-modal";
    overlay.className = "fc-modal-overlay";

    const keys = ["calories", "protein", "carbs", "fat", "fiber", "sugar", "sodium"];
    const rowsHtml = keys.map((k) => {
      const curVal = current[k] != null ? current[k] : "—";
      const newVal = detected[k] != null ? detected[k] : "";
      const isDiff = detected[k] != null && current[k] !== detected[k];
      return `
        <tr>
          <td><b>${labels[k] || k}</b></td>
          <td class="fc-compare-cur">${curVal}</td>
          <td>
            <input type="number" step="any"
                   class="fc-compare-input ${isDiff ? "fc-input-diff" : ""}"
                   data-compare-key="${k}"
                   value="${newVal !== "" ? esc(newVal) : ""}"
                   placeholder="—"
                   aria-label="${labels[k] || k}" />
            ${isDiff ? `<span style="color:var(--success);font-weight:700;margin-left:4px;" title="Módosul">★</span>` : ""}
          </td>
        </tr>
      `;
    }).join("");

    const photoCardHtml = photoSrc ? `
      <div class="fc-compare-photo-card" id="fc-modal-photo-trigger" role="button" tabindex="0" title="Kattints a fotó nagyításához">
        <img src="${esc(photoSrc)}" class="fc-compare-photo-img" alt="Címkefotó előnézet" />
        <div class="fc-compare-photo-meta">
          <span class="fc-compare-photo-btn">🔍 Címkefotó nagyítása és ellenőrzése</span>
          <small>Koppints a kép megnyitásához, zoomolásához, hogy kényelmesen leolvashasd az értékeket!</small>
        </div>
      </div>
    ` : "";

    overlay.innerHTML = `
      <div class="fc-modal-card" style="max-width:480px;">
        <div class="fc-modal-header">
          <h3>Frissíted a makrókat a fotó alapján?</h3>
          <button type="button" class="btn sm ghost" id="fc-modal-close" style="font-size:16px;padding:2px 8px;">✕</button>
        </div>
        <p class="hint" style="margin:0 0 8px;">
          A feltöltött címkefotóból az alábbi értékeket olvastuk ki. Szükség esetén az értékeket szerkesztheted is mentés előtt:
        </p>
        ${photoCardHtml}
        <table class="fc-compare-table">
          <thead>
            <tr>
              <th>Tápanyag</th>
              <th>Jelenlegi</th>
              <th>Új érték (szerkeszthető)</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
        <div class="fc-modal-actions">
          <button type="button" class="btn sm ghost" id="fc-modal-cancel">Megtartom a régit</button>
          <button type="button" class="btn sm primary" id="fc-modal-apply">Értékek alkalmazása</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector("#fc-modal-close").addEventListener("click", close);
    overlay.querySelector("#fc-modal-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    if (photoSrc) {
      const trigger = overlay.querySelector("#fc-modal-photo-trigger");
      if (trigger) {
        trigger.addEventListener("click", () => openImageViewer(photoSrc, "Címkefotó nagyítása"));
        trigger.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openImageViewer(photoSrc, "Címkefotó nagyítása");
          }
        });
      }
    }

    overlay.querySelector("#fc-modal-apply").addEventListener("click", () => {
      const edited = {};
      overlay.querySelectorAll("[data-compare-key]").forEach((inp) => {
        const k = inp.dataset.compareKey;
        const val = inp.value.trim();
        if (val !== "") {
          const num = Number(val);
          if (!isNaN(num)) edited[k] = num;
        }
      });
      close();
      if (typeof onConfirm === "function") onConfirm(edited);
    });
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
      toast("Ársor: az összeg legyen szám");
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

      // upload any chosen photos (multipart), one slot at a time with client-side compression
      for (const slot of ["product_photo", "label_photo"]) {
        let fileToUpload = null;
        if (FC.stagedSlots && FC.stagedSlots[slot]) {
          fileToUpload = FC.stagedSlots[slot].file || FC.stagedSlots[slot].blob;
        } else {
          const fi = formEl.querySelector(`[data-slot-file="${slot}"]`);
          if (fi && fi.files && fi.files[0]) {
            fileToUpload = fi.files[0];
          }
        }
        if (!fileToUpload) continue;

        // Ensure compression before wire transfer (guarantees <1MB)
        if (window.SolinImg && (!FC.stagedSlots || !FC.stagedSlots[slot])) {
          try {
            const comp = await SolinImg.compress(fileToUpload);
            fileToUpload = comp.file || comp.blob;
          } catch (e) {
            console.warn("Fallback to raw file on compression failure:", e);
          }
        }

        const fd = new FormData();
        fd.append("file", fileToUpload);
        await api(`/${encodeURIComponent(newId)}/images/${slot}`, { method: "POST", body: fd });
      }
      FC.stagedSlots = {};

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
    // portions view param (design/PORTIONS.md §2): default 1, invalid → 1.
    const pn = (() => {
      const v = parseInt($("#fc-portions-in") && $("#fc-portions-in").value, 10);
      return Number.isInteger(v) && v >= 1 && v <= 999 ? v : 1;
    })();
    out.innerHTML = '<p class="hint">Számolás…</p>';
    let res;
    try {
      res = await api("/macros/count", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pn > 1 ? { items, portions: pn } : { items }),
      });
    } catch (e) {
      out.innerHTML = `<p class="hint">Hiba: ${esc(e.message)}</p>`;
      return;
    }
    FC.lastResult = res;
    FC.lastItems = items;
    FC.lastPortions = pn;
    renderResult(res);
    renderMeals();
  }

  function costText(c) {
    if (!c && c !== 0) return "—";
    if (typeof c === "object") return `${fmt(c.amount)} ${esc(c.currency || "")}`;
    return fmt(c);
  }
  // per-portion price split (t_55b88129). Trust the server's
  // per_portion_cost when present; else re-split the whole-batch total
  // client-side with HALF_UP 2dp (integer string math, same C2 contract
  // as pairing.js halfUp2) so the counter never shows float artifacts.
  function ppcOf(res, n) {
    const N = Number.isInteger(n) && n >= 1 ? n : 1;
    if (res.per_portion_cost && typeof res.per_portion_cost === "object") {
      return res.per_portion_cost;
    }
    const c = res.total_cost;
    if (!c || c.amount == null) return null;
    let s = String(c.amount).replace(/^[+-]/, "");
    const dot = s.indexOf(".");
    let ip, fp = "";
    if (dot === -1) { ip = s; } else { ip = s.slice(0, dot); fp = s.slice(dot + 1); }
    ip = String(ip || "0").replace(/^0+(?=\d)/, "");
    fp = (fp + "000").slice(0, 3);
    const d3 = (ip + fp) * 1;                       // amount * 1000, exact
    const r = Math.floor(d3 / N / 10) + (((d3 / N) % 10) >= 5 ? 1 : 0);
    return { amount: r / 100, currency: c.currency };
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
            <span class="lbl">ÖSSZES ÁR${(FC.lastPortions > 1) ? ` (${FC.lastPortions} adag)` : ""}</span>
            <span class="val">${costText(res.total_cost)}</span>
            ${(FC.lastPortions > 1 && ppcOf(res, FC.lastPortions)) ? `<span class="lbl">ÁR / ADAG</span><span class="val">${costText(ppcOf(res, FC.lastPortions))}</span>` : ""}
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
      portions: FC.lastPortions || 1,
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
          <span>${costText(m.total_cost)}${(m.portions > 1 && ppcOf(m, m.portions)) ? ` <small>(${fmt(ppcOf(m, m.portions))}/adag)</small>` : ""}</span>
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
