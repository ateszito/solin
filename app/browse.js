/* ============================================================
   Solin v3 — browse.js
   Recipe list: search, tag filter cards.
   ============================================================ */

window.Browse = (function () {
  const { $, $$, S, state, esc, openRecipe } = window.Solin;

  function allTags() {
    const set = new Set();
    S.getRecipes().forEach((r) => (r.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }

  function matches(r, q) {
    if (!q) return true;
    q = S.norm(q);
    const hay = [
      r.title, r.title_hu, r.description, r.cuisine,
      (r.tags || []).join(" "),
      (r.ingredients || []).map((i) => i.name + " " + (i.note || "")).join(" "),
      (r.steps || []).map((s) => s.text).join(" ")
    ].join(" ").toLowerCase().replace(/ö/g, "o").replace(/ő/g, "o")
      .replace(/ü/g, "u").replace(/ű/g, "u");
    return q.split(" ").every((word) => hay.includes(word));
  }

  function cardHTML(r) {
    const m = r.macrosPerServing || {};
    return `
    <article class="recipe-card" data-id="${r.id}" tabindex="0" role="button" aria-label="${esc(r.title)}">
      <div class="rec-media">
        <video src="${esc(r.video)}" preload="metadata" playsinline muted loop
          controls controlsList="nodownload"
          class="rec-video" aria-label="Recept videó: ${esc(r.title)}"></video>
        <span class="rating">★ ${esc(r.rating)}</span>
      </div>
      <div class="rec-body">
        <h3 class="rec-title">${esc(r.title)}</h3>
        <div class="rec-meta">
          <span>👤 ${esc(r.creator)}</span>
          <span>⏱ ${esc(r.totalMin)} perc</span>
          <span>🍽 ${esc(r.servings)} adag</span>
        </div>
        <div class="macro-row">
          <span class="macro-chip">${m.kcal || "-"} <span>kcal</span></span>
          <span class="macro-chip">${m.protein || "-"} <span>g fehérje</span></span>
          <span class="macro-chip">${m.carbs || "-"} <span>g szén</span></span>
          <span class="macro-chip">${m.fat || "-"} <span>g zsiradék</span></span>
        </div>
      </div>
    </article>`;
  }

  function render() {
    const recipes = S.getRecipes();
    $("#recipe-count").textContent = recipes.length + " recept";

    // tag bar
    const tags = allTags();
    const tagbar = $("#tagbar");
    tagbar.innerHTML = tags.map((t) => {
      const active = t === state.filterTag ? " active" : "";
      return `<button data-tag="${esc(t)}" class="${active.trim()}">${esc(t)}</button>`;
    }).join("");
    tagbar.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        state.filterTag = state.filterTag === b.dataset.tag ? null : b.dataset.tag;
        render();
      })
    );

    // search box stays mounted — keep value
    const q = ($("#search").value || "").trim();
    state.query = q;

    let list = recipes.slice();
    if (state.filterTag) list = list.filter((r) => (r.tags || []).includes(state.filterTag));
    if (q) list = list.filter((r) => matches(r, q));

    const grid = $("#recipe-grid");
    grid.innerHTML = list.map(cardHTML).join("");
    $("#browse-empty").classList.toggle("hidden", list.length > 0);

    // card click / keyboard
    grid.querySelectorAll(".recipe-card").forEach((c) => {
      const open = () => openRecipe(c.dataset.id);
      c.addEventListener("click", (e) => {
        // if the user clicked the video controls, don't navigate
        if (e.target.closest("video, button, .rec-media > video")) {
          const v = c.querySelector("video");
          if (v && e.target === v) return;
          open(); return;
        }
        open();
      });
      c.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });

    // hover-preview for videos (mobile: no hover — cheap)
    grid.querySelectorAll(".rec-video").forEach((v) => {
      v.addEventListener("mouseenter", () => v.play().catch(() => {}));
      v.addEventListener("mouseleave", () => { v.pause(); v.currentTime = 0; });
    });
  }

  function init() {
    $("#search").addEventListener("input", () => render());
    render();
  }

  return { render, init };
})();
