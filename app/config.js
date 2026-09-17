/* ============================================================
   Solin — config.js (env bridge, loads FIRST)
   ------------------------------------------------------------
   Source of truth: the BAKED-IN window.SOLIN_CONFIG object, emitted
   by the Dockerfile from build-args (SOLIN_ENV, APP_VERSION,
   API_BASE_URL, … — blueprint docs/THREE_ENV_ARCHITECTURE.md sec 3).

   Build pipeline (sec 7.3 — verified): `docker build --build-arg
   SOLIN_ENV=staging …`  →  Dockerfile writes /usr/share/nginx/html/
   _solin.env.js  →  index.html loads it, then config.js (this file)
   reads window.SOLIN_CONFIG. Runtime fallback: if no baked config
   exists (e.g. `python3 -m http.server` local preview), this module
   derives a conservative 'development'-ish default and logs it, so
   the app still boots.

   Nothing else in the app should read window.SOLIN_CONFIG directly —
   go through window.SolinCfg (the helpers below): apiBase(), flag().
   ============================================================ */
window.SolinCfg = (function () {
  const BAKED = window.SOLIN_CONFIG || null;
  const isTrue = (v) => v === true || v === "true" || v === "1";

  const cfg = {
    env: BAKED ? BAKED.SOLIN_ENV : "development",
    version: BAKED ? BAKED.APP_VERSION : "v0.0.0-local",
    apiBase: BAKED ? BAKED.API_BASE_URL : "",
    publicBase: BAKED ? BAKED.PUBLIC_BASE_URL : "",
    allowEdit: BAKED ? isTrue(BAKED.FEATURE_ALLOW_EDIT) : true,
    invisibility: BAKED ? isTrue(BAKED.FEATURE_INVISIBILITY) : true,
    debug: BAKED ? isTrue(BAKED.DEBUG) : false,
    baked: !!BAKED
  };

  if (!BAKED) {
    console.warn("[solin.cfg] no baked config found — assuming local development defaults");
  } else if (cfg.debug) {
    console.debug("[solin.cfg]", cfg);
  }

  /* ---- small helpers used by the views ---- */
  function apiBase() {
    // relative ("") means "same origin" — correct when the SPA and API
    // are served from the same host via the Cloudflare tunnel.
    return cfg.apiBase || "";
  }
  function flag(name) {
    if (name === "edit") return cfg.allowEdit;
    if (name === "invisibility") return cfg.invisibility;
    return true;
  }

  /* ---- UI: replace the hard-coded header pill with the real env badge ---- */
  function paintBadge() {
    // env badge (acceptance A6: SOLIN_ENV visible in UI badge)
    const badge = document.querySelector("#env-badge");
    if (badge) {
      badge.textContent = cfg.env;
      badge.style.background =
        cfg.env === "production" ? "#FDECEC" :
        cfg.env === "staging"    ? "#FFF4E0" : "#E6F7E6";
      badge.style.color =
        cfg.env === "production" ? "#C62828" :
        cfg.env === "staging"    ? "#B26A00" : "#1E7D33";
    }
    // version pill
    const ver = document.querySelector(".version");
    if (ver) ver.textContent = cfg.version;
  }

  /* ---- UI: feature-flag gates (blueprint sec 3.1 flags) ----
     FEATURE_INVISIBILITY=false → hide Inventory / What-I-have tabs.
     FEATURE_ALLOW_EDIT=false   → hide the ✎ Szerkesztés button (patched
                                   in detail.js via flag('edit')).     */
  function applyGates() {
    if (!flag("invisibility")) {
      ["inventory", "match"].forEach((nav) => {
        const b = document.querySelector(`#bottom-nav button[data-nav="${nav}"]`);
        if (b) b.hidden = true;
      });
    }
    if (!flag("edit")) {
      const eb = document.querySelector("#edit-open");
      if (eb) eb.hidden = true;
    }
  }

  // Safe to call from a <script> in <head>: guards for pre-DOM state.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { paintBadge(); applyGates(); });
  } else {
    paintBadge();
    applyGates();
  }

  return { cfg, apiBase, flag, paintBadge, applyGates };
})();
