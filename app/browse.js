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
    if (!q) return true;
    // Normalize the haystack with the SAME function as the query. (Before,
    // the query went through S.norm — which folds á/é/í and cs/sz/gy… —
    // but the haystack only folded ö/ő/ü/ű, so "csirke" became "cirke"
    // and never matched anything.)
    const hay = S.norm([
      r.title, r.title_hu, r.description, r.cuisine,
      (r.tags || []).join(" "),
      (r.ingredients || []).map((i) => i.name + " " + (i.note || "")).join(" "),
      (r.steps || []).map((s) => s.text).join(" ")
    ].join(" "));
    return q.split(" ").every((word) => hay.includes(word));
  }

  function cardHTML(r) {
    const m = r.macrosPerServing || {};
    // Card videos are silent previews (no native controls): tapping the
    // card always opens the recipe; the full player lives in the detail view.
    // The source is attached lazily (data-src) only when the card scrolls
    // near the viewport — a long list no longer opens N video requests.
    const resolve = Solin.resolveMediaUrl || ((u) => u);
    const firstImg = r.image || (Array.isArray(r.images) && r.images.length > 0
      ? (typeof r.images[0] === "string" ? r.images[0] : (r.images[0].url || r.images[0].data_url))
      : null);
    const media = r.video
      ? `<video data-src="${esc(resolve(r.video))}#t=0.1" preload="none" playsinline muted loop
          class="rec-video" aria-hidden="true" tabindex="-1"></video>`
      : (firstImg
          ? `<img src="${esc(resolve(firstImg))}" class="rec-img" alt="${esc(r.title)}" loading="lazy" />`
          : `<div class="rec-placeholder" aria-hidden="true">🍳</div>`);
    const meta = [
      r.creator ? `<span>👤 ${esc(r.creator)}</span>` : "",
      r.totalMin ? `<span>⏱ ${esc(r.totalMin)} perc</span>` : "",
      r.servings ? `<span>🍽 ${esc(r.servings)} adag</span>` : ""
    ].join("");
    const hasMacros = m.kcal != null || m.protein != null || m.carbs != null || m.fat != null;
    const macros = hasMacros ? `
        <div class="macro-row">
          <span class="macro-chip">${esc(m.kcal ?? "–")} <span>kcal</span></span>
          <span class="macro-chip">${esc(m.protein ?? "–")} <span>g fehérje</span></span>
          <span class="macro-chip">${esc(m.carbs ?? "–")} <span>g szénh.</span></span>
          <span class="macro-chip">${esc(m.fat ?? "–")} <span>g zsír</span></span>
        </div>`
      : `<div class="macro-row"><span class="macro-chip muted">Makrók még nincsenek megadva</span></div>`;
    return `
    <article class="recipe-card" data-id="${esc(r.id)}" tabindex="0" role="link" aria-label="${esc(r.title)} megnyitása">
      <div class="rec-media">
        ${media}
        ${Number(r.rating) > 0 ? `<span class="rating">★ ${esc(r.rating)}</span>` : ""}
        ${r.video ? `<span class="rec-play" aria-hidden="true">▶</span>` : ""}
      </div>
      <div class="rec-body">
        <h3 class="rec-title">${esc(r.title)}</h3>
        <div class="rec-meta">${meta}</div>
        ${macros}
      </div>
    </article>`;
  }

  function render() {
    const recipes = S.getRecipes();
    $("#recipe-count").textContent = recipes.length + " recept";

    // tag bar ("Mind" = clear filter)
    const tags = allTags();
    $("#tagbar").innerHTML = (tags.length
      ? `<button type="button" data-tag="" class="${state.filterTag ? "" : "active"}" aria-pressed="${!state.filterTag}">Mind</button>`
      : "") +
      tags.map((t) => {
        const on = t === state.filterTag;
        return `<button type="button" data-tag="${esc(t)}" class="${on ? "active" : ""}" aria-pressed="${on}">#${esc(t)}</button>`;
      }).join("");

    // search box stays mounted — keep value
    const q = ($("#search").value || "").trim();
    state.query = q;

    let list = recipes.slice();
    if (state.filterTag) list = list.filter((r) => (r.tags || []).includes(state.filterTag));
    if (q) list = list.filter((r) => matches(r, q));

    $("#recipe-grid").innerHTML = list.map(cardHTML).join("");
    observeVideos();

    const empty = $("#browse-empty");
    empty.classList.toggle("hidden", list.length > 0);
    if (!list.length) {
      empty.innerHTML = (q || state.filterTag)
        ? `Nincs találat${q ? ` erre: <b>„${esc(q)}”</b>` : ""}${state.filterTag ? ` a <b>#${esc(state.filterTag)}</b> címkével` : ""}.<br/>` +
          `<button type="button" class="btn sm" id="browse-reset" style="margin-top:10px">Szűrők törlése</button>`
        : `Még nincs recept.<br/><a class="btn sm primary" href="#add" style="margin-top:10px;display:inline-block">+ Recept hozzáadása</a>`;
    }
  }

  // ---- lazy video loading ----
  function loadVideo(v) {
    if (!v.dataset.src) return;
    v.src = v.dataset.src;
    v.preload = "metadata";
    delete v.dataset.src;
    // a missing/broken file falls back to the same placeholder as no-video
    v.addEventListener("error", () => {
      const ph = document.createElement("div");
      ph.className = "rec-placeholder";
      ph.setAttribute("aria-hidden", "true");
      ph.textContent = "🍳";
      const play = v.parentElement && v.parentElement.querySelector(".rec-play");
      if (play) play.remove();
      v.replaceWith(ph);
    }, { once: true });
  }
  let io = null;
  function observeVideos() {
    const vids = Array.from(document.querySelectorAll("#recipe-grid video[data-src]"));
    if (!("IntersectionObserver" in window)) { vids.forEach(loadVideo); return; }
    if (!io) {
      io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) { loadVideo(e.target); io.unobserve(e.target); }
        });
      }, { rootMargin: "300px 0px" });
    }
    io.disconnect();
    vids.forEach((v) => io.observe(v));
  }

  // Bind ONCE — render() only repaints. (Previously init() was never
  // called at all, so typing in the search box did nothing.)
  let _bound = false;
  function init() {
    if (_bound) return;
    _bound = true;

    let t = null;
    $("#search").addEventListener("input", () => { clearTimeout(t); t = setTimeout(render, 120); });

    $("#tagbar").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-tag]");
      if (!b) return;
      const tag = b.dataset.tag || null;
      state.filterTag = (tag && state.filterTag !== tag) ? tag : null;
      render();
    });

    $("#browse-empty").addEventListener("click", (e) => {
      if (!e.target.closest("#browse-reset")) return;
      state.filterTag = null;
      $("#search").value = "";
      render();
      $("#search").focus();
    });

    const grid = $("#recipe-grid");
    grid.addEventListener("click", (e) => {
      const c = e.target.closest(".recipe-card");
      if (c) openRecipe(c.dataset.id);
    });
    grid.addEventListener("keydown", (e) => {
      const c = e.target.closest(".recipe-card");
      if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openRecipe(c.dataset.id); }
    });

    // hover preview — pointer devices only (touch has no hover)
    if (window.matchMedia && window.matchMedia("(hover: hover)").matches) {
      grid.addEventListener("mouseover", (e) => {
        const c = e.target.closest(".recipe-card");
        const v = c && c.querySelector("video");
        if (v) loadVideo(v);
        if (v && v.paused) v.play().catch(() => {});
      });
      grid.addEventListener("mouseout", (e) => {
        const c = e.target.closest(".recipe-card");
        if (!c || (e.relatedTarget && c.contains(e.relatedTarget))) return;
        const v = c.querySelector("video");
        if (v) { v.pause(); v.currentTime = 0.1; }
      });
    }
  }

  return { render, init };
})();
