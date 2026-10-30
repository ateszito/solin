/* ============================================================
   Solin — config.js (env bridge, loads FIRST)
   ------------------------------------------------------------
   Source of truth: the BAKED-IN window.SOLIN_CONFIG object, emitted
   by the Dockerfile from build-args (SOLIN_ENV, APP_VERSION,
   API_BASE_URL, … — blueprint docs/THREE_ENV_ARCHITECTURE.md sec 3).

   Mobile / Multi-Environment Extension:
   - Supports native iOS/Android (Capacitor) where relative paths
     must map to the remote backend origin.
   - Provides an in-app Environment Switcher (dev, staging, prod)
     and Cloudflare Access Service Token credentials storage.
   - Transparently routes fetch calls to the target backend with
     CF-Access headers when configured.

   Nothing else in the app should read window.SOLIN_CONFIG directly —
   go through window.SolinCfg (the helpers below): apiBase(), flag().
   ============================================================ */
window.SolinCfg = (function () {
  "use strict";

  const BAKED = window.SOLIN_CONFIG || null;
  const isTrue = (v) => v === true || v === "true" || v === "1";

  const ENV_ENDPOINTS = {
    production: "https://solin.ateszito.com",
    staging: "https://solin-staging.ateszito.com",
    development: "https://solin-dev.ateszito.com",
    dev: "https://solin-dev.ateszito.com"
  };

  const isNative = !!(
    (typeof window.Capacitor !== "undefined" &&
      typeof window.Capacitor.isNativePlatform === "function" &&
      window.Capacitor.isNativePlatform()) ||
    (typeof window.location !== "undefined" &&
      (window.location.protocol === "capacitor:" || window.location.protocol === "ionic:"))
  );

  function getStoredEnv() {
    try {
      return localStorage.getItem("solin.env.target") || null;
    } catch (e) {
      return null;
    }
  }

  function getEffectiveEnv() {
    const stored = getStoredEnv();
    if (stored && ENV_ENDPOINTS[stored]) return stored === "dev" ? "development" : stored;
    if (BAKED && BAKED.SOLIN_ENV) return BAKED.SOLIN_ENV;
    if (isNative) return "production";
    return "development";
  }

  const effectiveEnv = getEffectiveEnv();

  const cfg = {
    env: effectiveEnv,
    version: BAKED ? BAKED.APP_VERSION : (isNative ? "v0.1.3-ios" : "v0.0.0-local"),
    apiBase: BAKED ? BAKED.API_BASE_URL : "",
    publicBase: BAKED ? BAKED.PUBLIC_BASE_URL : "",
    allowEdit: BAKED ? isTrue(BAKED.FEATURE_ALLOW_EDIT) : true,
    invisibility: BAKED ? isTrue(BAKED.FEATURE_INVISIBILITY) : true,
    debug: BAKED ? isTrue(BAKED.DEBUG) : false,
    baked: !!BAKED,
    isNative: isNative
  };

  if (!BAKED && !isNative) {
    console.warn("[solin.cfg] no baked config found — assuming local development defaults");
  } else if (cfg.debug) {
    console.debug("[solin.cfg]", cfg);
  }

  /* ---- Cloudflare service-token storage ----
     The client SECRET is a credential. On the web it lives in
     sessionStorage (dies with the tab) unless the user explicitly ticks
     "remember on this device". The native app runs in a sandboxed
     WKWebView whose storage is private to the app, so it persists there. */
  const CF_ID = "solin.cf_client_id";
  const CF_SECRET = "solin.cf_client_secret";
  const CF_REMEMBER = "solin.cf_remember";

  function readSecret() {
    try {
      return sessionStorage.getItem(CF_SECRET) || localStorage.getItem(CF_SECRET) || "";
    } catch (e) { return ""; }
  }
  function writeSecret(secret, remember) {
    try {
      sessionStorage.removeItem(CF_SECRET);
      localStorage.removeItem(CF_SECRET);
      if (!secret) { localStorage.removeItem(CF_REMEMBER); return; }
      const persist = isNative || remember;
      (persist ? localStorage : sessionStorage).setItem(CF_SECRET, secret);
      if (remember) localStorage.setItem(CF_REMEMBER, "1");
      else localStorage.removeItem(CF_REMEMBER);
    } catch (e) {}
  }
  // One-time migration: older builds always persisted the secret in
  // localStorage on the web — move it to the session unless opted in.
  try {
    if (!isNative && localStorage.getItem(CF_SECRET) && !localStorage.getItem(CF_REMEMBER)) {
      sessionStorage.setItem(CF_SECRET, localStorage.getItem(CF_SECRET));
      localStorage.removeItem(CF_SECRET);
    }
  } catch (e) {}

  /* ---- Auth headers for Cloudflare Zero Trust / Service Token ---- */
  function getAuthHeaders() {
    const h = {};
    try {
      const id = localStorage.getItem(CF_ID);
      const secret = readSecret();
      if (id && id.trim()) h["CF-Access-Client-Id"] = id.trim();
      if (secret && secret.trim()) h["CF-Access-Client-Secret"] = secret.trim();
    } catch (e) {}
    return h;
  }

  // Only ever attach the service token to our own backends: same-origin
  // relative paths, or a host that IS (a subdomain of) ateszito.com.
  // (A substring check would also leak it to e.g. evil.com/?ateszito.com.)
  function isTrustedApiUrl(url) {
    if (typeof url !== "string" || !url) return false;
    if (url.startsWith("/") && !url.startsWith("//")) return true;
    try {
      const u = new URL(url, window.location.href);
      if (u.protocol !== "https:" && u.origin !== window.location.origin) return false;
      return u.hostname === "ateszito.com" || u.hostname.endsWith(".ateszito.com") ||
        u.origin === window.location.origin;
    } catch (e) { return false; }
  }

  /* ---- small helpers used by the views ---- */
  function apiBase() {
    const current = getEffectiveEnv();
    const stored = getStoredEnv();

    // If native platform or user explicitly overrode the environment
    if (isNative || stored) {
      return ENV_ENDPOINTS[current] || (BAKED && BAKED.API_BASE_URL) || ENV_ENDPOINTS.production;
    }

    // Relative ("") on web when served from same host via Cloudflare tunnel
    return cfg.apiBase || "";
  }

  function flag(name) {
    if (name === "edit") return cfg.allowEdit;
    if (name === "invisibility") return cfg.invisibility;
    return true;
  }

  /* ---- UI: replace the hard-coded header pill with the real env badge ---- */
  function paintBadge() {
    const current = getEffectiveEnv();
    const isOverridden = !!getStoredEnv();
    const badge = document.querySelector("#env-badge");
    if (badge) {
      // End users on the production web build don't need to see (or tap)
      // an environment switcher. Keep it for dev/staging, overrides,
      // DEBUG builds and the native app (used by testers).
      badge.hidden = current === "production" && !isOverridden && !cfg.debug && !isNative;
      badge.textContent = current + (isOverridden ? " *" : "");
      badge.title = "Környezet: " + current + " (koppints a váltáshoz / Cloudflare beállításokhoz)";
      badge.style.background =
        current === "production" ? "#FDECEC" :
        current === "staging"    ? "#FFF4E0" : "#E6F7E6";
      badge.style.color =
        current === "production" ? "#C62828" :
        current === "staging"    ? "#B26A00" : "#1E7D33";
      badge.style.cursor = "pointer";

      // Attach click handler if not already attached
      if (!badge.dataset.envModalBound) {
        badge.dataset.envModalBound = "true";
        badge.addEventListener("click", () => openEnvModal());
      }
    }
    // version pill
    const ver = document.querySelector(".version");
    if (ver) ver.textContent = cfg.version;
  }

  /* ---- UI: feature-flag gates (blueprint sec 3.1 flags) ---- */
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
    // QA / demo helpers (e.g. the canonical sample-data button) are only
    // shown on non-production builds or when DEBUG is on.
    if (cfg.env === "production" && !cfg.debug) {
      document.querySelectorAll("[data-dev-only]").forEach((el) => { el.hidden = true; });
    }
  }

  /* ---- Transparent fetch interceptor for Native & Cloudflare Access ---- */
  if (typeof window !== "undefined" && typeof window.fetch === "function") {
    const origFetch = window.fetch;
    window.fetch = function (resource, init) {
      let url = typeof resource === "string" ? resource : (resource && resource.url ? resource.url : "");
      const options = init ? Object.assign({}, init) : {};
      const base = apiBase();

      // In native mode or with env override, rewrite relative "/api/..." to absolute backend origin
      if (base && typeof url === "string" && url.startsWith("/")) {
        url = base.replace(/\/+$/, "") + url;
        if (typeof resource === "string") {
          resource = url;
        } else if (resource && typeof Request !== "undefined" && resource instanceof Request) {
          resource = new Request(url, resource);
        }
      }

      // Inject Cloudflare Access headers if configured and requesting target backend
      const auth = getAuthHeaders();
      if (Object.keys(auth).length > 0 && isTrustedApiUrl(url)) {
        let headers = options.headers || (resource && resource.headers) || {};
        if (typeof Headers !== "undefined" && headers instanceof Headers) {
          for (const [k, v] of Object.entries(auth)) {
            if (!headers.has(k)) headers.set(k, v);
          }
        } else if (Array.isArray(headers)) {
          for (const [k, v] of Object.entries(auth)) {
            headers.push([k, v]);
          }
        } else {
          options.headers = Object.assign({}, headers, auth);
        }
      }

      return origFetch.call(this, resource, options);
    };
  }

  /* ---- Environment & Cloudflare Settings Modal ---- */
  function openEnvModal() {
    let overlay = document.getElementById("env-modal-overlay");
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = "env-modal-overlay";
    overlay.className = "env-modal-overlay";

    const current = getEffectiveEnv();
    const cfId = localStorage.getItem(CF_ID) || "";
    const hasSecret = !!readSecret();
    const remembered = !!localStorage.getItem(CF_REMEMBER);

    overlay.innerHTML = `
      <div class="env-modal-card" role="dialog" aria-modal="true" aria-labelledby="env-modal-title">
        <div class="env-modal-header">
          <h3 id="env-modal-title">Solin beállítások</h3>
          <button type="button" class="btn sm ghost" id="env-modal-close" aria-label="Bezárás" style="font-size:18px;padding:2px 8px;">✕</button>
        </div>
        <div style="font-size:12px;color:var(--text-2);margin-bottom:12px;">
          Válaszd ki a backend környezetet, és add meg az opcionális Cloudflare Access service tokent.
        </div>
        <div class="env-option-group">
          <label class="env-option">
            <input type="radio" name="solin-env-radio" value="production" ${current === "production" ? "checked" : ""} />
            <div>
              <div class="env-option-label">Production</div>
              <div class="env-option-url">https://solin.ateszito.com</div>
            </div>
          </label>
          <label class="env-option">
            <input type="radio" name="solin-env-radio" value="staging" ${current === "staging" ? "checked" : ""} />
            <div>
              <div class="env-option-label">Staging</div>
              <div class="env-option-url">https://solin-staging.ateszito.com</div>
            </div>
          </label>
          <label class="env-option">
            <input type="radio" name="solin-env-radio" value="development" ${current === "development" ? "checked" : ""} />
            <div>
              <div class="env-option-label">Development</div>
              <div class="env-option-url">https://solin-dev.ateszito.com</div>
            </div>
          </label>
        </div>

        <h4 style="font-size:13px;margin:16px 0 8px;">Cloudflare Access (Zero Trust)</h4>
        <div class="env-field-group">
          <label for="solin-cf-id">CF-Access-Client-Id</label>
          <input id="solin-cf-id" type="text" placeholder="e.g. 0123456789abcdef.access" value="${cfId.replace(/"/g, "&quot;")}" />
        </div>
        <div class="env-field-group">
          <label for="solin-cf-secret">CF-Access-Client-Secret</label>
          <input id="solin-cf-secret" type="password" autocomplete="off" placeholder="${hasSecret ? "•••••••• (mentve — üresen hagyva megmarad)" : "Service token secret"}" />
        </div>
        ${isNative ? "" : `<label class="env-remember"><input type="checkbox" id="solin-cf-remember" ${remembered ? "checked" : ""}/> Megjegyzés ezen az eszközön <span class="muted">(különben a lap bezárásakor törlődik)</span></label>`}
        ${hasSecret ? `<button type="button" class="btn sm ghost" id="solin-cf-forget" style="margin-bottom:8px">Mentett secret törlése</button>` : ""}

        <div id="env-test-status" class="env-status-msg" role="status"></div>

        <div class="env-modal-actions">
          <button type="button" class="btn sm" id="env-test-btn">Kapcsolat tesztelése</button>
          <button type="button" class="btn sm primary" id="env-save-btn">Mentés és alkalmazás</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // The modal is rebuilt on every open so it always reflects the stored
    // state (and the secret is never kept in the DOM after closing).
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.querySelector("#env-modal-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    const forget = overlay.querySelector("#solin-cf-forget");
    if (forget) forget.addEventListener("click", () => {
      writeSecret("", false);
      forget.remove();
      overlay.querySelector("#solin-cf-secret").placeholder = "Service token secret";
    });
    setTimeout(() => { const c = overlay.querySelector('input[name="solin-env-radio"]:checked'); if (c) c.focus(); }, 0);

    const statusEl = overlay.querySelector("#env-test-status");

    // Test Connection
    overlay.querySelector("#env-test-btn").addEventListener("click", async () => {
      const selected = overlay.querySelector('input[name="solin-env-radio"]:checked')?.value || "production";
      const targetBase = ENV_ENDPOINTS[selected];
      const testId = overlay.querySelector("#solin-cf-id").value.trim();
      const testSecret = overlay.querySelector("#solin-cf-secret").value.trim() || readSecret();

      statusEl.className = "env-status-msg";
      statusEl.style.display = "block";
      statusEl.textContent = "Kapcsolódás: " + targetBase + "/healthz …";

      try {
        const headers = {};
        if (testId) headers["CF-Access-Client-Id"] = testId;
        if (testSecret) headers["CF-Access-Client-Secret"] = testSecret;

        const t0 = performance.now();
        const res = await fetch(targetBase + "/healthz", { headers });
        const latency = Math.round(performance.now() - t0);
        const text = await res.text();

        if (res.ok) {
          statusEl.className = "env-status-msg ok";
          statusEl.textContent = `✓ Kapcsolódva (HTTP ${res.status}, ${latency} ms): ${text.trim().slice(0, 100)}`;
        } else {
          statusEl.className = "env-status-msg err";
          statusEl.textContent = `✗ HTTP ${res.status} ${res.statusText}: ${text.slice(0, 100)}`;
        }
      } catch (err) {
        statusEl.className = "env-status-msg err";
        statusEl.textContent = "✗ Hálózati hiba: " + (err.message || String(err));
      }
    });

    // Save & Apply
    overlay.querySelector("#env-save-btn").addEventListener("click", () => {
      const selected = overlay.querySelector('input[name="solin-env-radio"]:checked')?.value || "production";
      const testId = overlay.querySelector("#solin-cf-id").value.trim();
      const newSecret = overlay.querySelector("#solin-cf-secret").value.trim();
      const rememberEl = overlay.querySelector("#solin-cf-remember");
      const remember = !!(rememberEl && rememberEl.checked);

      localStorage.setItem("solin.env.target", selected);
      if (testId) localStorage.setItem(CF_ID, testId);
      else localStorage.removeItem(CF_ID);

      // empty field = keep the stored secret (it is never pre-filled)
      writeSecret(newSecret || readSecret(), remember);

      cfg.env = selected;
      paintBadge();
      close();

      if (typeof window.Solin !== "undefined" && typeof window.Solin.toast === "function") {
        window.Solin.toast("Környezet: " + selected);
      }
      // Refresh whatever API-backed view is open (product list etc.).
      if (window.Solin && window.Solin.state && window.Solin.state.tab === "foodcounter" &&
          window.FoodCounter && typeof window.FoodCounter.render === "function") {
        window.FoodCounter.render();
      }
    });
  }

  // Safe to call from a <script> in <head>: guards for pre-DOM state.
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => { paintBadge(); applyGates(); });
    } else {
      paintBadge();
      applyGates();
    }
  }

  return {
    cfg,
    apiBase,
    flag,
    paintBadge,
    applyGates,
    openEnvModal,
    getEffectiveEnv,
    getAuthHeaders,
    ENV_ENDPOINTS,
    isNative
  };
})();
