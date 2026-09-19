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

  function ingredientSection(r) {
    const id = getChecked(r.id);
    const total = (r.ingredients || []).length;
    const done = (r.ingredients || []).filter((i) => id.has(i.name)).length;
    const rows = (r.ingredients || [])
      .map((ing) => {
        const checkedCls = id.has(ing.name) ? " done" : "";
        const subs = subsFor(ing.name);
        const subLine = subs.length
          ? `<span class="ing-alt">↳ alternatíva: ${esc(subs.join(" · "))}</span>` : "";
        return `<li class="${checkedCls.trim()}" data-idx="${ing.name}">
          <span class="ing-ck">${checkedCls ? "✓" : ""}</span>
          <span class="ing-text"><b>${esc(ing.qty || "")}</b> ${esc(ing.name)}${ing.note ? ` <span class="muted">(${esc(ing.note)})</span>` : ""}${subLine}</span>
        </li>`;
      })
      .join("");
    return `<div class="detail-section">
      <button class="sec-head" data-toggle="ing">Hozzávalók <span>${done}/${total}</span></button>
      <div class="sec-body open">
        <div class="ing-progress"><span>${done} / ${total} kijelölve</span><div class="prog-bar"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div></div>
        <ul class="ing-list" id="ing-list">${rows}</ul>
        <p class="hint" style="margin-top:10px">Tapintsd meg a hozzávalót, ha felhasználtad. Zöld ✓-t kapsz.</p>
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
      ${ingredientSection(r)}
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
