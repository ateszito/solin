/* ============================================================
   Solin v3 — core.js
   Shared UI state, tab navigation, toast, small helpers.
   ============================================================ */

window.Solin = (function () {
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const S  = window.SolinStore;

  const state = {
    tab: "browse",
    activeRecipe: null,   // id of recipe currently shown
    filterTag: null,
    query: "",
    have: S.getHave()
  };

  function toast(msg, ms) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.classList.add("hidden");
      el.classList.remove("show");
    }, ms || 2200);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setHash(h) {
    const want = "#" + (h || "browse");
    if (location.hash !== want) history.replaceState(null, "", want);
  }

  function tab(view) {
    state.tab = view === "edit" ? "recipe" : view;
    ["browse", "recipe", "edit", "inventory", "match"].forEach((v) =>
      $("#view-" + v).classList.add("hidden")
    );
    $("#view-" + view).classList.remove("hidden");
    $$("#bottom-nav button").forEach((b) =>
      b.classList.toggle("active", b.dataset.nav === (view === "edit" ? "" : view))
    );
    if (view === "browse")    Browse.render();
    if (view === "recipe")    Detail.render(state.activeRecipe || S.getRecipes()[0].id);
    if (view === "edit")      Edit.render();
    if (view === "inventory") Inventory.render();
    if (view === "match")     Match.render();
    S.setUI({ tab: state.tab === "recipe" ? "browse" : state.tab });
    window.scrollTo({ top: 0 });
  }

  /* ---- navigation ---- */
  function go(view) {
    tab(view);
    if (view === "browse") setHash("browse");
    else if (view === "recipe") setHash("recipe/" + (state.activeRecipe || ""));
    else if (view === "edit")   setHash("edit/" + (state.activeRecipe || ""));
    else setHash(view);
  }
  function openRecipe(id) { state.activeRecipe = id; go("recipe"); }
  function openEdit(id)   { state.activeRecipe = id; go("edit"); }

  function onHash() {
    const h = location.hash.replace(/^#\/?/, "");
    if (/^recipe\/(.+)$/.test(h)) { state.activeRecipe = h.split("/")[1]; tab("recipe"); }
    else if (/^edit\/(.+)$/.test(h)) { state.activeRecipe = h.split("/")[1]; tab("edit"); }
    else if (["browse", "inventory", "match"].includes(h) || h === "") tab("browse");
    else if (h === "inventory") tab("inventory");
    else if (h === "match") tab("match");
  }

  function initNav() {
    $$("#bottom-nav button").forEach((b) =>
      b.addEventListener("click", () => go(b.dataset.nav))
    );
    $("#back-btn").addEventListener("click", () => go("browse"));
    $("#edit-back").addEventListener("click", () => go("recipe"));
    window.addEventListener("hashchange", onHash);
    if (location.hash) onHash();
  }

  return {
    state, $, $$, S, toast, esc,
    initNav, go, tab, openRecipe, openEdit, setHash
  };
})();
