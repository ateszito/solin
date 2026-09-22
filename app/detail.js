/* ============================================================
   Solin v3 — detail.js
   Recipe detail: video (with synced steps), macro cards,
   ingredients checklist w/ substitutes, description, actions.
   ============================================================ */

window.Detail = (function () {
  const { $, $$, S, state, esc, openEdit, go, toast } = window.Solin;
  const checked = {};          // per-session check state {recipeId: Set}

  function getChecked(id) {
    if (!checked[id]) checked[id] = new Set();
    return checked[id];
  }

  function subsFor(ingName) {
    // 1) inventory (user-curated) 2) recipe note 3) suggestedSubs
    const inv = S.findByBase(ingName);
    const fromInv = inv ? inv.subs || [] : [];
    const fromSeed = S.norm ? null : null;
    const seed = (window.SOLIN_DATA.suggestedSubs || {});
    const baseKey = Object.keys(seed).find((k) => S.similar(k, ingName));
    const fromSeedList = baseKey ? seed[baseKey] : [];
    const merged = [];
    fromInv.concat(fromSeedList).forEach((s) => {
      if (!merged.some((m) => S.similar(m, s))) merged.push(s);
    });
    return merged;
  }

  function macroCards(r) {
    const m = r.macrosPerServing || {};
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

  function ingredientSection(r, scaleRes) {
    const id = getChecked(r.id);
    const total = (r.ingredients || []).length;
    const done = (r.ingredients || []).filter((i) => id.has(i.name)).length;

    // Build rows — either from the ORIGINAL seed data (default) or from
    // a scaleResult (spec §6.2: scaled amount + unit, anchor/manual badges,
    // changed values highlighted).  The DOM structure (<li data-idx=…>)
    // is IDENTICAL in both modes so the check-off handler, which keys on
    // data-idx, works unchanged (see acceptance 5: seed not mutated).
    function renderRows(list, getAmount) {
      return list
        .map((ing) => {
          const name = ing.name;
          const checkedCls = id.has(name) ? " done" : "";
          const subs = subsFor(name);
          const subLine = subs.length
            ? `<span class="ing-alt">↳ alternatíva: ${esc(subs.join(" · "))}</span>` : "";
          // Default mode: raw seed qty string. Scaled mode: computed.
          const scaledMode = getAmount != null;
          let qtyLabel, clsExtra = "", badge = "";
          if (scaledMode) {
            const v = getAmount(ing);
            if (ing.manual) {
              qtyLabel = `<b class="ing-manual-base">${esc(ing.baseQty || "")}</b>`;
              badge = `<span class="scale-badge manual" title="Nem skálázható — az alap marad (spec §4)">manuális</span>`;
            } else if (v.scaled) {
              qtyLabel = `<b class="ing-scaled">${esc(v.text)}</b>`;
              clsExtra = " scaled";
            } else {
              qtyLabel = `<b>${esc(v.text)}</b>`;
            }
            if (ing.isAnchor) badge = `<span class="scale-badge anchor" title="Választott horgony — a megadott mennyiség">★ horgony</span>`;
          } else {
            qtyLabel = `<b>${esc(ing.qty || "")}</b>`;
          }
          return `<li class="${checkedCls.trim()}${clsExtra}" data-idx="${esc(name)}">
            <span class="ing-ck">${checkedCls ? "✓" : ""}</span>
            <span class="ing-text">${qtyLabel} ${esc(ing.name)}${ing.note ? ` <span class="muted">(${esc(ing.note)})</span>` : ""}${badge}${subLine}</span>
          </li>`;
        })
        .join("");
    }

    let rows, hint;
    if (scaleRes && scaleRes.items) {
      const mapped = scaleRes.items.map((it) => ({
        name: it.name, qty: it.amount != null ? `${it.amount} ${it.unit}` : it.baseQty,
        note: it.note, manual: it.manual, baseQty: it.baseQty,
        isAnchor: scaleRes.anchor && scaleRes.anchor.name === it.name,
      }));
      const lookup = Object.fromEntries(scaleRes.items.map((it) => [it.name, it]));
      rows = renderRows(mapped, (ing) => {
        const it = lookup[ing.name];
        return it.manual ? null : { text: window.SolinScale.fmtAmount(it.amount, it.unit), scaled: it.scaled && it.amount != null };
      });
      hint = `Skálázva: <b>${esc(window.SolinScale.fmtFactor(scaleRes.factor))}</b> (horgony: ${esc(scaleRes.anchor ? scaleRes.anchor.name : "—")}). A kiemelt értékek változtak. <button class="btn sm ghost scale-reset-inline" id="scale-reset-inline">↺ Alap mennyiségek</button>`;
    } else {
      rows = renderRows(r.ingredients || [], null);
      hint = `Tapintsd meg a hozzávalót, ha felhasználtad. Zöld ✓-t kapsz.`;
    }

    return `<div class="detail-section">
      <div class="scale-panel" id="scale-panel">
        <div class="scale-head">
          <span class="scale-title">🎚 Recept skálázása</span>
          <span class="scale-factor" id="scale-factor">×1.00</span>
        </div>
        <p class="scale-help">Ha ennyi van belőled: válassz hozzávalót, írd be, mennyid van, és számolom át a többit.</p>
        <form class="scale-controls" id="scale-form" autocomplete="off">
          <select id="scale-anchor" class="grow" aria-label="Skálázó hozzávaló (horgony)"></select>
          <input id="scale-available" type="number" min="0" step="any" inputmode="decimal" aria-label="Elérhető mennyiség" />
          <span id="scale-unit" class="scale-unit"></span>
          <button type="submit" class="btn primary" id="scale-apply">Skálázom →</button>
        </form>
        <div class="scale-status hidden" id="scale-status" role="status"></div>
      </div>
      <button class="sec-head" data-toggle="ing">Hozzávalók <span>${done}/${total}</span></button>
      <div class="sec-body open">
        <div class="ing-progress"><span>${done} / ${total} kijelölve</span><div class="prog-bar"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div></div>
        <ul class="ing-list" id="ing-list">${rows}</ul>
        <p class="hint" style="margin-top:10px" id="ing-hint">${hint}</p>
      </div>
    </div>`;
  }

  function stepsSection(r) {
    const rows = (r.steps || [])
      .map((s, i) => `<li data-step="${i}" data-t="${s.t || 0}">
        <span class="step-no"></span>
        <div class="step-t"><span class="t">${fmt(s.t)}</span> ${esc(s.text)}</div>
      </li>`)
      .join("");
    return `<div class="detail-section">
      <button class="sec-head" data-toggle="steps">Elkészítés (videó-szinkron)</button>
      <div class="sec-body open">
        <ol class="step-list" id="step-list">${rows}</ol>
        <p class="hint" style="margin-top:10px">A videó lejátszása közben a megfelelő lépés kiemelten jelenik meg. Egyik lépésre tapintva átugor a videón.</p>
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
    if (!r) { box.innerHTML = `<p class="empty">Nincs ilyen recept.</p>`; return; }
    const hasEdits = S.hasEdits(r.id);
    box.innerHTML = `
      <div class="detail-media">
        <video id="det-video" src="${esc(r.video)}" controls playsinline loop playsinline></video>
      </div>
      <div class="detail-head">
        <h2 class="detail-title">${esc(r.title)}</h2>
        <p class="detail-sub">👤 ${esc(r.creator)} · ${esc(r.cuisine)} · ⏱ ${esc(r.totalMin)} perc · 🍽 ${esc(r.servings)} adag${hasEdits ? ' <span class="pill" style="background:#E6F7E6;color:#1E7D33">✎ szerkesztve</span>' : ""}</p>
        <p class="detail-sub">${(r.dietary || []).map((d) => `<span class="hashtag">${esc(d)}</span>`).join("")}</p>
        <div class="detail-actions">
          ${window.SolinCfg && window.SolinCfg.flag("edit") ? `<button class="btn primary" id="edit-open">✎ Szerkesztés</button>` : ""}
          <a class="btn" href="${esc(r.source)}" target="_blank" rel="noopener">Forrás: TikTok ↗</a>
          <button class="btn" id="cook-listen">▶ Főzéskezdéshez</button>
        </div>
      </div>
      ${hasEdits ? `<p class="hint">Szerkesztéseid beépítve: ${esc(S.editFields(r.id).join(", "))}. A szerkesztés lapnál törölheted.</p>` : ""}
      ${esc(r.description)}
      ${macroCards(r)}
      ${ingredientSection(r, null)}
      ${stepsSection(r)}
    `;

    // wire interactions
    const editBtn = $("#edit-open");
    if (editBtn) editBtn.addEventListener("click", () => openEdit(r.id));
    const video = $("#det-video");
    $("#cook-listen").addEventListener("click", () => {
      video.currentTime = (r.steps && r.steps[0] ? r.steps[0].t : 0);
      video.play().catch(() => {});
    });

    // collapsible sections
    box.querySelectorAll(".sec-head").forEach((h) =>
      h.addEventListener("click", () => {
        const body = h.parentElement.querySelector(".sec-body");
        body.classList.toggle("open");
        h.style.background = body.classList.contains("open") ? "#fff" : "#F5F5F5";
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
    //   Data model: unchanged.  The per-session in-memory `checked` map
    //   is the source of truth (refresh resets — same as the old code).
    // ============================================================
    const ingListEl = box.querySelector("#ing-list");

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
    };

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

        // 2) reflect it on the DOM in place (no innerHTML rewrite)
        li.classList.toggle("done", set.has(name));
        const ck = li.querySelector(".ing-ck");
        if (ck) ck.textContent = set.has(name) ? "✓" : "";

        // 3) progress counter + bar
        recomputeIngredientProgress();

        // 4) celebration toast — only on an UPWARD transition to "all done"
        if (set.size === (r.ingredients || []).length && set.size > doneBefore) {
          toast("Minden hozzávaló felhasznált! 🧑‍🍳");
        }
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
      const set = getChecked(r.id);
      const list = scaleRes
        ? scaleRes.items
        : (r.ingredients || []).map((i) => ({ name: i.name, baseQty: i.qty, unit: "", note: i.note, manual: false, scaled: false, amount: null }));

      const baseMap = {};
      (r.ingredients || []).forEach((i) => { baseMap[i.name] = i; });

      ingListEl2.innerHTML = list
        .map((it) => {
          const seed = baseMap[it.name] || {};
          const done = set.has(it.name) ? " done" : "";
          const subs = subsFor(it.name);
          const subLine = subs.length ? `<span class="ing-alt">↳ alternatíva: ${esc(subs.join(" · "))}</span>` : "";
          let qtyHtml, extraCls = "", badge = "";
          if (scaleRes) {
            if (it.manual) {
              qtyHtml = `<b class="ing-manual-base" title="Nem skálázható (spec §4)">${esc(seed.qty || it.baseQty || "")}</b>`;
              badge = `<span class="scale-badge manual">manuális</span>`;
            } else {
              const txt = Scaler.fmtAmount(it.amount, it.unit);
              qtyHtml = it.scaled ? `<b class="ing-scaled">${esc(txt)}</b>` : `<b>${esc(txt)}</b>`;
              if (it.scaled) extraCls = " scaled";
            }
            if (scaleRes.anchor && scaleRes.anchor.name === it.name) {
              badge = `<span class="scale-badge anchor">★ horgony</span>`;
            }
          } else {
            qtyHtml = `<b>${esc(seed.qty || "")}</b>`;
          }
          return `<li class="${done.trim()}${extraCls}" data-idx="${esc(it.name)}">
            <span class="ing-ck">${set.has(it.name) ? "✓" : ""}</span>
            <span class="ing-text">${qtyHtml} ${esc(it.name)}${seed.note ? ` <span class="muted">(${esc(seed.note)})</span>` : ""}${badge}${subLine}</span>
          </li>`;
        })
        .join("");

      if (ingHintEl) {
        if (scaleRes) {
          ingHintEl.innerHTML = `Skálázva: <b>${esc(Scaler.fmtFactor(scaleRes.factor))}</b> · horgony: ${esc(scaleRes.anchor ? scaleRes.anchor.name : "—")} — a kiemelt értékek változtak. <button class="btn sm ghost" id="scale-reset-inline" type="button">↺ Alap mennyiségek</button>`;
        } else {
          ingHintEl.innerHTML = `Tapintsd meg a hozzávalót, ha felhasználtad. Zöld ✓-t kapsz.`;
        }
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

    // step ↔ video sync
    const stepsEls = Array.from(box.querySelectorAll("#step-list li"));
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
    stepsEls.forEach((el) =>
      el.addEventListener("click", () => {
        video.currentTime = parseFloat(el.dataset.t || 0);
        video.play().catch(() => {});
      })
    );
  }

  return { render };
})();
