/* ============================================================
   Solin v3 — app.js (boot)
   Wires navigation, browse init, and initial view on load.
   ============================================================ */
(function () {
  const S = window.Solin;
  S.initNav();

  // initial view from hash or UI state
  const ui = S.S.getUI();
  const start = (location.hash ? location.hash.replace(/^#\/?/, "") : (ui.tab || "browse"));
  if (/^recipe\/(.+)$/.test(start)) {
    S.state.activeRecipe = start.split("/")[1]; S.tab("recipe");
  } else if (start === "inventory") S.tab("inventory");
  else if (start === "match") S.tab("match");
  else S.tab("browse");

  // inventory changes update match view when it is open
  if (window.Inventory && window.Match) {
    window.Inventory.onInventoryChanged(() => {
      if (window.Solin.state.tab === "match") window.Match.runMatch();
    });
  }

  console.log("Solin v3 ready —", S.S.getRecipes().length, "recipes loaded");
})();
