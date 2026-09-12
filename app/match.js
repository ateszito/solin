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

  function subsFor(base) {
    const inv = S.findByBase(base);
    const seed = (window.SOLIN_DATA.suggestedSubs || {});
    const baseKey = Object.keys(seed).find((k) => S.similar(k, base));
    const fromInv = inv ? inv.subs || [] : [];
    const fromSeed = baseKey ? seed[baseKey] : [];
    const out = [];
    fromInv.concat(fromSeed).forEach((s) => { if (!out.some((o) => S.similar(o, s))) out.push(s); });
    return out;
  }

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
      box.innerHTML = `<p class="empty">Adj hozzá néhány alapanyagot fentebb, majd nyomd a <b>Match recipes now</b> gombot.</p>`;
      return;
    }
    const results = S.getRecipes()
      .map((r) => evaluateRecipe(r, have))
      .sort((a, b) => b.score - a.score);

    const counts = { full: 0, almost: 0, partial: 0, weak: 0 };
    results.forEach((r) => counts[r.tier]++);
    const summary = `
      <div class="match-summary">
        <span class="sum-pill" style="background:#E6F7E6;color:#1E7D33">${counts.full} készíthető</span>
        <span class="sum-pill" style="background:var(--card-bg);color:#B4552D">${counts.almost} kis hiánnyal</span>
        <span class="sum-pill" style="background:#FFF4DE;color:#A8731C">${counts.partial} alternatívával</span>
        <span class="sum-pill" style="background:var(--secondary-bg);color:var(--text-2)">${counts.weak} gyenge</span>
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
        : `<div class="mr-line" style="color:#1E7D33;font-weight:700">Minden hozzávaló megvan — süthetsz!</div>`;
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
      chip.innerHTML = `${esc(h)} <button data-rm="${esc(h)}" aria-label="töröl">×</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        S.setHave(have.filter((x) => x !== h));
        state.have = S.getHave();
        renderChipInput();
      });
      wrap.insertBefore(chip, input);
    });
    $("#match-count").textContent = have.length + " alapanyag";
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
    }
    $("#match-item").value = "";
  }

  function render() {
    renderChipInput();

    // preset buttons
    const presets = $("#chip-presets");
    presets.querySelectorAll("button").forEach((b) => b.remove());
    (window.SOLIN_PRESETS || []).forEach((p) => {
      const b = document.createElement("button");
      b.textContent = p;
      b.addEventListener("click", () => addChip(p));
      presets.appendChild(b);
    });

    // input + enter
    $("#match-item").onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); addChip(e.target.value); }
      if (e.key === ",") { e.preventDefault(); addChip(e.target.value); }
    };
    // click outside input to add
    $("#match-item").onblur = () => { if ($("#match-item").value.trim()) addChip($("#match-item").value); };
    $("#chip-input").addEventListener("mousedown", (e) => {
      if (e.target === e.currentTarget) $("#match-item").focus();
    });

    $("#match-clear").addEventListener("click", () => {
      S.setHave([]); state.have = []; renderChipInput();
      $("#match-results").innerHTML = `<p class="empty">Mindent töröltem. Adj hozzá újakat fentebb.</p>`;
    });
    $("#match-run").addEventListener("click", runMatch);

    // show last result if have list already present
    if (S.getHave().length) runMatch();
    else {
      $("#match-results").innerHTML =
        `<p class="hint" style="margin-top:12px">💡 Tipp: add hozzá a hozzávalókat amit most rendelkezed (pl. «vöröshagyma», «csirkeemlő», «tejszín») — a Presets gombok gyorsítanak.</p>`;
    }
  }

  return { render, runMatch, addChip };
})();
