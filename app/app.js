/* ============================================================
   Solin v3 — app.js (boot)
   Wires navigation, browse init, and initial view on load.
   ============================================================ */
(function () {
  const S = window.Solin;

  // Drop new-recipe drafts abandoned in an earlier session (tab closed
  // mid-edit) — keep the one a #edit/<id> deep link is reopening.
  const editHash = /^#\/?edit\/(.+)$/.exec(location.hash);
  S.S.purgeBlankRecipes(editHash ? decodeURIComponent(editHash[1]) : null);

  // One-time bindings for static controls (render() functions must stay
  // idempotent — they are called on every tab switch).
  if (window.Browse && window.Browse.init) window.Browse.init();
  if (window.Inventory && window.Inventory.init) window.Inventory.init();
  if (window.Match && window.Match.init) window.Match.init();
  if (window.Edit && window.Edit.init) window.Edit.init();

  // initNav() routes a deep-link hash itself (incl. #recipe/<id>, #edit/<id>);
  // only fall back to the last remembered tab when there is no hash.
  S.initNav();
  if (!location.hash) {
    const ui = S.S.getUI();
    const start = ["add", "inventory", "match", "foodcounter"].includes(ui.tab) ? ui.tab : "browse";
    S.go(start);
  }

  // inventory changes update match view when it is open
  if (window.Inventory && window.Match) {
    window.Inventory.onInventoryChanged(() => {
      if (window.Solin.state.tab === "match") window.Match.runMatch();
    });
  }

  // Language switcher wiring
  const langBtn = document.getElementById("lang-switch");
  if (langBtn && window.SolinI18n) {
    langBtn.addEventListener("click", () => {
      window.SolinI18n.toggleLang();
    });
  }

  if (window.SolinI18n) {
    window.SolinI18n.onChange(() => {
      if (window.Browse && window.Browse.render) window.Browse.render();
      if (window.Inventory && window.Inventory.render) window.Inventory.render();
      if (window.Detail && window.Solin.state.tab === "recipe" && window.Solin.state.activeRecipe) {
        window.Detail.render(window.Solin.state.activeRecipe);
      }
    });
  }

  // Cross-device recipe synchronization on startup
  if (S.S && S.S.syncRecipesWithBackend) {
    S.S.syncRecipesWithBackend().then((changed) => {
      if (changed && window.Browse && window.Browse.render) {
        window.Browse.render();
      }
    });
  }

  console.log("Solin v3 ready —", S.S.getRecipes().length, "recipes loaded");
})();
