/* ============================================================
   Solin v3 — auth.js
   User Authentication Gate (Email/Password + Google Sign-In),
   Bearer JWT fetch interceptor, and User Profile management.
   ============================================================ */

window.SolinAuth = (function () {
  const TOKEN_KEY = "solin.auth.token.v1";
  const USER_KEY = "solin.auth.user.v1";
  const GOOGLE_ACCOUNTS_KEY = "solin.auth.google_accounts.v1";

  const AVATAR_OPTIONS = ["👩‍🍳", "👨‍🍳", "🥑", "🍕", "🥗", "🍲", "🌶️", "🍰", "🏋️‍♀️", "🏋️‍♂️", "🦊", "☕"];

  const DIET_OPTIONS = [
    { id: "high_protein", hu: "🥩 Magas fehérje", en: "🥩 High protein" },
    { id: "lactose_free", hu: "🥛 Laktózmentes", en: "🥛 Lactose-free" },
    { id: "gluten_free", hu: "🌾 Gluténmentes", en: "🌾 Gluten-free" },
    { id: "vegetarian", hu: "🥦 Vegetáriánus", en: "🥦 Vegetarian" },
    { id: "vegan", hu: "🌱 Vegán", en: "🌱 Vegan" },
    { id: "low_calorie", hu: "🔥 Alacsony kalória", en: "🔥 Low calorie" },
    { id: "sugar_free", hu: "🍬 Cukormentes", en: "🍬 Sugar-free" }
  ];

  let authMode = "login"; // "login" | "register"
  let googlePickerOpen = false;
  let authConfig = { google_client_id: "", google_enabled: true, require_auth: true };
  let selectedAvatar = "👩‍🍳";
  let selectedDiets = new Set();

  function _t(key, fallbackHu, fallbackEn) {
    const lang = (window.SolinI18n && window.SolinI18n.getLang) ? window.SolinI18n.getLang() : "hu";
    if (window.SolinI18n && window.SolinI18n.t) {
      const val = window.SolinI18n.t(key, "");
      if (val && val !== key) return val;
    }
    return lang === "en" ? (fallbackEn || fallbackHu || key) : (fallbackHu || key);
  }

  function _esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function _apiBase() {
    try {
      const cfg = window.SolinCfg;
      if (cfg && typeof cfg.apiBase === "function") return cfg.apiBase() || "";
      if (cfg && typeof cfg.apiBase === "string") return cfg.apiBase;
    } catch (e) {}
    return "";
  }

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function getUser() {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function isAuthenticated() {
    const u = getUser();
    return Boolean(getToken() && u && u.status !== "pending" && u.status !== "blocked");
  }

  function setSession(token, user) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch (e) {}
    if (user && user.language && window.SolinI18n && window.SolinI18n.setLang) {
      if (window.SolinI18n.getLang() !== user.language) {
        window.SolinI18n.setLang(user.language);
      }
    }
    updateHeaderProfile();
  }

  function clearSession() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch (e) {}
    updateHeaderProfile();
  }

  function getSavedGoogleAccounts() {
    try {
      const raw = localStorage.getItem(GOOGLE_ACCOUNTS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveGoogleAccount(email, displayName, picture) {
    try {
      const list = getSavedGoogleAccounts().filter(
        (a) => (a.email || "").toLowerCase() !== (email || "").toLowerCase()
      );
      list.unshift({
        email: email.trim().toLowerCase(),
        display_name: displayName || email.split("@")[0],
        picture: picture || ""
      });
      localStorage.setItem(GOOGLE_ACCOUNTS_KEY, JSON.stringify(list.slice(0, 5)));
    } catch (e) {}
  }

  // ---- Global Fetch Interceptor for Bearer Token ----
  if (typeof window !== "undefined" && typeof window.fetch === "function" && !window.fetch.__solinAuthPatched) {
    const origFetch = window.fetch.bind(window);
    const patchedFetch = async function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
      const isApiCall = url.startsWith("/api/") || url.includes("/api/v1/");
      const token = getToken();

      if (isApiCall && token) {
        init = Object.assign({}, init || {});
        const headers = new Headers(init.headers || {});
        if (!headers.has("Authorization")) {
          headers.set("Authorization", "Bearer " + token);
        }
        init.headers = headers;
      }

      const res = await origFetch(input, init);
      if (
        res &&
        res.status === 401 &&
        isApiCall &&
        !url.includes("/api/v1/auth/login") &&
        !url.includes("/api/v1/auth/register") &&
        !url.includes("/api/v1/auth/google") &&
        !url.includes("/api/v1/auth/change-password")
      ) {
        if (getToken()) {
          clearSession();
          lockApp();
        }
      }
      return res;
    };
    patchedFetch.__solinAuthPatched = true;
    window.fetch = patchedFetch;
  }

  function lockApp() {
    document.body.classList.add("auth-locked");
    const gate = document.getElementById("auth-gate");
    if (gate) {
      gate.classList.remove("hidden");
      renderAuthGate();
    }
    updateHeaderProfile();
  }

  function unlockApp() {
    document.body.classList.remove("auth-locked");
    const gate = document.getElementById("auth-gate");
    if (gate) {
      gate.classList.add("hidden");
    }
    updateHeaderProfile();

    // Trigger backend sync now that we have a valid Bearer token
    if (window.SolinStore) {
      if (window.SolinStore.syncRecipesWithBackend) {
        window.SolinStore.syncRecipesWithBackend().then((changed) => {
          if (changed && window.Browse && window.Browse.render) {
            window.Browse.render();
          }
        });
      }
      if (window.SolinStore.syncKamraFromApi) {
        window.SolinStore.syncKamraFromApi().then(() => {
          if (window.Inventory && window.Inventory.render && window.Solin && window.Solin.state.view === "inventory") {
            window.Inventory.render();
          }
        });
      }
    }
    if (window.Browse && window.Browse.render) {
      window.Browse.render();
    }
  }

  function updateHeaderProfile() {
    const btn = document.getElementById("profile-btn");
    if (!btn) return;
    const user = getUser();
    if (!user || !getToken()) {
      btn.classList.add("hidden");
      return;
    }
    btn.classList.remove("hidden");
    const avatar = user.avatar || "👩‍🍳";
    const name = user.display_name || user.email.split("@")[0];
    btn.innerHTML = `<span class="profile-btn-avatar">${_esc(avatar)}</span> <span class="profile-btn-name">${_esc(name)}</span>`;
    btn.title = _t("profile_title", "Profil és beállítások", "Profile & settings") + ` (${user.email})`;
  }

  // ---- Render Auth Gate (Login / Register / Google / Pending Approval) ----
  function renderAuthGate(errorMsg) {
    const gate = document.getElementById("auth-gate");
    if (!gate) return;

    const currentUser = getUser();
    const lang = (window.SolinI18n && window.SolinI18n.getLang) ? window.SolinI18n.getLang() : "hu";

    // If user is logged in but awaiting Owner approval:
    if (getToken() && currentUser && currentUser.status === "pending") {
      gate.innerHTML = `
        <div class="auth-card">
          <div class="auth-card-top">
            <div class="auth-brand">
              <span class="logo auth-logo">S</span>
              <div>
                <h2 class="auth-title">Solin</h2>
                <p class="auth-subtitle">${_esc(currentUser.email)}</p>
              </div>
            </div>
          </div>
          <div class="auth-security-banner" style="background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.35);">
            <span>⏳</span>
            <span>${_t("auth_pending_msg", "A fiókod létrejött, de a biztonságos hozzáféréshez a tulajdonos (Owner) jóváhagyása szükséges.", "Your account was created and is awaiting Owner approval before accessing private recipes.")}</span>
          </div>
          <div style="display:flex;gap:8px;margin-top:14px;">
            <button type="button" id="auth-check-status-btn" class="btn primary" style="flex:1;">
              🔄 ${_t("auth_refresh_status", "Jóváhagyás ellenőrzése", "Check approval status")}
            </button>
            <button type="button" id="auth-pending-logout-btn" class="btn ghost">
              🚪 ${_t("auth_logout", "Kijelentkezés", "Sign out")}
            </button>
          </div>
        </div>
      `;
      const chkBtn = gate.querySelector("#auth-check-status-btn");
      if (chkBtn) {
        chkBtn.addEventListener("click", async () => {
          try {
            const res = await fetch(_apiBase() + "/api/v1/auth/me");
            if (res.ok) {
              const fresh = await res.json();
              setSession(getToken(), fresh);
              if (fresh.status === "active") {
                unlockApp();
                if (window.Solin && window.Solin.toast) window.Solin.toast(_t("auth_approved_toast", "Fiókod jóváhagyva! ✓", "Account approved! ✓"));
              } else {
                if (window.Solin && window.Solin.toast) window.Solin.toast(_t("auth_still_pending", "Még jóváhagyásra vár…", "Still awaiting approval…"));
              }
            }
          } catch (e) {}
        });
      }
      const outBtn = gate.querySelector("#auth-pending-logout-btn");
      if (outBtn) {
        outBtn.addEventListener("click", () => {
          clearSession();
          renderAuthGate();
        });
      }
      return;
    }

    const isLogin = authMode === "login";
    const savedGoogle = getSavedGoogleAccounts();

    gate.innerHTML = `
      <div class="auth-card">
        <div class="auth-card-top">
          <div class="auth-brand">
            <span class="logo auth-logo">S</span>
            <div>
              <h2 class="auth-title">Solin</h2>
              <p class="auth-subtitle">${_t("auth_subtitle", "Privát recepttár, kamra és makró-tervező", "Private recipe vault, pantry & macro planner")}</p>
            </div>
          </div>
          <button type="button" id="auth-lang-btn" class="pill" style="cursor:pointer;font-weight:700;">
            ${lang === "hu" ? "🇭🇺 HU" : "🇬🇧 EN"}
          </button>
        </div>

        <div class="auth-security-banner">
          <span>🔒</span>
          <span>${_t("auth_gate_notice", "A funkciók eléréséhez jelentkezz be Google-fiókkal vagy regisztrálj.", "Please sign in with Google or create an account to access Solin features.")}</span>
        </div>

        <div class="auth-tabs" role="tablist">
          <button type="button" class="auth-tab ${isLogin ? "active" : ""}" data-auth-tab="login">
            ${_t("auth_login_tab", "Bejelentkezés", "Sign in")}
          </button>
          <button type="button" class="auth-tab ${!isLogin ? "active" : ""}" data-auth-tab="register">
            ${_t("auth_register_tab", "Regisztráció", "Create account")}
          </button>
        </div>

        ${errorMsg ? `<div class="auth-error" role="alert">${_esc(errorMsg)}</div>` : ""}

        <button type="button" id="auth-google-btn" class="google-btn">
          <svg class="google-ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="#EA4335" d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.4 1 3.5 3.6 1.6 7.4l3.7 2.8C6.2 7.2 8.9 5 12 5z"/>
            <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6l3.7 2.9c2.2-2 3.7-5 3.7-8.7z"/>
            <path fill="#FBBC05" d="M5.3 14.8c-.2-.8-.4-1.6-.4-2.5s.2-1.7.4-2.5L1.6 7C.6 9 0 11.2 0 13.5s.6 4.5 1.6 6.5l3.7-2.9z"/>
            <path fill="#34A853" d="M12 23c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3.1 0-5.8-2.1-6.7-5l-3.7 2.8C3.5 19.9 7.4 23 12 23z"/>
          </svg>
          <span>${_t("auth_google_btn", "Folytatás Google-fiókkal", "Continue with Google")}</span>
        </button>

        ${googlePickerOpen ? `
          <div class="google-picker-box">
            <div class="google-picker-head">
              <strong>${_t("auth_google_title", "Bejelentkezés Google-fiókkal", "Sign in with Google")}</strong>
              <button type="button" id="google-picker-close" class="btn sm ghost">✕</button>
            </div>
            ${savedGoogle.length ? `
              <div class="google-saved-list">
                ${savedGoogle.map((acc, idx) => `
                  <button type="button" class="google-saved-item" data-google-idx="${idx}">
                    <span class="google-saved-avatar">${_esc((acc.display_name || acc.email || "G").charAt(0).toUpperCase())}</span>
                    <span class="google-saved-meta">
                      <strong>${_esc(acc.display_name || acc.email)}</strong>
                      <small>${_esc(acc.email)}</small>
                    </span>
                  </button>
                `).join("")}
              </div>
            ` : ""}
            <form id="google-quick-form" class="google-quick-form">
              <label>${_t("auth_google_email", "Google / Gmail e-mail cím", "Google / Gmail address")}</label>
              <input id="google-email-in" type="email" required placeholder="pelda@gmail.com" autocomplete="email" />
              <label>${_t("auth_display_name", "Megjelenített név", "Display name")}</label>
              <input id="google-name-in" type="text" placeholder="${_t("auth_name_ph", "pl. Ágnes", "e.g. Agnes")}" autocomplete="name" />
              <label>${_t("auth_invite_label", "Meghívókód (opcionális)", "Invite code (optional)")}</label>
              <input id="google-invite-in" type="text" placeholder="${_t("auth_invite_ph", "Ha kaptál meghívókódot…", "If you have an invite code…")}" autocomplete="off" />
              <button type="submit" class="btn primary" style="width:100%;margin-top:6px;">
                ${_t("auth_google_continue", "Belépés ezzel a Google-fiókkal", "Continue with this Google account")}
              </button>
            </form>
          </div>
        ` : ""}

        <div class="auth-divider">
          <span>${_t("auth_or_email", "vagy e-mail-címmel", "or with email")}</span>
        </div>

        <form id="auth-email-form" class="auth-form">
          ${!isLogin ? `
            <div class="auth-field">
              <label for="auth-name">${_t("auth_display_name", "Megjelenített név", "Display name")}</label>
              <input id="auth-name" type="text" placeholder="${_t("auth_name_ph", "pl. Ágnes", "e.g. Agnes")}" autocomplete="name" />
            </div>
          ` : ""}
          <div class="auth-field">
            <label for="auth-email">${_t("auth_email_label", "E-mail cím", "Email address")}</label>
            <input id="auth-email" type="email" required placeholder="nev@pelda.hu" autocomplete="email" />
          </div>
          <div class="auth-field">
            <label for="auth-password">${_t("auth_password_label", "Jelszó", "Password")}</label>
            <input id="auth-password" type="password" required minlength="6" placeholder="${isLogin ? "••••••••" : _t("auth_pw_min", "Legalább 6 karakter", "At least 6 characters")}" autocomplete="${isLogin ? "current-password" : "new-password"}" />
          </div>
          ${!isLogin ? `
            <div class="auth-field">
              <label for="auth-invite">${_t("auth_invite_label", "Meghívókód (opcionális)", "Invite code (optional)")}</label>
              <input id="auth-invite" type="text" placeholder="${_t("auth_invite_ph", "Azonnali hozzáféréshez", "For instant activation")}" autocomplete="off" />
            </div>
          ` : ""}
          <button type="submit" id="auth-submit-btn" class="btn primary auth-submit">
            ${isLogin ? _t("auth_login_submit", "Bejelentkezés", "Sign in") : _t("auth_register_submit", "Fiók létrehozása", "Create account")}
          </button>
        </form>
      </div>
    `;

    // Bind language switcher on gate
    const langBtn = gate.querySelector("#auth-lang-btn");
    if (langBtn && window.SolinI18n) {
      langBtn.addEventListener("click", () => {
        window.SolinI18n.toggleLang();
        renderAuthGate(errorMsg);
      });
    }

    // Bind mode tabs
    gate.querySelectorAll("[data-auth-tab]").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        authMode = tabBtn.dataset.authTab;
        googlePickerOpen = false;
        renderAuthGate();
      });
    });

    // Bind Google sign-in button
    const googleBtn = gate.querySelector("#auth-google-btn");
    if (googleBtn) {
      googleBtn.addEventListener("click", () => {
        if (authConfig.google_client_id && window.google && window.google.accounts && window.google.accounts.id) {
          try {
            window.google.accounts.id.prompt();
            return;
          } catch (e) {}
        }
        googlePickerOpen = !googlePickerOpen;
        renderAuthGate();
        const emailIn = gate.querySelector("#google-email-in");
        if (emailIn) emailIn.focus();
      });
    }

    const closePickerBtn = gate.querySelector("#google-picker-close");
    if (closePickerBtn) {
      closePickerBtn.addEventListener("click", () => {
        googlePickerOpen = false;
        renderAuthGate();
      });
    }

    // Saved Google accounts 1-click login
    gate.querySelectorAll("[data-google-idx]").forEach((itemBtn) => {
      itemBtn.addEventListener("click", async () => {
        const idx = Number(itemBtn.dataset.googleIdx);
        const acc = savedGoogle[idx];
        if (acc && acc.email) {
          await handleGoogleLogin({ email: acc.email, display_name: acc.display_name, picture: acc.picture });
        }
      });
    });

    // Google quick form submit
    const googleForm = gate.querySelector("#google-quick-form");
    if (googleForm) {
      googleForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = (gate.querySelector("#google-email-in").value || "").trim();
        const displayName = (gate.querySelector("#google-name-in").value || "").trim();
        const inviteEl = gate.querySelector("#google-invite-in");
        const inviteCode = inviteEl ? (inviteEl.value || "").trim() : "";
        if (!email) return;
        await handleGoogleLogin({ email, display_name: displayName, invite_code: inviteCode });
      });
    }

    // Email/Password form submit
    const emailForm = gate.querySelector("#auth-email-form");
    if (emailForm) {
      emailForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = (gate.querySelector("#auth-email").value || "").trim();
        const password = gate.querySelector("#auth-password").value || "";
        const nameEl = gate.querySelector("#auth-name");
        const displayName = nameEl ? (nameEl.value || "").trim() : "";
        const invEl = gate.querySelector("#auth-invite");
        const inviteCode = invEl ? (invEl.value || "").trim() : "";
        await handleEmailAuth({ email, password, display_name: displayName, invite_code: inviteCode });
      });
    }
  }

  async function handleEmailAuth({ email, password, display_name, invite_code }) {
    const endpoint = authMode === "register" ? "/api/v1/auth/register" : "/api/v1/auth/login";
    const lang = (window.SolinI18n && window.SolinI18n.getLang) ? window.SolinI18n.getLang() : "hu";
    const body = authMode === "register"
      ? { email, password, display_name, language: lang, invite_code: invite_code || undefined }
      : { email, password };

    try {
      const res = await fetch(_apiBase() + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data && data.detail && (data.detail.message || data.detail)) || _t("auth_err_generic", "Sikertelen belépés.", "Authentication failed.");
        renderAuthGate(String(msg));
        return;
      }
      setSession(data.access_token, data.user);
      if (data.user && data.user.status === "pending") {
        lockApp();
        return;
      }
      unlockApp();
      if (window.Solin && window.Solin.toast) {
        window.Solin.toast(
          authMode === "register"
            ? _t("auth_welcome_new", "Üdv a Solinban, ", "Welcome to Solin, ") + (data.user.display_name || "") + "! 🎉"
            : _t("auth_welcome_back", "Sikeres bejelentkezés: ", "Signed in as ") + (data.user.display_name || "") + " ✓"
        );
      }
    } catch (err) {
      renderAuthGate(_t("auth_err_network", "Hálózati hiba történt. Próbáld újra.", "Network error. Please try again."));
    }
  }

  async function handleGoogleLogin({ id_token, email, display_name, picture, invite_code }) {
    const lang = (window.SolinI18n && window.SolinI18n.getLang) ? window.SolinI18n.getLang() : "hu";
    try {
      const res = await fetch(_apiBase() + "/api/v1/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id_token, email, display_name, picture, language: lang, invite_code: invite_code || undefined })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data && data.detail && (data.detail.message || data.detail)) || _t("auth_err_google", "Sikertelen Google bejelentkezés.", "Google sign-in failed.");
        renderAuthGate(String(msg));
        return;
      }
      if (data.user && data.user.email) {
        saveGoogleAccount(data.user.email, data.user.display_name, data.user.picture);
      }
      googlePickerOpen = false;
      setSession(data.access_token, data.user);
      if (data.user && data.user.status === "pending") {
        lockApp();
        return;
      }
      unlockApp();
      if (window.Solin && window.Solin.toast) {
        window.Solin.toast(_t("auth_welcome_back", "Sikeres Google belépés: ", "Signed in with Google: ") + (data.user.display_name || "") + " ✓");
      }
    } catch (err) {
      renderAuthGate(_t("auth_err_network", "Hálózati hiba történt. Próbáld újra.", "Network error. Please try again."));
    }
  }

  // ---- Profile View (#view-profile) ----
  function renderProfile() {
    const box = document.getElementById("view-profile");
    if (!box) return;
    const user = getUser();
    if (!user) {
      lockApp();
      return;
    }

    selectedAvatar = user.avatar || "👩‍🍳";
    selectedDiets = new Set(Array.isArray(user.dietary_preferences) ? user.dietary_preferences : []);
    const goals = user.macro_goals || { kcal: 2000, protein_g: 140, carbs_g: 200, fat_g: 65 };
    const providerBadge = user.auth_provider === "google" ? "🌐 Google" : "✉️ E-mail";
    const roleBadge = user.role === "owner" ? "👑 Owner" : "👤 Member";

    box.innerHTML = `
      <button class="back-btn" id="profile-back">${_t("back_to_recipes", "← Vissza a receptekhez", "← Back to recipes")}</button>
      <h2 class="view-title">${_t("profile_heading", "Profilom & Beállítások", "My Profile & Settings")}</h2>

      <div class="card profile-hero-card">
        <div class="profile-hero-top">
          <div class="profile-avatar-large" id="profile-hero-avatar">${_esc(selectedAvatar)}</div>
          <div class="profile-hero-info">
            <h3>${_esc(user.display_name || user.email)}</h3>
            <p class="muted">${_esc(user.email)}</p>
            <div class="profile-badges">
              <span class="pill">${providerBadge}</span>
              <span class="pill">${roleBadge}</span>
            </div>
          </div>
          <button type="button" id="profile-logout-btn" class="btn ghost sm profile-logout">
            🚪 ${_t("auth_logout", "Kijelentkezés", "Sign out")}
          </button>
        </div>
      </div>

      <form id="profile-edit-form" class="card profile-form-card">
        <h3>🎨 ${_t("profile_custom_title", "Személyre szabás", "Profile Customization")}</h3>

        <label class="profile-label">${_t("profile_choose_avatar", "Válassz avatárt", "Choose avatar")}</label>
        <div class="avatar-picker" id="profile-avatar-picker">
          ${AVATAR_OPTIONS.map((av) => `
            <button type="button" class="avatar-opt ${av === selectedAvatar ? "selected" : ""}" data-avatar="${_esc(av)}">${_esc(av)}</button>
          `).join("")}
        </div>

        <div class="profile-grid-2">
          <div>
            <label for="prof-name" class="profile-label">${_t("auth_display_name", "Megjelenített név", "Display name")}</label>
            <input id="prof-name" type="text" value="${_esc(user.display_name || "")}" required />
          </div>
          <div>
            <label for="prof-lang" class="profile-label">${_t("profile_lang", "Alkalmazás nyelve", "Preferred language")}</label>
            <select id="prof-lang">
              <option value="hu" ${user.language !== "en" ? "selected" : ""}>🇭🇺 Magyar (Hungarian)</option>
              <option value="en" ${user.language === "en" ? "selected" : ""}>🇬🇧 English (Angol)</option>
            </select>
          </div>
        </div>

        <label for="prof-bio" class="profile-label">${_t("profile_bio", "Bemutatkozás / Konyhai mottó", "Bio / Kitchen motto")}</label>
        <input id="prof-bio" type="text" value="${_esc(user.bio || "")}" placeholder="${_t("profile_bio_ph", "pl. Gyors, fehérjedús hétköznapi vacsorák rajongója", "e.g. High-protein weekday meals & sourdough")}" />

        <label class="profile-label" style="margin-top:14px;">🥗 ${_t("profile_diet_title", "Étrendi preferenciák", "Dietary preferences")}</label>
        <div class="diet-chips" id="profile-diet-chips">
          ${DIET_OPTIONS.map((d) => {
            const lang = (window.SolinI18n && window.SolinI18n.getLang) ? window.SolinI18n.getLang() : "hu";
            const active = selectedDiets.has(d.id);
            return `<button type="button" class="diet-chip ${active ? "active" : ""}" data-diet="${d.id}">${lang === "en" ? d.en : d.hu}</button>`;
          }).join("")}
        </div>

        <label class="profile-label" style="margin-top:16px;">🎯 ${_t("profile_macros_title", "Napi makró célok (1 főre)", "Daily Macro Goals")}</label>
        <div class="profile-macros-grid">
          <div class="macro-goal-box">
            <span>🔥 Kalória (kcal)</span>
            <input id="prof-kcal" type="number" min="500" max="10000" value="${Number(goals.kcal || 2000)}" />
          </div>
          <div class="macro-goal-box">
            <span>💪 ${_t("protein", "Fehérje", "Protein")} (g)</span>
            <input id="prof-protein" type="number" min="0" max="1000" value="${Number(goals.protein_g || 140)}" />
          </div>
          <div class="macro-goal-box">
            <span>🌾 ${_t("carbs", "Szénhidrát", "Carbs")} (g)</span>
            <input id="prof-carbs" type="number" min="0" max="1500" value="${Number(goals.carbs_g || 200)}" />
          </div>
          <div class="macro-goal-box">
            <span>🥑 ${_t("fat", "Zsír", "Fat")} (g)</span>
            <input id="prof-fat" type="number" min="0" max="500" value="${Number(goals.fat_g || 65)}" />
          </div>
        </div>

        <div style="margin-top:18px; display:flex; justify-content:flex-end;">
          <button type="submit" class="btn primary">${_t("profile_save_btn", "Profil mentése", "Save profile")}</button>
        </div>
      </form>

      <form id="profile-pw-form" class="card profile-form-card">
        <h3>🔐 ${_t("profile_pw_title", "Jelszó módosítása", "Change Password")}</h3>
        <div class="profile-grid-2">
          <div>
            <label for="prof-cur-pw" class="profile-label">${_t("profile_cur_pw", "Jelenlegi jelszó (ha van)", "Current password (if set)")}</label>
            <input id="prof-cur-pw" type="password" placeholder="••••••••" autocomplete="current-password" />
          </div>
          <div>
            <label for="prof-new-pw" class="profile-label">${_t("profile_new_pw", "Új jelszó (min. 6 karakter)", "New password (min. 6 chars)")}</label>
            <input id="prof-new-pw" type="password" required minlength="6" placeholder="••••••••" autocomplete="new-password" />
          </div>
        </div>
        <div style="margin-top:14px; display:flex; justify-content:flex-end;">
          <button type="submit" class="btn ghost">${_t("profile_pw_btn", "Jelszó frissítése", "Update password")}</button>
        </div>
      </form>

      ${user.role === "owner" ? `<div id="profile-admin-panel" class="card profile-form-card"></div>` : ""}
    `;

    // Back button
    const backBtn = box.querySelector("#profile-back");
    if (backBtn && window.Solin) {
      backBtn.addEventListener("click", () => window.Solin.go("browse"));
    }

    // Logout button
    const logoutBtn = box.querySelector("#profile-logout-btn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        try {
          await fetch(_apiBase() + "/api/v1/auth/logout", { method: "POST" });
        } catch (e) {}
        clearSession();
        lockApp();
        if (window.Solin && window.Solin.toast) {
          window.Solin.toast(_t("auth_logged_out", "Kijelentkeztél.", "Signed out."));
        }
      });
    }

    // Avatar selection
    box.querySelectorAll("[data-avatar]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedAvatar = btn.dataset.avatar;
        box.querySelectorAll("[data-avatar]").forEach((b) => b.classList.toggle("selected", b === btn));
        const heroAv = box.querySelector("#profile-hero-avatar");
        if (heroAv) heroAv.textContent = selectedAvatar;
      });
    });

    // Dietary chip toggles
    box.querySelectorAll("[data-diet]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const d = btn.dataset.diet;
        if (selectedDiets.has(d)) selectedDiets.delete(d);
        else selectedDiets.add(d);
        btn.classList.toggle("active", selectedDiets.has(d));
      });
    });

    // Profile Save form
    const editForm = box.querySelector("#profile-edit-form");
    if (editForm) {
      editForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const payload = {
          display_name: (box.querySelector("#prof-name").value || "").trim(),
          bio: (box.querySelector("#prof-bio").value || "").trim(),
          avatar: selectedAvatar,
          language: box.querySelector("#prof-lang").value || "hu",
          dietary_preferences: Array.from(selectedDiets),
          macro_goals: {
            kcal: Number(box.querySelector("#prof-kcal").value || 2000),
            protein_g: Number(box.querySelector("#prof-protein").value || 140),
            carbs_g: Number(box.querySelector("#prof-carbs").value || 200),
            fat_g: Number(box.querySelector("#prof-fat").value || 65)
          }
        };

        try {
          const res = await fetch(_apiBase() + "/api/v1/auth/me", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const updated = await res.json().catch(() => null);
          if (!res.ok || !updated) {
            if (window.Solin && window.Solin.toast) {
              window.Solin.toast(_t("profile_save_err", "Hiba a profil mentésekor.", "Failed to save profile."));
            }
            return;
          }
          setSession(getToken(), updated);
          renderProfile();
          if (window.Solin && window.Solin.toast) {
            window.Solin.toast(_t("profile_saved", "Profil mentve ✓", "Profile saved ✓"));
          }
        } catch (err) {
          if (window.Solin && window.Solin.toast) {
            window.Solin.toast(_t("auth_err_network", "Hálózati hiba.", "Network error."));
          }
        }
      });
    }

    // Password change form
    const pwForm = box.querySelector("#profile-pw-form");
    if (pwForm) {
      pwForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const current_password = box.querySelector("#prof-cur-pw").value || "";
        const new_password = box.querySelector("#prof-new-pw").value || "";
        try {
          const res = await fetch(_apiBase() + "/api/v1/auth/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ current_password, new_password })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const msg = (data && data.detail && (data.detail.message || data.detail)) || _t("profile_pw_err", "Nem sikerült a jelszó módosítása.", "Password change failed.");
            if (window.Solin && window.Solin.toast) window.Solin.toast(String(msg));
            return;
          }
          box.querySelector("#prof-cur-pw").value = "";
          box.querySelector("#prof-new-pw").value = "";
          if (window.Solin && window.Solin.toast) {
            window.Solin.toast(_t("profile_pw_saved", "Jelszó sikeresen frissítve ✓", "Password updated ✓"));
          }
        } catch (err) {
          if (window.Solin && window.Solin.toast) {
            window.Solin.toast(_t("auth_err_network", "Hálózati hiba.", "Network error."));
          }
        }
      });
    }

    if (user.role === "owner") {
      loadOwnerAdminPanel(box.querySelector("#profile-admin-panel"), user);
    }
  }

  async function loadOwnerAdminPanel(panel, ownerUser) {
    if (!panel) return;
    try {
      const res = await fetch(_apiBase() + "/api/v1/auth/admin/users");
      if (!res.ok) return;
      const data = await res.json();
      const users = Array.isArray(data.users) ? data.users : [];
      const cfg = data.settings || {};

      panel.innerHTML = `
        <h3>👑 ${_t("admin_title", "Tulajdonosi Biztonság & Felhasználók", "Owner Security & User Access")}</h3>
        <p class="hint" style="margin-top:0;">${_t("admin_hint", "Itt szabályozhatod, hogy új regisztrálók azonnal hozzáférnek-e a receptekhez, vagy meghívókód / tulajdonosi jóváhagyás szükséges.", "Control whether new sign-ups require your approval or an invite code before accessing recipes.")}</p>

        <form id="admin-settings-form" style="margin-bottom:18px; padding:12px; border:1px solid var(--line); border-radius:12px; background:var(--bg);">
          <label style="display:flex; align-items:center; gap:8px; font-weight:600; font-size:13.5px; cursor:pointer; margin-bottom:10px;">
            <input type="checkbox" id="admin-req-approval" ${cfg.require_approval ? "checked" : ""} />
            <span>🔒 ${_t("admin_req_approval_label", "Új regisztrációkhoz tulajdonosi jóváhagyás szükséges (ajánlott nyilvános weben)", "Require Owner approval for new accounts (recommended on public web)")}</span>
          </label>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <label for="admin-invite-code" style="font-size:12.5px; font-weight:700;">🎟️ ${_t("admin_invite_code", "Meghívókód (azonnali belépéshez):", "Invite code (for instant access):")}</label>
            <input id="admin-invite-code" type="text" value="${_esc(cfg.invite_code || "")}" placeholder="${_t("admin_invite_ph", "pl. CSALAD2026 (üres = nincs kód)", "e.g. FAMILY2026")}" style="flex:1; min-width:160px; padding:6px 10px;" />
            <button type="submit" class="btn sm primary">${_t("save", "Mentés", "Save")}</button>
          </div>
        </form>

        <h4 style="margin:0 0 10px; font-size:14px;">👥 ${_t("admin_users_list", "Regisztrált fiókok", "Registered accounts")} (${users.length})</h4>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${users.map((u) => {
            const st = u.status || "active";
            const stBadge = st === "active"
              ? `<span class="pill" style="background:rgba(16,185,129,0.15);color:#065f46;">✅ Aktív</span>`
              : st === "pending"
              ? `<span class="pill" style="background:rgba(245,158,11,0.2);color:#92400e;">⏳ Jóváhagyásra vár</span>`
              : `<span class="pill" style="background:rgba(239,68,68,0.15);color:#991b1b;">🚫 Tiltva</span>`;
            const isSelf = u.id === ownerUser.id;
            return `
              <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; padding:10px 12px; border:1px solid var(--line); border-radius:10px;">
                <div>
                  <strong>${_esc(u.avatar || "👩‍🍳")} ${_esc(u.display_name || u.name || u.email)}</strong>
                  <span class="muted" style="font-size:12px; margin-left:6px;">(${_esc(u.email)})</span>
                  <div style="margin-top:4px; display:flex; gap:6px; align-items:center;">
                    ${stBadge}
                    <span class="pill" style="font-size:11px;">${u.role === "owner" ? "👑 Owner" : "👤 Member"}</span>
                  </div>
                </div>
                ${!isSelf ? `
                  <div style="display:flex; gap:6px;">
                    ${st !== "active" ? `<button type="button" class="btn sm primary" data-user-act="approve" data-uid="${_esc(u.id)}">✓ ${_t("admin_approve", "Jóváhagyás", "Approve")}</button>` : ""}
                    ${st !== "blocked" ? `<button type="button" class="btn sm ghost" data-user-act="block" data-uid="${_esc(u.id)}">🚫 ${_t("admin_block", "Tiltás", "Block")}</button>` : ""}
                    <button type="button" class="btn sm ghost" data-user-act="delete" data-uid="${_esc(u.id)}" style="color:#dc2626;">🗑️</button>
                  </div>
                ` : ""}
              </div>
            `;
          }).join("")}
        </div>
      `;

      const cfgForm = panel.querySelector("#admin-settings-form");
      if (cfgForm) {
        cfgForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const require_approval = panel.querySelector("#admin-req-approval").checked;
          const invite_code = (panel.querySelector("#admin-invite-code").value || "").trim();
          const r = await fetch(_apiBase() + "/api/v1/auth/admin/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ require_approval, invite_code })
          });
          if (r.ok && window.Solin && window.Solin.toast) {
            window.Solin.toast(_t("admin_cfg_saved", "Biztonsági beállítások mentve ✓", "Security settings saved ✓"));
          }
        });
      }

      panel.querySelectorAll("[data-user-act]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const act = btn.dataset.userAct;
          const uid = btn.dataset.uid;
          if (act === "delete") {
            await fetch(_apiBase() + "/api/v1/auth/admin/users/" + encodeURIComponent(uid), { method: "DELETE" });
          } else {
            const newStatus = act === "approve" ? "active" : "blocked";
            await fetch(_apiBase() + "/api/v1/auth/admin/users/" + encodeURIComponent(uid), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: newStatus })
            });
          }
          loadOwnerAdminPanel(panel, ownerUser);
        });
      });
    } catch (e) {}
  }

  async function init() {
    const profBtn = document.getElementById("profile-btn");
    if (profBtn) {
      profBtn.addEventListener("click", () => {
        if (window.Solin && window.Solin.go) window.Solin.go("profile");
      });
    }

    // Immediate UI lock if no token is stored locally
    if (!isAuthenticated()) {
      lockApp();
    } else {
      updateHeaderProfile();
    }

    // Fetch server auth config & validate existing token asynchronously
    try {
      const cfgRes = await fetch(_apiBase() + "/api/v1/auth/config");
      if (cfgRes.ok) {
        authConfig = await cfgRes.json();
      }
    } catch (e) {}

    if (getToken()) {
      try {
        const meRes = await fetch(_apiBase() + "/api/v1/auth/me");
        if (meRes.ok) {
          const freshUser = await meRes.json();
          setSession(getToken(), freshUser);
          unlockApp();
        } else if (meRes.status === 401) {
          clearSession();
          lockApp();
        }
      } catch (e) {
        // Offline / local fallback: keep cached user unlocked
      }
    }
  }

  return {
    init,
    isAuthenticated,
    getToken,
    getUser,
    setSession,
    clearSession,
    lockApp,
    unlockApp,
    renderAuthGate,
    renderProfile,
    updateHeaderProfile
  };
})();
