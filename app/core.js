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

  /* toast(msg, ms?, action?) — action = { label, onClick } renders an
     inline button (e.g. "Visszavonás" / undo) and keeps the toast up
     a little longer so it can actually be tapped. */
  function toast(msg, ms, action) {
    const el = $("#toast");
    const hide = () => {
      el.classList.add("hidden");
      el.classList.remove("show");
    };
    el.textContent = msg;
    if (action && action.label && typeof action.onClick === "function") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "toast-action";
      b.textContent = action.label;
      b.addEventListener("click", () => { clearTimeout(toast._t); hide(); action.onClick(); });
      el.appendChild(b);
    }
    el.classList.remove("hidden");
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(hide, ms || (action ? 5000 : 2200));
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Drill-down screens (recipe / edit / add) push ONE history entry when
  // entered from a main tab, so the browser / Android back button returns
  // to where the user came from instead of leaving the app. Moves between
  // drill-down screens and between main tabs just replace the entry.
  const isDrill = (h) => /^(recipe|edit)\/|^add$/.test(h || "");
  function setHash(h) {
    h = h || "browse";
    const want = "#" + h;
    if (location.hash === want) return;
    const cur = location.hash.replace(/^#\/?/, "");
    if (isDrill(h) && !isDrill(cur)) history.pushState({ solin: 1 }, "", want);
    else history.replaceState(history.state, "", want);
  }
  // In-app "← Vissza": step back in history when we pushed the entry
  // ourselves (returns to the list / match view the user came from, with
  // its scroll position), otherwise fall back to an explicit route.
  function back(fallback) {
    if (history.state && history.state.solin) history.back();
    else go(fallback || "browse");
  }

  function tab(view) {
    const prev = state.view;
    // Remember where the user was in the recipe list so "back" lands on
    // the same card instead of the top of the page.
    if (prev === "browse" && view !== "browse") state.browseScroll = window.scrollY;
    if (prev === "recipe" && view !== "recipe" && window.Detail && Detail.leave) Detail.leave();
    // Leaving the editor discards an unsaved new-recipe draft; its detail
    // page no longer exists then, so land on the recipe list instead.
    if (prev === "edit" && view !== "edit" && window.Edit && Edit.leave && Edit.leave() && view === "recipe") {
      view = "browse";
      if (location.hash !== "#browse") history.replaceState(history.state, "", "#browse");
      toast("Az új recept nem lett mentve");
    }
    state.view = view;
    state.tab = view === "edit" ? "recipe" : view;
    ["browse", "add", "recipe", "edit", "inventory", "match", "foodcounter"].forEach((v) =>
      $("#view-" + v).classList.add("hidden")
    );
    $("#view-" + view).classList.remove("hidden");
    // recipe/edit are children of "browse" — keep that tab highlighted
    const navKey = (view === "recipe" || view === "edit" || view === "add") ? "browse" : view;
    $$("#bottom-nav button").forEach((b) => {
      const on = b.dataset.nav === navKey;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    if (view === "browse")    Browse.render();
    if (view === "recipe")    Detail.render(state.activeRecipe || S.getRecipes()[0].id);
    if (view === "edit")      Edit.render();
    if (view === "inventory") Inventory.render();
    if (view === "match")     Match.render();
    if (view === "add" && window.AddRecipe) AddRecipe.mount();
    if (view === "foodcounter" && window.FoodCounter) FoodCounter.render();
    S.setUI({ tab: state.tab === "recipe" ? "browse" : state.tab });
    const restore = view === "browse" && (prev === "recipe" || prev === "edit") && state.browseScroll;
    window.scrollTo({ top: restore ? state.browseScroll : 0 });
  }

  /* ---- navigation ---- */
  function go(view) {
    tab(view);
    view = state.view;   // tab() may redirect (e.g. discarded draft)
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
    else tab(["add", "inventory", "match", "foodcounter"].includes(h) ? h : "browse");
  }

  function initNav() {
    $$("#bottom-nav button").forEach((b) =>
      b.addEventListener("click", () => go(b.dataset.nav))
    );
    $("#back-btn").addEventListener("click", () => back("browse"));
    $("#edit-back").addEventListener("click", () => go("recipe"));
    window.addEventListener("hashchange", onHash);
    if (location.hash) onHash();
  }

  return {
    state, $, $$, S, toast, esc,
    initNav, go, back, tab, openRecipe, openEdit, setHash
  };
})();
