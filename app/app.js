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
      if (window.SolinAuth) {
        if (window.Solin.state.view === "profile") window.SolinAuth.renderProfile();
        if (!window.SolinAuth.isAuthenticated()) window.SolinAuth.renderAuthGate();
      }
    });
  }

  // Initialize Authentication Gate & User Profile system
  if (window.SolinAuth && window.SolinAuth.init) {
    window.SolinAuth.init();
  }

  // Handle Web Share Target (?share_url=... or ?share_text=...) from mobile share sheet
  try {
    const params = new URLSearchParams(location.search || "");
    const rawShare = params.get("share_url") || params.get("share_text") || "";
    const urlMatch = rawShare.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch && urlMatch[0]) {
      window.__SOLIN_SHARED_URL = urlMatch[0];
      history.replaceState(history.state, "", location.pathname + "#add");
      S.go("add");
      setTimeout(() => {
        const urlIn = document.getElementById("add-video-url-input");
        if (urlIn) {
          urlIn.value = window.__SOLIN_SHARED_URL;
          urlIn.focus();
        }
      }, 150);
    }
  } catch (e) {}

  // Cross-device recipe synchronization on startup (when authenticated or when SolinAuth isn't loaded in unit tests)
  if (S.S && S.S.syncRecipesWithBackend && (!window.SolinAuth || window.SolinAuth.isAuthenticated())) {
    S.S.syncRecipesWithBackend().then((changed) => {
      if (changed && window.Browse && window.Browse.render) {
        window.Browse.render();
      }
    });
  }

  // Register Offline PWA Service Worker
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  console.log("Solin v3 ready —", S.S.getRecipes().length, "recipes loaded");
})();
