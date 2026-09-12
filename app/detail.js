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
          <button class="btn primary" id="edit-open">✎ Szerkesztés</button>
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
    $("#edit-open").addEventListener("click", () => openEdit(r.id));
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

    // ingredient check-off
    box.querySelectorAll("#ing-list li").forEach((li) => {
      li.addEventListener("click", () => {
        const name = li.dataset.idx;
        const set = getChecked(r.id);
        if (set.has(name)) set.delete(name); else set.add(name);
        render(r.id);
        if (set.size === (r.ingredients || []).length) toast("Minden hozzávaló felhasznált! 🧑‍🍳");
      });
    });

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
