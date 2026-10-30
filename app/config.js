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

  /* ---- Auth headers for Cloudflare Zero Trust / Service Token ---- */
  function getAuthHeaders() {
    const h = {};
    try {
      const id = localStorage.getItem("solin.cf_client_id");
      const secret = localStorage.getItem("solin.cf_client_secret");
      if (id && id.trim()) h["CF-Access-Client-Id"] = id.trim();
      if (secret && secret.trim()) h["CF-Access-Client-Secret"] = secret.trim();
    } catch (e) {}
    return h;
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
      badge.textContent = current + (isOverridden ? " *" : "");
      badge.title = "Environment: " + current + " (Tap to change environment or Cloudflare credentials)";
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
      if (Object.keys(auth).length > 0 && typeof url === "string" && (url.includes("ateszito.com") || url.startsWith("/api/"))) {
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
    if (overlay) {
      overlay.classList.remove("hidden");
      return;
    }

    overlay = document.createElement("div");
    overlay.id = "env-modal-overlay";
    overlay.className = "env-modal-overlay";

    const current = getEffectiveEnv();
    const cfId = localStorage.getItem("solin.cf_client_id") || "";
    const cfSecret = localStorage.getItem("solin.cf_client_secret") || "";

    overlay.innerHTML = `
      <div class="env-modal-card">
        <div class="env-modal-header">
          <h3>Solin Settings</h3>
          <button type="button" class="btn sm ghost" id="env-modal-close" style="font-size:18px;padding:2px 8px;">✕</button>
        </div>
        <div style="font-size:12px;color:var(--text-2);margin-bottom:12px;">
          Choose backend environment and configure optional Cloudflare Access Service Token.
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
          <input id="solin-cf-secret" type="password" placeholder="Service token secret" value="${cfSecret.replace(/"/g, "&quot;")}" />
        </div>

        <div id="env-test-status" class="env-status-msg"></div>

        <div class="env-modal-actions">
          <button type="button" class="btn sm" id="env-test-btn">Test Connection</button>
          <button type="button" class="btn sm primary" id="env-save-btn">Save &amp; Apply</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector("#env-modal-close").addEventListener("click", () => {
      overlay.classList.add("hidden");
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.add("hidden");
    });

    const statusEl = overlay.querySelector("#env-test-status");

    // Test Connection
    overlay.querySelector("#env-test-btn").addEventListener("click", async () => {
      const selected = overlay.querySelector('input[name="solin-env-radio"]:checked')?.value || "production";
      const targetBase = ENV_ENDPOINTS[selected];
      const testId = overlay.querySelector("#solin-cf-id").value.trim();
      const testSecret = overlay.querySelector("#solin-cf-secret").value.trim();

      statusEl.className = "env-status-msg";
      statusEl.style.display = "block";
      statusEl.textContent = "Connecting to " + targetBase + "/healthz ...";

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
          statusEl.textContent = `✓ Connected (HTTP ${res.status}, ${latency}ms): ${text.trim()}`;
        } else {
          statusEl.className = "env-status-msg err";
          statusEl.textContent = `✗ HTTP ${res.status} ${res.statusText}: ${text.slice(0, 100)}`;
        }
      } catch (err) {
        statusEl.className = "env-status-msg err";
        statusEl.textContent = "✗ Network error: " + (err.message || String(err));
      }
    });

    // Save & Apply
    overlay.querySelector("#env-save-btn").addEventListener("click", () => {
      const selected = overlay.querySelector('input[name="solin-env-radio"]:checked')?.value || "production";
      const testId = overlay.querySelector("#solin-cf-id").value.trim();
      const testSecret = overlay.querySelector("#solin-cf-secret").value.trim();

      localStorage.setItem("solin.env.target", selected);
      if (testId) localStorage.setItem("solin.cf_client_id", testId);
      else localStorage.removeItem("solin.cf_client_id");

      if (testSecret) localStorage.setItem("solin.cf_client_secret", testSecret);
      else localStorage.removeItem("solin.cf_client_secret");

      cfg.env = selected;
      paintBadge();
      overlay.classList.add("hidden");

      if (typeof window.Solin !== "undefined" && typeof window.Solin.toast === "function") {
        window.Solin.toast("Switched to " + selected + " environment");
      }
      // If FcApi exists, trigger refresh
      if (typeof window.FcApi !== "undefined" && typeof window.FoodCounter !== "undefined" && typeof window.FoodCounter.loadProducts === "function") {
        window.FoodCounter.loadProducts();
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
