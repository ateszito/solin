/* ============================================================
   Solin v3 — match.js
   "What can I cook?" matcher:
   - direct hit  = 1.0 credit per ingredient
   - known substitute (inventory/seed) hit = 0.6 credit
   - otherwise ingredient is missing
   Score = (direct + 0.6 * substitute) / total
   Tiers: full / almost (few missing) / partial / weak
   ============================================================ */

window.Match = (function () {
  const { $, $$, S, state, esc, toast, openRecipe } = window.Solin;

  // pantry subs first, then seed suggestions — shared with the detail view
  const subsFor = (base) => S.subsFor(base);

  function evaluateRecipe(r, have) {
    const direct = [], substitute = [], missing = [];
    (r.ingredients || []).forEach((ing) => {
      const name = ing.name;
      const subs = subsFor(name);
      const nName = S.norm(name);
      // A "have" entry is a base hit if it IS the base (exact), or contains
      // it as a substring but is NOT itself a known substitute of the base.
      const isBaseHit = (h) =>
        (S.norm(h) === nName) || (S.similar(h, name) && !subs.some((s) => S.similar(h, s) && S.norm(h) !== nName));
      if (have.some((h) => isBaseHit(h))) { direct.push(name); return; }
      // A "have" entry is a substitute if it is similar to a listed alt and is
      // not the base itself (exact-equality guard keeps "rizs-tejszin" as a sub).
      const subHit = subs.find((s) => have.some((h) => S.similar(h, s) && S.norm(h) !== nName));
      if (subHit) { substitute.push({ name, via: subHit }); return; }
      missing.push({ name, hasSub: subs.length > 0 });
    });
    const total = (r.ingredients || []).length || 1;
    const score = (direct.length + 0.6 * substitute.length) / total;
    let tier;
    if (score >= 0.999) tier = "full";
    else if (missing.length <= 2) tier = "almost";
    else if (substitute.length + direct.length >= total * 0.6) tier = "partial";
    else tier = "weak";
    return { id: r.id, title: r.title, score, direct, substitute, missing, tier, total };
  }

  function tierLabel(t) {
    return {
      full: "Minden megvan ✓",
      almost: "Csak kis hiány",
      partial: "Alternatívákkal megoldható",
      weak: "Túl kevés egyezés"
    }[t];
  }
  function tierClass(t) {
    return { full: "score-full", almost: "score-high", partial: "score-mid", weak: "score-low" }[t];
  }

  function runMatch() {
    const have = S.getHave();
    const box = $("#match-results");
    if (!have.length) {
      box.innerHTML = `<p class="empty">Adj hozzá néhány alapanyagot fentebb — az eredmények azonnal megjelennek.</p>`;
      return;
    }
    const results = S.getRecipes()
      .map((r) => evaluateRecipe(r, have))
      .sort((a, b) => b.score - a.score);

    const counts = { full: 0, almost: 0, partial: 0, weak: 0 };
    results.forEach((r) => counts[r.tier]++);
    const summary = `
      <div class="match-summary">
        <span class="sum-pill score-full">${counts.full} készíthető</span>
        <span class="sum-pill score-high">${counts.almost} kis hiánnyal</span>
        <span class="sum-pill score-mid">${counts.partial} alternatívával</span>
        <span class="sum-pill score-low">${counts.weak} gyenge</span>
      </div>`;

    const cards = results.map((m) => {
      const missed = m.missing.map((x) =>
        `<span class="tag-miss ${x.hasSub ? "sub" : ""}" title="${x.hasSub ? "vannak alternatívák" : "nincs alternatíva"}">+ ${esc(x.name)}${x.hasSub ? " (vagy alternatívája)" : ""}</span>`
      ).join("");
      const directChips = m.direct.length
        ? `<div class="mr-line"><span class="muted">Megvan:</span> ${m.direct.map((d) => `<span class="tag-have">✓ ${esc(d)}</span>`).join("")}</div>`
        : "";
      const subChips = m.substitute.length
        ? `<div class="mr-line"><span class="muted">Alternatívával:</span> ${m.substitute.map((s) => `<span class="tag-miss sub">${esc(s.name)} ← ${esc(s.via)}</span>`).join("")}</div>`
        : "";
      const missLine = m.missing.length
        ? `<div class="mr-line"><span class="muted">Hiányzik:</span> ${missed}</div>`
        : `<div class="mr-line mr-allset">Minden hozzávaló megvan — süthetsz!</div>`;
      const shopBtn = m.missing.length
        ? `<button type="button" class="btn sm ghost" data-add-shop="${esc(m.id)}" style="font-size:12px;">🛒 Hiányzók a bevásárlólistára (${m.missing.length})</button>`
        : "";
      return `<div class="match-result">
        <div class="mr-head">
          <h3 class="mr-title">${esc(m.title)}</h3>
          <span class="mr-score ${tierClass(m.tier)}">${Math.round(m.score * 100)}% · ${tierLabel(m.tier)}</span>
        </div>
        <div class="mr-body">
          ${directChips}${subChips}${missLine}
          <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-top:8px;">
            <button class="open-link" data-open="${esc(m.id)}">Recept megnyitása →</button>
            ${shopBtn}
          </div>
        </div>
      </div>`;
    }).join("");

    box.innerHTML = summary + cards;
    box.querySelectorAll("[data-open]").forEach((b) =>
      b.addEventListener("click", () => openRecipe(b.dataset.open))
    );
    box.querySelectorAll("[data-add-shop]").forEach((b) =>
      b.addEventListener("click", () => {
        const rid = b.dataset.addShop;
        const m = results.find((x) => x.id === rid);
        if (m && m.missing && S.addShoppingItems) {
          const rec = S.getRecipe(rid);
          const itemsWithQty = m.missing.map((ms) => {
            const ingObj = rec && (rec.ingredients || []).find((i) => i.name === ms.name);
            return { name: ms.name, qty: ingObj ? (ingObj.qty || "") : "" };
          });
          const added = S.addShoppingItems(itemsWithQty, m.title);
          renderShoppingList();
          toast(added ? `${added} hiányzó tétel hozzáadva a bevásárlólistához 🛒` : "Már a bevásárlólistán van 🛒");
        }
      })
    );
  }

  function renderChipInput() {
    const have = S.getHave();
    const wrap = $("#chip-input");
    const input = $("#match-item");
    // rebuild chips (keep input last)
    wrap.querySelectorAll(".chip").forEach((c) => c.remove());
    have.forEach((h) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = `${esc(h)} <button type="button" data-rm="${esc(h)}" aria-label="${esc(h)} eltávolítása">×</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        S.setHave(S.getHave().filter((x) => x !== h));
        state.have = S.getHave();
        renderChipInput();
        renderPresets();
        liveRefresh();
      });
      wrap.insertBefore(chip, input);
    });
    $("#match-count").textContent = have.length + " alapanyag";
  }

  // Results follow the chip list live — no need to hunt for the button
  // after every change.
  function liveRefresh() {
    if (S.getHave().length) runMatch();
    else showEmptyHint();
  }

  function showEmptyHint() {
    $("#match-results").innerHTML =
      `<p class="hint" style="margin-top:12px">💡 Tipp: írd be, ami most otthon van (pl. «vöröshagyma», «csirkeemlő», «tejszín»), vagy koppints a gyors gombokra — az eredmények azonnal frissülnek.</p>`;
  }

  function addChip(text) {
    const v = (text || "").trim();
    if (!v) return;
    const have = S.getHave();
    if (!have.some((h) => S.similar(h, v))) {
      have.push(v);
      S.setHave(have);
      state.have = have;
      renderChipInput();
      liveRefresh();
    } else {
      toast("Már a listán van: " + v);
    }
    $("#match-item").value = "";
  }

  function renderPresets() {
    const presets = $("#chip-presets");
    presets.querySelectorAll("button").forEach((b) => b.remove());
    const have = S.getHave();
    (window.SOLIN_PRESETS || []).forEach((p) => {
      if (have.some((h) => S.norm(h) === S.norm(p))) return; // already added
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "+ " + p;
      b.dataset.preset = p;
      presets.appendChild(b);
    });
  }

  // Bind static controls ONCE (render() runs on every tab visit).
  let _bound = false;
  function init() {
    if (_bound) return;
    _bound = true;
    const input = $("#match-item");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addChip(e.target.value); renderPresets(); }
      // Backspace on an empty field removes the last chip (standard chip-input UX)
      if (e.key === "Backspace" && !input.value) {
        const have = S.getHave();
        if (have.length) { S.setHave(have.slice(0, -1)); state.have = S.getHave(); renderChipInput(); renderPresets(); liveRefresh(); }
      }
    });
    input.addEventListener("blur", () => { if (input.value.trim()) { addChip(input.value); renderPresets(); } });
    $("#chip-input").addEventListener("mousedown", (e) => {
      if (e.target === e.currentTarget) { e.preventDefault(); input.focus(); }
    });
    $("#chip-presets").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-preset]");
      if (b) { addChip(b.dataset.preset); renderPresets(); }
    });
    $("#match-clear").addEventListener("click", () => {
      const before = S.getHave();
      if (!before.length) return;
      S.setHave([]); state.have = []; renderChipInput(); renderPresets(); showEmptyHint();
      toast("Lista törölve", null, {
        label: "Visszavonás",
        onClick: () => { S.setHave(before); state.have = before; renderChipInput(); renderPresets(); liveRefresh(); }
      });
    });
    $("#match-run").addEventListener("click", runMatch);
  }

  function renderShoppingList() {
    const viewMatch = $("#view-match");
    if (!viewMatch || !S.getShoppingList) return;
    let panel = $("#shopping-list-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "shopping-list-panel";
      panel.className = "card";
      panel.style.marginTop = "18px";
      viewMatch.appendChild(panel);
    }
    const isEn = (window.SolinI18n && window.SolinI18n.getLang ? window.SolinI18n.getLang() : "hu") === "en";
    const list = S.getShoppingList();
    const prodsMap = (window.Inventory && window.Inventory.getProductsMap) ? window.Inventory.getProductsMap() : {};

    let estTotalHuf = 0;
    const rowsHtml = list.map((item) => {
      const invEntry = S.findByBase(item.name);
      let priceTag = "";
      if (invEntry && Array.isArray(invEntry.product_ids) && invEntry.product_ids.length) {
        const prod = prodsMap[invEntry.product_ids[0]];
        if (prod && prod.prices && prod.prices[0]) {
          const pr = prod.prices[0];
          priceTag = `<span class="pill" style="background:#e0f2fe;color:#0369a1;font-size:11px;">🏷️ ${esc(prod.name)}: ${esc(pr.amount)} ${esc(pr.currency)}</span>`;
          if (pr.currency === "HUF") estTotalHuf += Number(pr.amount) || 0;
        }
      }
      const dispName = isEn ? (item.name_en || (invEntry && invEntry.name_en) || item.name) : item.name;
      return `
        <li style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0; border-bottom:1px solid var(--line); ${item.checked ? "opacity:0.55; text-decoration:line-through;" : ""}">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; flex:1;">
            <input type="checkbox" data-shop-chk="${esc(item.id)}" ${item.checked ? "checked" : ""} />
            <span style="font-weight:600;">${esc(dispName)}</span>
            ${item.qty ? `<span class="muted" style="font-size:12.5px;">(${esc(item.qty)})</span>` : ""}
            ${item.recipe_title ? `<span class="pill" style="font-size:10.5px;">📖 ${esc(item.recipe_title)}</span>` : ""}
            ${priceTag}
          </label>
          <button type="button" class="rm" data-shop-rm="${esc(item.id)}" title="Törlés">×</button>
        </li>
      `;
    }).join("");

    const checkedCount = list.filter((x) => x.checked).length;

    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
        <h3 style="margin:0;">🛒 ${isEn ? "Smart Shopping List" : "Okos Bevásárlólista"} <span class="pill">${list.length}</span></h3>
        ${estTotalHuf > 0 ? `<span class="pill" style="background:rgba(16,185,129,0.14);color:#065f46;font-weight:700;">≈ ${Math.round(estTotalHuf)} HUF (${isEn ? "linked products" : "csatolt termékek ára"})</span>` : ""}
      </div>
      <div class="inline-form" style="gap:8px; margin-bottom:12px;">
        <input id="shop-manual-in" type="text" placeholder="${isEn ? "Add item to buy (e.g. Milk)…" : "Tétel hozzáadása (pl. görög joghurt)…"}" style="flex:1;" />
        <button type="button" id="shop-manual-add" class="btn sm primary">＋ ${isEn ? "Add" : "Hozzáadás"}</button>
      </div>
      ${list.length ? `<ul style="list-style:none; padding:0; margin:0 0 12px;">${rowsHtml}</ul>` : `<p class="hint" style="margin:0;">${isEn ? "Your shopping list is empty. Add missing ingredients straight from recipes!" : "A bevásárlólistád üres. A receptekből 1 kattintással ide teheted a hiányzó hozzávalókat!"}</p>`}
      ${list.length ? `
        <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:space-between;">
          <button type="button" id="shop-move-to-stock" class="btn sm primary" ${checkedCount === 0 ? "disabled" : ""}>
            📦 ${isEn ? `Move checked (${checkedCount}) to In-Stock Pantry` : `Megvettem (${checkedCount}) → Kamrába (Van otthon)`}
          </button>
          <button type="button" id="shop-clear-all" class="btn sm ghost">${isEn ? "Clear list" : "Lista ürítése"}</button>
        </div>
      ` : ""}
    `;

    const addIn = panel.querySelector("#shop-manual-in");
    const addBtn = panel.querySelector("#shop-manual-add");
    const doManualAdd = () => {
      const val = (addIn && addIn.value || "").trim();
      if (!val) return;
      S.addShoppingItems([{ name: val, qty: "" }], "");
      renderShoppingList();
    };
    if (addBtn) addBtn.addEventListener("click", doManualAdd);
    if (addIn) addIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doManualAdd(); } });

    panel.querySelectorAll("[data-shop-chk]").forEach((chk) => {
      chk.addEventListener("change", () => {
        const cur = S.getShoppingList();
        const found = cur.find((x) => x.id === chk.dataset.shopChk);
        if (found) {
          found.checked = chk.checked;
          S.setShoppingList(cur);
          renderShoppingList();
        }
      });
    });

    panel.querySelectorAll("[data-shop-rm]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cur = S.getShoppingList().filter((x) => x.id !== btn.dataset.shopRm);
        S.setShoppingList(cur);
        renderShoppingList();
      });
    });

    const moveBtn = panel.querySelector("#shop-move-to-stock");
    if (moveBtn) {
      moveBtn.addEventListener("click", () => {
        const cur = S.getShoppingList();
        const bought = cur.filter((x) => x.checked);
        if (!bought.length) return;
        const have = S.getHave();
        bought.forEach((b) => {
          if (!have.some((h) => S.similar(h, b.name))) {
            have.push(b.name);
          }
        });
        S.setHave(have);
        state.have = have;
        S.setShoppingList(cur.filter((x) => !x.checked));
        renderChipInput();
        renderPresets();
        liveRefresh();
        renderShoppingList();
        if (window.Inventory && window.Inventory.render) window.Inventory.render();
        toast(`${bought.length} megvásárolt alapanyag bekerült az otthoni készletbe ✓`);
      });
    }

    const clearBtn = panel.querySelector("#shop-clear-all");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        S.setShoppingList([]);
        renderShoppingList();
      });
    }
  }

  function render() {
    init();
    renderChipInput();
    renderPresets();
    liveRefresh();
    renderShoppingList();
  }

  return { init, render, runMatch, addChip, renderShoppingList };
})();
