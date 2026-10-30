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

  console.log("Solin v3 ready —", S.S.getRecipes().length, "recipes loaded");
})();
