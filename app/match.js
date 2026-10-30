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
      return `<div class="match-result">
        <div class="mr-head">
          <h3 class="mr-title">${esc(m.title)}</h3>
          <span class="mr-score ${tierClass(m.tier)}">${Math.round(m.score * 100)}% · ${tierLabel(m.tier)}</span>
        </div>
        <div class="mr-body">
          ${directChips}${subChips}${missLine}
          <button class="open-link" data-open="${esc(m.id)}">Recept megnyitása →</button>
        </div>
      </div>`;
    }).join("");

    box.innerHTML = summary + cards;
    box.querySelectorAll("[data-open]").forEach((b) =>
      b.addEventListener("click", () => openRecipe(b.dataset.open))
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

  function render() {
    init();
    renderChipInput();
    renderPresets();
    liveRefresh();
  }

  return { init, render, runMatch, addChip };
})();
