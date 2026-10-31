/* ============================================================
   Solin v3 — detail.js
   Recipe detail: video (with synced steps), macro cards,
   ingredients checklist w/ substitutes, description, actions.
   ============================================================ */

window.Detail = (function () {
  const { $, $$, S, state, esc, openEdit, go, toast } = window.Solin;
  const checked = {};          // {recipeId: Set} — cache, backed by SolinStore

  function getChecked(id) {
    if (!checked[id]) checked[id] = new Set(S.getChecks(id));
    return checked[id];
  }
  function persistChecked(id) {
    S.setChecks(id, Array.from(getChecked(id)));
  }

  /* ---- cooking mode: keep the screen awake while cooking ---- */
  let wakeLock = null;
  let cooking = false;
  async function acquireWakeLock() {
    try {
      if (navigator.wakeLock && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (e) { wakeLock = null; }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  // The browser drops the lock when the tab is hidden — take it back.
  document.addEventListener("visibilitychange", () => {
    if (cooking && document.visibilityState === "visible") acquireWakeLock();
  });
  function leave() {
    cooking = false;
    releaseWakeLock();
    document.body.classList.remove("cooking");
  }

  /* ---- ingredient rows (ONE renderer for base + scaled mode) ----
     scaleRes = null → seed quantities; otherwise a SolinScale result
     (scaled amount + unit, anchor/manual badges, changed values
     highlighted). The <li data-idx=…> shape is identical in both modes so
     the delegated check-off handler keeps working. Seed data is never
     mutated — scaled values live only in the render layer. */
  function rowsHTML(r, scaleRes) {
    const set = getChecked(r.id);
    const Scaler = window.SolinScale;
    const baseMap = {};
    (r.ingredients || []).forEach((i) => { baseMap[i.name] = i; });
    const list = scaleRes ? scaleRes.items : (r.ingredients || []);
    return list.map((it) => {
      const seed = baseMap[it.name] || {};
      const on = set.has(it.name);
      const subs = S.subsFor(it.name);
      const subLine = subs.length ? `<span class="ing-alt">↳ alternatíva: ${esc(subs.join(" · "))}</span>` : "";
      let qtyHtml, extraCls = "", badge = "";
      if (scaleRes) {
        if (it.manual) {
          qtyHtml = `<b class="ing-manual-base" title="Nem skálázható — az alap marad">${esc(seed.qty || it.baseQty || "")}</b>`;
          badge = `<span class="scale-badge manual">manuális</span>`;
        } else {
          const txt = Scaler.fmtAmount(it.amount, it.unit);
          qtyHtml = it.scaled ? `<b class="ing-scaled">${esc(txt)}</b>` : `<b>${esc(txt)}</b>`;
          if (it.scaled) extraCls = " scaled";
        }
        if (scaleRes.anchor && scaleRes.anchor.name === it.name) {
          badge = `<span class="scale-badge anchor" title="Választott horgony — a megadott mennyiség">★ horgony</span>`;
        }
      } else {
        qtyHtml = `<b>${esc(seed.qty || "")}</b>`;
      }
      return `<li class="${on ? "done" : ""}${extraCls}" data-idx="${esc(it.name)}" role="checkbox" tabindex="0" aria-checked="${on}">
            <span class="ing-ck">${on ? "✓" : ""}</span>
            <span class="ing-text">${qtyHtml} ${esc(it.name)}${seed.note ? ` <span class="muted">(${esc(seed.note)})</span>` : ""}${badge}${subLine}</span>
          </li>`;
    }).join("");
  }

  function hintHTML(scaleRes) {
    return scaleRes
      ? `Skálázva: <b>${esc(window.SolinScale.fmtFactor(scaleRes.factor))}</b> · horgony: ${esc(scaleRes.anchor ? scaleRes.anchor.name : "—")} — a kiemelt értékek változtak. <button class="btn sm ghost" id="scale-reset-inline" type="button">↺ Alap mennyiségek</button>`
      : `Koppints a hozzávalóra, ha már előkészítetted — zöld ✓ jelzi. A pipák megmaradnak, ha később visszajössz.`;
  }

  function macroCards(r) {
    const m = r.macrosPerServing || {};
    if (m.kcal == null && m.protein == null && m.carbs == null && m.fat == null) return "";
    const items = [
      [m.kcal, "kcal / adag"],
      [m.protein, "g fehérje"],
      [m.carbs, "g szénhidrát"],
      [m.fat, "g zsír"]
    ];
    return `<div class="macro-cards">${items
      .map(([v, l]) => `<div class="macro-card"><div class="num">${esc(v ?? "–")}</div><div class="lbl">${l}</div></div>`)
      .join("")}</div>`;
  }

  function scaleSection(r) {
    return `<div class="detail-section" id="scale-section">
      <button type="button" class="sec-head" data-toggle="scale" aria-expanded="false">
        <span>⚖️ Recept skálázása</span>
        <span class="scale-factor" id="scale-factor">×1.00</span>
      </button>
      <div class="sec-body" id="scale-body">
        <div class="scale-panel" id="scale-panel" style="border:none; padding:10px 0 0; background:transparent;">
          <p class="scale-help" style="margin-top:0;">Ha ennyi van belőled: válassz hozzávalót, írd be, mennyid van, és átszámolom a többit.</p>
          <form class="scale-controls" id="scale-form" autocomplete="off">
            <select id="scale-anchor" class="grow" aria-label="Skálázó hozzávaló (horgony)"></select>
            <input id="scale-available" type="number" min="0" step="any" inputmode="decimal" aria-label="Elérhető mennyiség" />
            <span id="scale-unit" class="scale-unit"></span>
            <button type="submit" class="btn primary" id="scale-apply">Skálázom →</button>
          </form>
          <div class="scale-status hidden" id="scale-status" role="status"></div>
        </div>
      </div>
    </div>`;
  }

  function ingredientSection(r) {
    const id = getChecked(r.id);
    const total = (r.ingredients || []).length;
    const done = (r.ingredients || []).filter((i) => id.has(i.name)).length;

    return `<div class="detail-section">
      <button type="button" class="sec-head" data-toggle="ing" aria-expanded="true">
        <span>🥕 Hozzávalók</span>
        <span>${done}/${total}</span>
      </button>
      <div class="sec-body open">
        <div class="ing-progress"><span>${done} / ${total} kijelölve</span><div class="prog-bar"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div>
          <button type="button" class="btn sm ghost${done ? "" : " hidden"}" id="ing-clear">Pipák törlése</button></div>
        <ul class="ing-list" id="ing-list">${rowsHTML(r, null)}</ul>
        <p class="hint" style="margin-top:10px" id="ing-hint">${hintHTML(null)}</p>
      </div>
    </div>`;
  }

  function stepsSection(r) {
    const rows = (r.steps || [])
      .map((s, i) => `<li data-step="${i}" data-t="${s.t || 0}" tabindex="0" role="button" aria-label="${i + 1}. lépés — ugrás a videóban ide: ${esc(fmt(s.t))}">
        <span class="step-no"></span>
        <div class="step-t"><span class="t">${fmt(s.t)}</span> ${esc(s.text)}</div>
      </li>`)
      .join("");
    return `<div class="detail-section">
      <button type="button" class="sec-head" data-toggle="steps" aria-expanded="true">
        <span>👨‍🍳 Elkészítés ${r.video ? "(videó-szinkron)" : ""}</span>
      </button>
      <div class="sec-body open">
        <ol class="step-list" id="step-list">${rows || `<li class="hint">Még nincsenek lépések.</li>`}</ol>
        ${r.video ? `<p class="hint" style="margin-top:10px">Lejátszás közben az aktuális lépés kiemelődik. Egy lépésre koppintva oda ugrik a videó.</p>` : ""}
      </div>
    </div>`;
  }

  function transcriptSection(r) {
    if (!r.transcript || !r.transcript.trim()) return "";
    return `<div class="detail-section" id="transcript-section">
      <button type="button" class="sec-head" data-toggle="transcript" aria-expanded="false">
        <span>📝 Videó leirat</span>
      </button>
      <div class="sec-body" id="transcript-body">
        <p class="hint" style="margin-top:6px;margin-bottom:8px;">A videó elhangzott szövege és időzítései:</p>
        <div style="font-size:13px;line-height:1.6;color:var(--text,#1e293b);background:var(--surface-sunken,#f8fafc);padding:10px 12px;border-radius:8px;white-space:pre-wrap;max-height:220px;overflow-y:auto;border:1px solid var(--border,#e2e8f0);">${esc(r.transcript)}</div>
      </div>
    </div>`;
  }

  function fmt(t) {
    if (t == null) return "";
    const m = Math.floor(t / 60), s = Math.round(t % 60);
    return (m ? m + ":" + String(s).padStart(2, "0") : s + " mp");
  }

  function render(id) {
    const r = S.getRecipe(id);
    const box = $("#recipe-detail");
    leave();   // a fresh recipe page never starts in cooking mode
    if (!r) { box.innerHTML = `<p class="empty">Nincs ilyen recept.</p>`; return; }
    const hasEdits = S.hasEdits(r.id);
    // t_1fbc1ef4 (contract §14.2-C3): the ≥700px two-column CSS (.detail-wrap
    // grid + sticky .detail-media) was DEAD — render() emitted .detail-media,
    // .detail-head and flat content flow with NO wrapper, so the portrait
    // video scrolled as one block with the content (DEFECT-3 latent symptom).
    // Build the real wrapper now: media column (pins via sticky top:76px) +
    // main content column. Document scroll stays the ONLY vertical scroller —
    // no inner scroller, no overflow wrappers. Below 700px .detail-wrap is
    // plain block flow, so the mobile stack (media → head → content) is
    // byte-identical in behaviour to the old flat layout.
    const isCustom = String(r.id).startsWith("u-");
    const meta = [
      r.creator ? `👤 ${esc(r.creator)}` : "",
      r.cuisine && r.cuisine !== "unknown" ? esc(r.cuisine) : "",
      r.totalMin ? `⏱ ${esc(r.totalMin)} perc` : "",
      r.servings ? `🍽 ${esc(r.servings)} adag` : ""
    ].filter(Boolean).join(" · ");

    const recipeImages = (Array.isArray(r.images) && r.images.length > 0)
      ? r.images.map((img) => (typeof img === "string" ? img : (img.url || img.data_url))).filter(Boolean)
      : (r.image ? [r.image] : []);
    const hasMedia = !!(r.video || recipeImages.length > 0);
    const hasVideo = !!r.video;
    const hasImages = recipeImages.length > 0;

    const resolve = Solin.resolveMediaUrl || ((u) => u);
    let mediaHtml = "";
    if (hasVideo && hasImages) {
      const mainImg = recipeImages[0];
      mediaHtml = `
        <div class="detail-media-switcher">
          <div class="media-tabs" style="display:flex; gap:6px; margin-bottom:8px;">
            <button type="button" class="btn sm active" id="media-tab-video">🎬 Videó</button>
            <button type="button" class="btn sm ghost" id="media-tab-photo">📷 Fotók (${recipeImages.length})</button>
          </div>
          <div class="detail-media" id="detail-media-video-box">
            <video id="det-video" src="${esc(resolve(r.video))}" controls playsinline loop preload="metadata"></video>
          </div>
          <div class="detail-media detail-media-photo hidden" id="detail-media-photo-box">
            <img id="det-img" class="detail-img" src="${esc(resolve(mainImg))}" alt="${esc(r.title)}" />
            <span class="detail-img-hint">🔍 Koppints a nagyításhoz</span>
            ${recipeImages.length > 1 ? `
              <div class="detail-gallery">
                ${recipeImages.map((src, idx) => `<img src="${esc(resolve(src))}" class="detail-gallery-thumb${idx === 0 ? " active" : ""}" data-idx="${idx}" alt="Fotó ${idx + 1}" />`).join("")}
              </div>` : ""}
          </div>
          <div class="detail-gallery" id="detail-media-preview-strip" style="margin-top:8px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
            <span style="font-size:12px; color:var(--text-2); font-weight:600;">Fotók:</span>
            ${recipeImages.map((src, idx) => `<img src="${esc(resolve(src))}" class="detail-gallery-thumb media-strip-thumb" data-idx="${idx}" alt="Fotó ${idx + 1}" title="Kattints a fotó megtekintéséhez" style="cursor:pointer;" />`).join("")}
          </div>
        </div>
      `;
    } else if (hasVideo) {
      mediaHtml = `<div class="detail-media">
        <video id="det-video" src="${esc(resolve(r.video))}" controls playsinline loop preload="metadata"></video>
      </div>`;
    } else if (hasImages) {
      const mainImg = recipeImages[0];
      const thumbsHtml = recipeImages.length > 1
        ? `<div class="detail-gallery">
            ${recipeImages.map((src, idx) => `<img src="${esc(resolve(src))}" class="detail-gallery-thumb${idx === 0 ? " active" : ""}" data-idx="${idx}" alt="Fotó ${idx + 1}" />`).join("")}
          </div>`
        : "";
      mediaHtml = `<div class="detail-media detail-media-photo">
        <img id="det-img" class="detail-img" src="${esc(resolve(mainImg))}" alt="${esc(r.title)}" />
        <span class="detail-img-hint">🔍 Koppints a nagyításhoz</span>
        ${thumbsHtml}
      </div>`;
    }

    box.innerHTML = `
      <div class="detail-wrap${hasMedia ? "" : " no-media"}">
      ${mediaHtml}
      <div class="detail-main">
      <div class="detail-head">
        <h2 class="detail-title">${esc(r.title)}</h2>
        <p class="detail-sub">${meta}${hasEdits ? ' <span class="pill pill-ok">✎ szerkesztve</span>' : ""}</p>
        ${(r.dietary || []).length ? `<p class="detail-sub">${r.dietary.map((d) => `<span class="hashtag">${esc(d)}</span>`).join("")}</p>` : ""}
        <div class="detail-actions">
          ${(r.steps || []).length ? `<button class="btn primary" id="cook-listen" aria-pressed="false">▶ Főzés indítása</button>` : ""}
          ${window.SolinCfg && window.SolinCfg.flag("edit") ? `<button class="btn" id="edit-open">✎ Szerkesztés</button>` : ""}
          ${r.source ? `<a class="btn ghost" href="${esc(r.source)}" target="_blank" rel="noopener">Forrás ↗</a>` : ""}
          ${isCustom ? `<button class="btn ghost danger" id="recipe-delete">Törlés</button>` : ""}
        </div>
      </div>
      ${hasEdits ? `<p class="hint">Szerkesztéseid beépítve: ${esc(S.editFields(r.id).join(", "))}. A szerkesztés lapon visszaállíthatod.</p>` : ""}
      ${r.description ? `<p class="detail-desc">${esc(r.description)}</p>` : ""}
      ${macroCards(r)}
      ${ingredientSection(r)}
      ${stepsSection(r)}
      ${scaleSection(r)}
      ${transcriptSection(r)}
      <!-- t_a411a23e (spec §11.5): pairing card (incl. #pg-result + portion
           selector) is the LAST block; instructions sit above it.
           Inner card order unchanged (t_d6c25424): actions→portions→result→rows. -->
      <div id="pairing"></div>
      </div><!-- /.detail-main -->
      </div><!-- /.detail-wrap -->
    `;

    // Pairing panel (recept ↔ termék): render the card now that the DOM is in place
    if (window.Pairing) {
      const pg = box.querySelector("#pairing");
      if (pg) Pairing.renderCard(r);
    }

    // wire interactions
    const editBtn = $("#edit-open");
    if (editBtn) editBtn.addEventListener("click", () => openEdit(r.id));

    // Media switcher interactions (if recipe has both video and photo)
    const tabVideo = box.querySelector("#media-tab-video");
    const tabPhoto = box.querySelector("#media-tab-photo");
    const videoBox = box.querySelector("#detail-media-video-box");
    const photoBox = box.querySelector("#detail-media-photo-box");
    const previewStrip = box.querySelector("#detail-media-preview-strip");

    function showVideo() {
      if (tabVideo) { tabVideo.classList.add("active"); tabVideo.classList.remove("ghost"); }
      if (tabPhoto) { tabPhoto.classList.remove("active"); tabPhoto.classList.add("ghost"); }
      if (videoBox) videoBox.classList.remove("hidden");
      if (photoBox) photoBox.classList.add("hidden");
      if (previewStrip) previewStrip.classList.remove("hidden");
    }

    function showPhoto(idx) {
      if (tabPhoto) { tabPhoto.classList.add("active"); tabPhoto.classList.remove("ghost"); }
      if (tabVideo) { tabVideo.classList.remove("active"); tabVideo.classList.add("ghost"); }
      if (photoBox) photoBox.classList.remove("hidden");
      if (videoBox) {
        videoBox.classList.add("hidden");
        const vid = videoBox.querySelector("video");
        if (vid && !vid.paused) vid.pause();
      }
      if (idx != null && idx >= 0 && recipeImages[idx]) {
        const dImg = photoBox.querySelector("#det-img");
        if (dImg) dImg.src = resolve(recipeImages[idx]);
        const ths = photoBox.querySelectorAll(".detail-gallery-thumb");
        ths.forEach((t, i) => {
          if (i === idx) t.classList.add("active");
          else t.classList.remove("active");
        });
      }
    }

    if (tabVideo) tabVideo.addEventListener("click", () => showVideo());
    if (tabPhoto) tabPhoto.addEventListener("click", () => showPhoto(0));

    box.querySelectorAll(".media-strip-thumb").forEach((th) => {
      th.addEventListener("click", () => {
        const idx = parseInt(th.dataset.idx, 10);
        showPhoto(idx);
      });
    });

    // Wire recipe photo lightbox zoom & gallery switcher
    const detImg = box.querySelector("#det-img");
    if (detImg) {
      detImg.addEventListener("click", () => {
        const lb = window.Solin.openLightbox || (window.FoodCounter && FoodCounter.openLightbox);
        if (lb) lb(detImg.src, r.title);
      });
    }
    const thumbs = box.querySelectorAll(".detail-gallery:not(#detail-media-preview-strip) .detail-gallery-thumb");
    thumbs.forEach((th) => {
      th.addEventListener("click", (e) => {
        e.stopPropagation();
        thumbs.forEach((t) => t.classList.remove("active"));
        th.classList.add("active");
        if (detImg) detImg.src = th.src;
      });
    });

    const delBtn = $("#recipe-delete");
    if (delBtn) delBtn.addEventListener("click", () => {
      if (!confirm("Törlöd ezt a receptet? Ez nem vonható vissza.")) return;
      S.deleteCustomRecipe(r.id);
      toast("Recept törölve");
      go("browse");
    });
    const video = $("#det-video");
    // Missing / unplayable video file → collapse to the no-media layout
    // instead of showing an empty black box.
    if (video) video.addEventListener("error", () => {
      const media = box.querySelector(".detail-media");
      if (media) media.innerHTML = `<div class="media-missing">🎬 A videó most nem érhető el.${r.source ? ` <a href="${esc(r.source)}" target="_blank" rel="noopener">Megnézem az eredetit ↗</a>` : ""}</div>`;
    }, { once: true });
    const cookBtn = $("#cook-listen");
    // Cooking mode: keeps the screen on (Wake Lock API where supported),
    // starts the video at step 1, and toggles back off on second tap.
    if (cookBtn) cookBtn.addEventListener("click", () => {
      cooking = !cooking;
      cookBtn.setAttribute("aria-pressed", String(cooking));
      cookBtn.textContent = cooking ? "■ Főzés befejezése" : "▶ Főzés indítása";
      document.body.classList.toggle("cooking", cooking);
      if (!cooking) { releaseWakeLock(); if (video) video.pause(); return; }
      acquireWakeLock();
      toast(navigator.wakeLock ? "Főzés mód — a képernyő ébren marad" : "Főzés mód bekapcsolva");
      if (video) {
        video.currentTime = (r.steps && r.steps[0] ? r.steps[0].t : 0);
        video.play().catch(() => {});
        video.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        const steps = box.querySelector("#step-list");
        if (steps) steps.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });

    // collapsible sections (CSS hides .sec-body:not(.open))
    box.querySelectorAll(".sec-head").forEach((h) =>
      h.addEventListener("click", () => {
        const body = h.parentElement.querySelector(".sec-body");
        const open = body.classList.toggle("open");
        h.setAttribute("aria-expanded", open ? "true" : "false");
      })
    );

    // ============================================================
    // ingredient check-off — IN-PLACE DOM UPDATE (no full re-render)
    // ------------------------------------------------------------
    // WHY THIS LOOKS DIFFERENT FROM A naive addEventListener-on-each-<li>:
    //   The old code called `render(r.id)` — box.innerHTML was replaced
    //   wholesale, which (a) destroyed + re-created the <video> element
    //   (playback position and play/pause state were lost) and (b) re-painted
    //   the entire recipe detail on every single tick.  Both read as a
    //   "full page refresh" from the user's perspective — this is the
    //   bug this card fixes.
    //
    //   The replacement toggles the CSS `done` class on the <li>, updates
    //   the ✓ glyph, and recomputes the "n / total kijelölve" counter +
    //   progress-bar width — all against the ALREADY-MOUNTED DOM — so the
    //   <video>, the description block, the macro cards, the steps list,
    //   and the video↔step sync listeners are all left undisturbed.
    //
    //   We also attach to the container (#ing-list) instead of each <li>
    //   so the handler survives any later DOM surgery on the list, and we
    //   use `e.stopPropagation()` + `e.preventDefault()` defensively to
    //   make sure the click can never bubble into a form submit or an
    //   enclosing navigation element (belt & suspenders — the recipe
    //   detail view has no <form>, but this kills the whole class of
    //   "the checkbox was inside something that submits / navigates"
    //   bugs by construction).
    //
    //   Data model: the checked set is cached in memory and persisted
    //   per recipe via SolinStore.setChecks (survives reloads).
    // ============================================================
    const ingListEl = box.querySelector("#ing-list");
    const ingClearBtn = box.querySelector("#ing-clear");

    // Recompute just the progress line + bar; touch nothing else.
    const recomputeIngredientProgress = () => {
      const set = getChecked(r.id);
      const total = (r.ingredients || []).length;
      const done  = (r.ingredients || []).filter((i) => set.has(i.name)).length;
      const pct   = total ? Math.round((done / total) * 100) : 0;
      const section = ingListEl.closest(".detail-section");
      if (!section) return;
      const head = section.querySelector(".sec-head span");
      if (head) head.textContent = `${done}/${total}`;
      const cnt = section.querySelector(".ing-progress span");
      if (cnt)  cnt.textContent = `${done} / ${total} kijelölve`;
      const bar = section.querySelector(".prog-bar i");
      if (bar)  bar.style.width = `${pct}%`;
      if (ingClearBtn) ingClearBtn.classList.toggle("hidden", done === 0);
    };

    if (ingClearBtn) ingClearBtn.addEventListener("click", () => {
      const before = Array.from(getChecked(r.id));
      getChecked(r.id).clear();
      persistChecked(r.id);
      paintIngredientList(lastScaleResult);
      toast("Pipák törölve", null, {
        label: "Visszavonás",
        onClick: () => {
          before.forEach((n) => getChecked(r.id).add(n));
          persistChecked(r.id);
          paintIngredientList(lastScaleResult);
        }
      });
    });

    if (ingListEl) {
      ingListEl.addEventListener("click", (e) => {
        const li = e.target && e.target.closest ? e.target.closest("li") : null;
        if (!li || !ingListEl.contains(li)) return;          // only this list
        e.preventDefault();                                    // kill native form-submit / link nav
        e.stopPropagation();                                   // don't leak to section/outer handlers

        // 1) toggle the in-memory source of truth
        const name = li.dataset.idx;
        const set = getChecked(r.id);
        const doneBefore = set.size;
        if (set.has(name)) set.delete(name); else set.add(name);
        persistChecked(r.id);

        // 2) reflect it on the DOM in place (no innerHTML rewrite)
        li.classList.toggle("done", set.has(name));
        li.setAttribute("aria-checked", set.has(name) ? "true" : "false");
        const ck = li.querySelector(".ing-ck");
        if (ck) ck.textContent = set.has(name) ? "✓" : "";

        // 3) progress counter + bar
        recomputeIngredientProgress();

        // 4) celebration toast — only on an UPWARD transition to "all done"
        if (set.size === (r.ingredients || []).length && set.size > doneBefore) {
          toast("Minden hozzávaló készen áll! 🧑‍🍳");
        }
      });
      // keyboard: Space / Enter toggles the focused ingredient
      ingListEl.addEventListener("keydown", (e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        const li = e.target.closest && e.target.closest("li[data-idx]");
        if (!li) return;
        e.preventDefault();
        li.click();
      });
    }

    // ============================================================
    // RECIPE SCALING — "Ha ennyi van, mennyit kell hozzá?" (UC-07)
    // ------------------------------------------------------------
    // The whole block updates the ALREADY-MOUNTED DOM in place:
    //   * the ×factor badge  (#scale-factor)
    //   * the #ing-list rows (rebuild ONLY the <li> innerHTML of the
    //     existing container — the <video>, video↔step sync, and the
    //     check-off listener on #ing-list all survive, same pattern as
    //     the checkbox fix t_5729aeaa above)
    //   * loading / error / success states on #scale-status
    //
    // Data model (spec §6.2): window.SOLIN_DATA / seed `qty` strings
    // are NEVER written to — the scaled values live only in the render
    // layer. Refresh (or ↺ Reset) always returns to the base amounts.
    // ============================================================
    const Scaler = window.SolinScale;
    const sectionEl    = box.querySelector("#scale-panel");
    const anchorSel    = box.querySelector("#scale-anchor");
    const availInput   = box.querySelector("#scale-available");
    const unitLabelEl  = box.querySelector("#scale-unit");
    const scaleFactor  = box.querySelector("#scale-factor");
    const statusEl     = box.querySelector("#scale-status");
    const scaleForm    = box.querySelector("#scale-form");
    const ingListEl2   = ingListEl;
    const ingHintEl    = box.querySelector("#ing-hint");

    let lastScaleResult = null;   // current render-layer result (or null = base)
    let scaleBusy = false;

    // Parse each seed row once and decide which rows may serve as an
    // anchor (spec §2.1: mass g/kg by default; but the spec §6.3 also
    // allows any scalable row — we list ALL scalable rows, mass first,
    // matching the user's card requirement "dropdown listing all
    // ingredients (name + base amount + unit)").
    function anchorOptions(list) {
      return list
        .map((ing) => {
          const p = Scaler.parseQty(ing.qty);
          return { name: ing.name, amount: p.amount, unit: p.unit, scalable: p.scalable, isMass: p.unit === "g" || p.unit === "kg" };
        })
        .sort((a, b) => (b.isMass - a.isMass) || (b.amount || 0) - (a.amount || 0));
    }

    function anchorBase(name) {
      const ing = (r.ingredients || []).find((i) => i.name === name);
      if (!ing) return null;
      const p = Scaler.parseQty(ing.qty);
      return p.scalable ? p : null;
    }

    function setStatus(kind, msg) {
      if (!statusEl) return;
      statusEl.classList.remove("hidden", "ok", "err");
      if (!msg) { statusEl.textContent = ""; return; }
      if (kind === "ok")  statusEl.classList.add("ok");
      if (kind === "err") statusEl.classList.add("err");
      statusEl.textContent = msg;
    }

    // Rebuild ONLY the ingredient <li> list (in place), preserving
    // check-off state (which keys off data-idx / name).
    function paintIngredientList(scaleRes) {
      if (!ingListEl2) return;
      ingListEl2.innerHTML = rowsHTML(r, scaleRes);
      if (ingHintEl) {
        ingHintEl.innerHTML = hintHTML(scaleRes);
        const inlineReset = ingHintEl.querySelector("#scale-reset-inline");
        if (inlineReset) inlineReset.addEventListener("click", resetScale);
      }
      recomputeIngredientProgress();
    }

    async function applyScale(name, available) {
      if (scaleBusy || sectionEl.classList.contains("disabled")) return;
      const avail = parseFloat(available);
      if (!name || isNaN(avail) || avail <= 0) {
        setStatus("err", "Írj be egy érvényes, 0-nál nagyobb mennyiséget.");
        return;
      }
      const base = anchorBase(name);
      if (!base) { setStatus("err", "Ehhez a hozzávalóhoz nem tudom a bázismennyiséget."); return; }

      scaleBusy = true;
      sectionEl.classList.add("loading");
      setStatus("ok", "Számolom…");
      scaleForm && scaleForm.classList.add("loading");
      const t0 = performance.now();
      try {
        // Spec §8: try the API endpoint first; scaleViaApi falls back
        // to the pure local engine on any network failure, and both
        // return the exact same shape — the UI cannot tell the
        // difference (spec §7: canonical path is frontend-logika).
        const res = await Scaler.scaleViaApi(r.id, name, avail, r.ingredients || []);
        lastScaleResult = res;
        paintIngredientList(res);
        if (scaleFactor) scaleFactor.textContent = Scaler.fmtFactor(res.factor);
        if (scaleFactor) scaleFactor.classList.add("active");
        const ms = Math.round(performance.now() - t0);
        // Spec §6.1: warn (not block) when the factor leaves 1/3 … 3× of base
        let warn = "";
        if (res.factor < 1 / 3 || res.factor > 3) warn = " ⚠ Erős skálázás — ellenőrizd a mennyiségeket!";
        setStatus("ok", `Kész — skála: ${Scaler.fmtFactor(res.factor)}${warn} (${ms} ms)`);
      } catch (e) {
        // Last-resort fallback (scaleViaApi normally swallows net errors,
        // so this is a defensive net for unexpected exceptions).
        const local = Scaler.scaleRecipe(r.ingredients || [], name, avail);
        lastScaleResult = local;
        paintIngredientList(local);
        if (scaleFactor) { scaleFactor.textContent = Scaler.fmtFactor(local.factor); scaleFactor.classList.add("active"); }
        setStatus("err", `API el nem érhető — helyi számolás: ${Scaler.fmtFactor(local.factor)}`);
      } finally {
        scaleBusy = false;
        sectionEl.classList.remove("loading");
        if (scaleForm) scaleForm.classList.remove("loading");
      }
    }

    function resetScale() {
      lastScaleResult = null;
      paintIngredientList(null);
      if (scaleFactor) { scaleFactor.textContent = "×1.00"; scaleFactor.classList.remove("active"); }
      if (availInput) availInput.value = "";
      setStatus("ok", "Alap mennyiségek visszaállítva.");
    }

    if (anchorSel && availInput && sectionEl) {
      // Populate the ingredient dropdown: name + base amount + unit
      const opts = anchorOptions(r.ingredients || []);
      if (!opts.some((o) => o.scalable)) {
        // Spec §6.3: no scalable ingredient at all → control hides.
        sectionEl.style.display = "none";
      } else {
        // Seed qty by NAME (NOT the sorted index — the sorted order
        // differs from the seed order, so an index lookup shows the
        // wrong row's qty on the disabled options).
        const seedQty = (n) => {
          const s = (r.ingredients || []).find((x) => x.name === n);
          return s ? (s.qty || "") : "";
        };
        anchorSel.innerHTML = opts
          .map((o) => {
            const label = o.scalable
              ? `${o.name} — ${o.amount != null ? o.amount : "?"} ${o.unit}`
              : `${o.name} — ${esc(seedQty(o.name))} (nem skálázható)`;
            return `<option value="${esc(o.name)}" ${o.scalable ? "" : "disabled"}>${label}</option>`;
          })
          .join("");
      }

      function syncUnitHint() {
        const o = opts.find((x) => x.name === anchorSel.value);
        if (unitLabelEl) unitLabelEl.textContent = o && o.unit ? o.unit : "";
      }
      anchorSel.addEventListener("change", () => {
        syncUnitHint();
        // Pre-fill the input with the anchor's base amount (spec §6.1
        // card detail: "numeric input pre-filled with base amount").
        const base = anchorBase(anchorSel.value);
        if (availInput && base && base.amount != null) availInput.value = String(base.amount);
        // Only auto-scale when the user has already typed a value that
        // DIFFERS from the base; otherwise we'd paint a "scaled" badge
        // while the numbers are actually unchanged (×1.00 looks scaled).
        if (availInput && base && base.amount != null) {
          const v = parseFloat(availInput.value);
          if (!isNaN(v) && v > 0 && v !== base.amount) {
            applyScale(anchorSel.value, availInput.value);
          } else {
            // New anchor at its own base → just re-render the base view
            // (previous scaled values from the old anchor no longer apply).
            lastScaleResult = null;
            paintIngredientList(null);
            if (scaleFactor) { scaleFactor.textContent = "×1.00"; scaleFactor.classList.remove("active"); }
          }
        }
      });
      syncUnitHint();
      // Default: first scalable row = the largest mass anchor (spec §2.1),
      // pre-filled with its base amount, not yet scaled (f=1 = base view).
      const first = opts.find((o) => o.scalable);
      if (first) {
        anchorSel.value = first.name;
        const base = anchorBase(first.name);
        if (base && base.amount != null) availInput.value = String(base.amount);
        syncUnitHint();
      }

      // Debounced live update while typing (spec: "on submit OR debounce")
      let debounceT = null;
      function scheduleDebounce() {
        clearTimeout(debounceT);
        debounceT = setTimeout(() => {
          const v = parseFloat(availInput.value);
          if (v > 0) applyScale(anchorSel.value, availInput.value);
        }, 250);
      }
      availInput.addEventListener("input", scheduleDebounce);

      if (scaleForm) {
        scaleForm.addEventListener("submit", (e) => {
          e.preventDefault();
          e.stopPropagation();
          clearTimeout(debounceT);
          const v = parseFloat(availInput.value);
          if (v > 0) applyScale(anchorSel.value, availInput.value);
          else setStatus("err", "Írj be egy 0-nál nagyobb mennyiséget.");
        });
      }
    }

    // step ↔ video sync (only when the recipe has a video)
    if (!video) return;
    const stepsEls = Array.from(box.querySelectorAll("#step-list li[data-t]"));
    const sync = () => {
      const t = video.currentTime;
      let active = -1;
      stepsEls.forEach((el, i) => {
        const st = parseFloat(el.dataset.t || 0);
        if (t >= st) active = i;
      });
      stepsEls.forEach((el, i) => el.classList.toggle("active", i === active));
    };
    video.addEventListener("timeupdate", sync);
    video.addEventListener("play", sync);
    stepsEls.forEach((el) => {
      const seek = () => {
        video.currentTime = parseFloat(el.dataset.t || 0);
        video.play().catch(() => {});
      };
      el.addEventListener("click", seek);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); seek(); }
      });
    });
  }

  return { render, leave };
})();
