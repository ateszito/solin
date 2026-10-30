/* ============================================================
   Solin — add.js (t_6588e1d6) — add-recipe ingestion UI
   Flow: paste TikTok/IG URL → one submit → ingest progress →
   prefilled editable preview → save / cancel. Or start a blank
   recipe directly in the editor.

   Notes:
   - URL fetching is gated behind SolinIngest.flagOn("urlFetch") &&
     flagOn("streaming") (both default OFF, see app/ingest.js).
   - One submit per flow; refused submits are never queued and a
     failed parse is never retried automatically — the user chooses
     manual entry or attaching a file.
   - Never touches pairing / inventory / food-counter modules.
   - Errors are read from the top-level {code, message, details}.
   - Draft objects seed the edit.js rows (ing-name / ing-qty /
     ing-note, steps {t, text}) directly.
   ============================================================ */
(function () {
  "use strict";
  var Solin = window.Solin, S = window.SolinStore, Ingest = window.SolinIngest;
  if (!Solin || !S || !Ingest) { return; }
  var esc = Solin.esc, state = Solin.state, go = Solin.go, toast = Solin.toast;
  var openRecipe = Solin.openRecipe, openEdit = Solin.openEdit;

  /* ================= chain gates (NO DOM, Node-safe) ================= */
  function chainOpen() {
    /* Both flags default OFF; only an explicit true opens the chain. */
    return Ingest.flagOn("urlFetch") === true && Ingest.flagOn("streaming") === true;
  }
  function apiSet() { return Ingest.apiBase() !== ""; }

  function flow() { return { session: null, error: null }; } /* ONE flow slot */

  function chainState(f) { return f && f.session ? f.session.state : "IDLE"; }
  function chainDraft(f) {
    if (!f || !f.session) { return null; }
    if (f.session.state === "DRAFT") {
      try {
        var body = f.session.draft || f.session.body || {};
        var rj = (body.recipe_draft && (body.recipe_draft.recipe_json || body.recipe_draft)) || body.recipe_json || body.draft || body;
        if (typeof rj === "string") { rj = JSON.parse(rj); }
        if (rj && (rj.ingredients || rj.steps || rj.description)) { return rj; }
        return null;                         /* unknown shape → no crash */
      } catch (e) { return null; }
    }
    return null;
  }

  /* ---- submit gate: ONE submit per flow; refused ones never queue ----
     Empty / unsupported input is rejected in the UI; with the chain
     off the flow goes straight to the error branch (manual / attach). */
  function submit(f, input, k) {
    k = k || {};
    if (!f) { return { kind: "idle" }; }
    if (f.session) { return { kind: "refused", message: "one submit per flow (no slot-wait)" }; }
    var s = String(input == null ? "" : input).trim();
    if (!s) { return { kind: "reject", message: "empty submit → toast (tracker guard kept)" }; }
    var c = Ingest.classifySource(s);
    if (c.kind === "unknown" || c.kind === "invalid") {
      return { kind: "reject", message: "no-auto-parse rule → error branch (B/manual)" };
    }
    if (!chainOpen()) {
      return { kind: "error", message: "URL auto-fetch default-OFF (SOLIN_URL_FETCH off) → error branch (B/manual)" };
    }
    if (!apiSet()) {
      return { kind: "error", message: "API base not configured (host-config default OFF) → error branch (B/manual)" };
    }
    /* ONE submit (url): POST chain → 202 → poller; UI never blocks */
    f.session = { id: "", state: "PENDING", error: null, draft: null, trust: null, poll: null, req: null };
    var body = Ingest.submitBody({ kind: "url", platform: c.platform, url: s });
    var fetchFn = k.fetch || (typeof fetch === "function" ? function (m, u, b) { return fetch(u, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); } : null);
    if (!fetchFn) { f.session.state = "IDLE"; f.error = { code: "INTERNAL", message: "chain unreachable (default-OFF flags stay blocked)" }; return { kind: "error", message: "no fetch" }; }
    f.session.req = { cancel: function () {} };
    Promise.resolve(fetchFn("POST", Ingest.apiBase() + Ingest.CHAIN_PATH, body))
      .then(function (r) {
        if (!f.session) { return; }
        var ok = r && (r.status === 202 || r.status === 200);
        if (ok) {
          f.session.state = "PENDING"; f.session.polling = true;
          var timer = k.timer || { setTimeout: setTimeout, clearTimeout: clearTimeout };
          f.session.poll = Ingest.createPoller({
            fetch: function (u) {
              return Promise.resolve(fetchFn("GET", u)).then(function (x) {
                if (x && typeof x.json === "function") { return x.json().then(function (b) { return { status: x.status, body: b }; }, function () { return { status: x.status, body: {} }; }); }
                return x;
              });
            },
            timer: timer,
            notify: k.notify || { backoffToast: function (m) { toast(m, 2600); }, statusBlock: function (b) { if (f.session) { f.session.block = b; } } },
            onDone: function (cls) { if (f.session) { if (cls.mode === "draft") { f.session.state = "DRAFT"; f.session.draft = cls.draft; f.session.trust = cls.trust; } else { f.session.state = "ERROR"; f.session.error = cls; } } },
            onGiveUp: function () { if (f.session) { f.session.state = "GIVEUP"; f.session.error = { code: "GIVEUP", message: "giveup ~60s → error branch (B/manual)" }; } },
            url: k.pollUrl || Ingest.pollUrl({ ingest_id: "seed" }), /* chain-compliant default; UI never calls transcript */
          });
          if (f.session.poll) { f.session.poll.start(); }
          return { kind: "go" };
        }
        /* chain-error shapes (403/429/404/410/400…) → error branch → B/manual */
        f.session.state = "ERROR";
        f.session.error = (r && r.body && r.body.code) ? r.body : { code: "INTERNAL", message: "chain error → error branch (B/manual)" };
        return { kind: "go" };
      });
    return { kind: "go", submitted: true };
  }

  /* Cancel the flow: stop polling and clear the slot (no auto-retry). */
  function cancel(f) {
    if (f && f.session && f.session.poll && f.session.poll.stop) { f.session.poll.stop(); }
    if (f) { f.session = null; f.error = null; }
    return f;
  }

  /* ---- draft → editor rows DIRECT (no textarea roundtrip) ---- */
  function toEditor(draft) {
    var d = draft || {};
    var ing = (d.ingredients || []).map(function (row) {
      var o = (typeof row === "string") ? { name: row } : (row || {});
      var r = { name: String(o.name != null ? o.name : (o.product != null ? o.product : (o.ingredient != null ? o.ingredient : ""))).trim() };
      var q = (o.qty != null) ? o.qty : (o.quantity != null ? o.quantity : (o.amount != null ? o.amount : ""));
      r.qty = String(q == null ? "" : q).trim();
      var u = (o.unit != null) ? String(o.unit).trim() : "";
      r.note = (function () {
        var n = o.note != null ? String(o.note).trim() : "";
        return n !== "" ? n : u;   /* unit lands in the separate note column */
      })();
      if (!r.name && !r.qty && !r.note) { return null; }
      return r;
    }).filter(Boolean);
    var steps = (Array.isArray(d.steps) ? d.steps
      : (typeof d.steps === "string" && d.steps.trim() ? [{ text: d.steps.trim() }] : []))
      .map(function (row) {
      var o = (typeof row === "string") ? { text: row } : (row || {});
      var t = (o.t != null) ? Number(o.t) : 0;
      var text = String(o.instruction != null ? o.instruction : (o.text != null ? o.text : "")).trim();
      if (!text) { return null; }
      return { t: (isFinite(t) && t > 0) ? t : (o.t != null ? 0 : null), text: text };
    }).filter(Boolean);
    return { ing: ing, steps: steps };
  }

  /* local doc (seed-SOLIN_DATA camel shape — browse/detail read it) */
  function toLocalDoc(draft, src) {
    if (!draft) { return null; }
    var e = toEditor(draft);
    var d = draft;
    return {
      id: "u-" + Math.random().toString(36).slice(2, 8),
      title: String(d.title || "Új recept"),
      title_hu: String(d.title || ""),
      description: String(d.description || ""),
      creator: String(d.creator || "unknown"),
      source: src || "", video: "",
      rating: 0, cuisine: String(d.cuisine || "unknown"),
      difficulty: "easy",
      tags: (d.tags || []).slice(), dietary: (d.dietary || d.dietary_info || []).slice(),
      servings: Number(d.servings) > 0 ? Number(d.servings) : 1,
      totalMin: Number(d.total_time) > 0 ? Number(d.total_time) : null,
      macrosPerServing: (d.nutrition && typeof d.nutrition === "object") ? null : null,
      ingredients: e.ing, steps: e.steps,
    };
  }

  /* ================= view layer (DOM) =================
     mount() repaints #view-add from the ONE flow slot F.
     Branches reachable from state alone:
       IDLE -> PENDING (poll, never blocks, ~60s giveup)
             -> DRAFT | ERROR | GIVEUP.
     Default-OFF flags NEVER queue a fetch; the error branch
     routes to attach (B) / manual (C), never auto-parse.
     Save is local-first (v1): the doc lands in the custom-recipe
     store key and opens in the detail view. No textarea
     roundtrip — draft objects seed the editor rows DIRECT. */
  var F = flow();            /* ONE flow slot, module singleton */
  var uiTimer = null;

  function fstate() { return F.session ? F.session.state : "IDLE"; }

  function stopUiTimer() {
    if (uiTimer) { clearInterval(uiTimer); uiTimer = null; }
  }
  function keepAlive() {     /* repaint while a poll session lives */
    if (uiTimer) { return; }
    uiTimer = setInterval(mount, 900);
  }

  function memSave(doc) {    /* local-first persist (offline-first stack) */
    var KEY = "solin.custom.recipes.v1";
    var list = S.load(KEY, []);
    list.unshift(doc);
    S.save(KEY, list);
  }

  function startBlank(srcUrl) {   /* route C — manual create */
    var doc = toLocalDoc({ title: "", description: "",
                           ingredients: [], steps: [] }, srcUrl || "");
    /* draft until the first save — discarded if the user backs out */
    doc.title = ""; doc.title_hu = ""; doc.creator = ""; doc.cuisine = "";
    doc._blank = true;
    memSave(doc);
    stopUiTimer(); cancel(F);
    openEdit(doc.id);             /* straight into the editor */
  }

  function startFromExtracted(data) {
    var doc = toLocalDoc(data, "");
    doc.title = data.title || "";
    doc.description = data.description || "";
    doc.servings = data.servings || 1;
    doc.totalMin = data.total_time_min || data.totalMin || null;
    doc.cuisine = data.cuisine || "";
    doc.macrosPerServing = data.macrosPerServing || {};
    doc.ingredients = (data.ingredients || []).map(function (i) {
      return {
        name: i.name || "",
        qty: i.qty || (i.amount ? (i.amount + " " + (i.unit || "")) : ""),
        note: i.note || ""
      };
    });
    doc.steps = (data.steps || []).map(function (s) {
      return { t: s.t != null ? s.t : 0, text: s.instruction || s.text || "" };
    });
    doc.image = data.image || (data.images && data.images[0] ? (data.images[0].url || data.images[0].data_url || data.images[0]) : null);
    doc.images = (data.images || []).map(function (im) {
      return typeof im === "string" ? im : (im.data_url || im.url);
    });
    doc._blank = true;
    memSave(doc);
    stopUiTimer();
    cancel(F);
    openEdit(doc.id);
  }

  function chainSeed() { return (F.session && F.session.seed) || ""; }

  /* ---- branch renderers (HTML strings; esc() everything user-made) ---- */
  function idleHTML() {
    var open = chainOpen() && apiSet();
    var hint = open
      ? "Illeszd be a videó linkjét — a háttérben kinyerjük a receptet (kb. 1 perc), közben nyugodtan használhatod az appot."
      : "Az automatikus link-feldolgozás még nem érhető el. Indíts egy üres receptet, és töltsd ki a hozzávalókat és lépéseket kézzel.";
    return '<div class="card add-card">'
      + '<div class="add-option" style="border: 2px dashed var(--primary); padding: 14px; border-radius: var(--radius); background: var(--card-bg); margin-bottom: 16px;">'
      + '<div style="display:flex;align-items:center;gap:8px;">'
      + '<span style="font-size:22px;">📷</span>'
      + '<h3 style="margin:0;">Recept fotó(k)ból (Vision AI)</h3>'
      + '</div>'
      + '<p class="hint" style="margin:8px 0 12px;">Fotózd le a szakácskönyv oldalát vagy tölts fel egy vagy több képet! A helyi mesterséges intelligencia felismeri az összes adatot, és megnyitja a szerkesztőben ellenőrzésre.</p>'
      + '<input type="file" id="add-photo-file" accept="image/*" multiple style="display:none;" />'
      + '<button type="button" class="btn primary" id="add-photo-btn">📷 Fotó(k) kiválasztása vagy készítése</button>'
      + '<div id="add-photo-status"></div>'
      + '</div>'
      + '<div class="add-option">'
      + '<h3>Kézi felvitel</h3>'
      + '<p class="hint">Cím, hozzávalók, lépések — a szerkesztőben bármikor módosíthatod.</p>'
      + '<button type="button" class="btn" id="add-blank">Üres recept indítása</button>'
      + '</div>'
      + '<div class="add-divider"><span>vagy</span></div>'
      + '<div class="add-option' + (open ? "" : " is-disabled") + '">'
      + '<h3>Importálás TikTok / Instagram linkről' + (open ? "" : ' <span class="pill">hamarosan</span>') + '</h3>'
      + '<div class="field"><label for="add-url" class="sr-only">Videó linkje</label>'
      + '<input id="add-url" type="url" inputmode="url" autocomplete="off" spellcheck="false"'
      + ' placeholder="https://www.tiktok.com/@felhasznalo/video/…"' + (open ? "" : " disabled") + ' /></div>'
      + '<button type="button" class="btn" id="add-submit"'
      + (open ? "" : " disabled") + ">Recept importálása</button>"
      + '<p class="hint" style="margin-top:8px">' + esc(hint) + "</p>"
      + '</div></div>';
  }

  function pollHTML(f) {
    return '<div class="card"><p class="add-progress"><span class="spinner" aria-hidden="true"></span> '
      + "Recept feldolgozása…</p>"
      + '<p class="hint">Ez kb. 1 percig tarthat. Nyugodtan böngészhetsz közben.</p>'
      + '<button type="button" class="btn sm ghost" id="add-cancel">Mégse</button></div>';
  }

  function errorHTML(f) {
    var e = (f.session && f.session.error) || {};
    var friendly = ({
      FEATURE_DISABLED: "Az automatikus import most nem érhető el.",
      GIVEUP: "A feldolgozás túl sokáig tartott.",
      TOO_MANY_REQUESTS: "Túl sok kérés — próbáld újra pár perc múlva."
    })[e.code] || "Nem sikerült feldolgozni a linket.";
    return '<div class="card"><p><b>' + esc(friendly) + "</b></p>"
      + '<p class="hint">Folytathatod kézzel: indíts egy üres receptet, a linket elmentjük forrásként.</p>'
      + '<div class="grid2">'
      + '<button type="button" class="btn primary" id="add-blank">'
      + "Folytatás kézzel</button>"
      + '<button type="button" class="btn ghost" id="add-reset">'
      + "Másik link</button></div>"
      + (e.code ? '<p class="hint" style="margin-top:8px;font-size:11px">Hibakód: ' + esc(e.code) + "</p>" : "")
      + "</div>";
  }

  /* prefilled editable preview — draft objects seed the rows DIRECT
     (no textarea roundtrip). Keys mirror the live edit.js input
     surface (ing-name/ing-qty/ing-note + t/text). */
  function draftHTML(f) {
    var draft = chainDraft(f) || {};
    var e = toEditor(draft);
    var trust = (f.session && f.session.trust) || "";
    var ing = e.ing.map(function (o) {
      return '<li>'
        + '<input name="ing-name" placeholder="név" value="' + esc(o.name) + '"/>'
        + '<input name="ing-qty" placeholder="mennyiség" value="' + esc(o.qty) + '"/>'
        + '<input name="ing-note" placeholder="megjegyzés" value="' + esc(o.note) + '"/>'
        + '<button type="button" class="rm" aria-label="remove">×</button></li>';
    }).join("");
    var steps = e.steps.map(function (o) {
      var t = (o.t == null ? "" : o.t);
      return '<li>'
        + '<input name="st-t" placeholder="mp" value="' + esc(t) + '" style="max-width:90px"/>'
        + '<input name="st-text" placeholder="lépés leírása" value="' + esc(o.text) + '" style="flex:2 1 200px"/>'
        + '<button type="button" class="rm" aria-label="remove">×</button></li>';
    }).join("");
    var trustHint = trust === "LOW_CONFIDENCE"
      ? "Figyelem: a felismerés bizonytalan — ellenőrizd a mezőket!"
      : "";
    return '<p class="hint">A kinyert adatok — mentés előtt javíthatod őket.'
      + (trustHint ? " " + esc(trustHint) : "") + "</p>"
      + '<div class="field"><label for="add-title">Cím</label>'
      + '<input id="add-title" value="' + esc(draft.title || "") + '"/></div>'
      + '<div class="field"><label for="add-desc">Leírás</label>'
      + '<textarea id="add-desc" rows="3">' + esc(draft.description || "") + "</textarea></div>"
      + '<div class="grid2">'
      + '<div class="field"><label for="add-servings">Adag</label><input id="add-servings" type="number" inputmode="numeric" min="1" max="999" value="'
      + esc(Number(draft.servings) > 0 ? Number(draft.servings) : 4) + '"/></div>'
      + '<div class="field"><label for="add-min">Idő (perc)</label><input id="add-min" type="number" inputmode="numeric" min="1" value="'
      + esc(Number(draft.total_time) > 0 ? Number(draft.total_time) : "") + '"/></div></div>'
      + '<div class="field"><label>Hozzávalók (1 sor = 1 hozzávaló)</label>'
      + '<ul class="dyn-list" id="add-ing">' + ing + '</ul>'
      + '<button type="button" class="btn sm add-row" id="add-ing-add">+ Hozzávaló</button></div>'
      + '<div class="field"><label>Lépések (videó mp → leírás)</label>'
      + '<ul class="dyn-list" id="add-steps">' + steps + '</ul>'
      + '<button type="button" class="btn sm add-row" id="add-step-add">+ Lépés</button></div>'
      + '<div class="grid2">'
      + '<button type="button" class="btn primary" id="add-save">Recept mentése</button>'
      + '<button type="button" class="btn ghost" id="add-cancel">Mégse</button></div>';
  }

  /* ---- read-back: editable preview -> local doc (edits override draft) ---- */
  function readDoc(f) {
    var host = (typeof document !== "undefined") && document.querySelector
      ? document.querySelector("#add-inner") : null;
    if (!host) { return null; }
    var rows = function (sel, pick) {
      return Array.from(host.querySelectorAll(sel + " li")).map(pick)
        .filter(function (o) {
          return Object.keys(o).some(function (k) {
            return String(o[k] == null ? "" : o[k]).trim() !== "";
          });
        });
    };
    var ing = rows("#add-ing", function (li) {
      var g = function (n) {
        var x = li.querySelector('[name="' + n + '"]');
        return x ? String(x.value).trim() : "";
      };
      return { name: g("ing-name"), qty: g("ing-qty"), note: g("ing-note") };
    });
    var steps = rows("#add-steps", function (li) {
      var t = li.querySelector('[name="st-t"]');
      var x = li.querySelector('[name="st-text"]');
      var sec = t ? parseFloat(t.value) : NaN;
      return { t: isFinite(sec) && sec > 0 ? sec : (t && String(t.value).trim() !== "" ? sec : null),
               text: x ? String(x.value).trim() : "" };
    }).filter(function (o) { return o.text !== ""; });
    var get = function (id) {
      var x = document.querySelector("#" + id);
      return x ? String(x.value).trim() : "";
    };
    var doc = toLocalDoc(chainDraft(f) || {}, chainSeed());
    var t = get("add-title"); if (t) { doc.title = t; }
    doc.description = get("add-desc");
    var serv = parseFloat(get("add-servings"));
    if (isFinite(serv) && serv > 0) { doc.servings = serv; }
    var mins = parseFloat(get("add-min"));
    if (isFinite(mins) && mins > 0) { doc.totalMin = mins; }
    doc.ingredients = ing;
    doc.steps = steps;
    return doc;
  }

  /* ---- mount: repaint #view-add + wire its controls ---- */
  function addRow(host, listId, liHTML) {
    var list = host.querySelector("#" + listId);
    if (!list) { return; }
    var li = document.createElement("li");
    li.innerHTML = liHTML;
    list.appendChild(li);
    var rm = li.querySelector(".rm");
    if (rm) { rm.addEventListener("click", function () { li.remove(); }); }
  }

  function mount() {
    if (typeof document === "undefined" || !document.querySelector) { return; }
    var host = document.querySelector("#add-inner");
    if (!host) { return; }
    var st = fstate();
    if (st === "PENDING") { keepAlive(); } else { stopUiTimer(); }
    host.innerHTML = st === "PENDING" ? pollHTML(F)
      : st === "DRAFT" ? draftHTML(F)
      : (st === "ERROR" || st === "GIVEUP") ? errorHTML(F)
      : idleHTML();
    var on = function (id, fn) {
      var el = document.querySelector("#" + id);
      if (el) { el.onclick = fn; }
    };
    on("add-back", function () { cancel(F); if (Solin.back) Solin.back("browse"); else go("browse"); });

    var photoBtn = document.querySelector("#add-photo-btn");
    var photoInput = document.querySelector("#add-photo-file");
    var photoStatus = document.querySelector("#add-photo-status");
    if (photoBtn && photoInput) {
      photoBtn.onclick = function () { photoInput.click(); };
      photoInput.onchange = async function (e) {
        var files = Array.from(e.target.files || []);
        if (!files.length) return;
        photoBtn.disabled = true;
        if (photoStatus) {
          photoStatus.innerHTML = '<p class="add-progress" style="margin-top:10px;"><span class="spinner" aria-hidden="true"></span> '
            + 'Fotó(k) elemzése helyi Vision AI-val… (kb. 30–60 mp)</p>';
        }
        try {
          var imagesBase64 = [];
          for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (window.SolinImg && SolinImg.compress) {
              var comp = await SolinImg.compress(f, { maxWidth: 1200, maxHeight: 1200, quality: 0.8 });
              if (comp && comp.dataUrl) imagesBase64.push(comp.dataUrl);
            } else {
              var reader = new FileReader();
              var durl = await new Promise(function (res, rej) {
                reader.onload = function () { res(reader.result); };
                reader.onerror = rej;
                reader.readAsDataURL(f);
              });
              imagesBase64.push(durl);
            }
          }

          var apiBase = (window.SolinCfg && SolinCfg.apiBase && SolinCfg.apiBase()) || "";
          var endpoint = "/api/v1/recipes/extract-image";
          if (apiBase && (typeof window !== "undefined" && window.location && window.location.origin && !apiBase.startsWith(window.location.origin))) {
            endpoint = apiBase.replace(/\/+$/, "") + "/api/v1/recipes/extract-image";
          }

          var resp = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ images: imagesBase64, target_lang: "auto" })
          });

          if (!resp.ok) {
            var errData = {};
            try { errData = await resp.json(); } catch (e) {}
            throw new Error(errData.detail || ("Hiba a szervertől: HTTP " + resp.status));
          }

          var extracted = await resp.json();
          toast("Recept sikeresen felismerve! ✓");
          startFromExtracted(extracted);
        } catch (err) {
          console.error("Recipe photo extraction error:", err);
          photoBtn.disabled = false;
          var msg = (err && err.message) || String(err);
          if (msg.includes("Load failed") || msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
            msg = "A kérés időtúllépés vagy hálózati megszakadás miatt nem sikerült. Kérlek próbáld újra!";
          }
          if (photoStatus) {
            photoStatus.innerHTML = '<p class="hint" style="color:#ef4444;margin-top:8px;"><b>Hiba történt:</b> ' + esc(msg) + '<br/><button type="button" class="btn sm" id="add-photo-retry" style="margin-top:6px;">Újrapróbálás</button></p>';
            var retry = document.querySelector("#add-photo-retry");
            if (retry) retry.onclick = function () { photoInput.click(); };
          }
        }
      };
    }
    on("add-submit", function () {
      var el = document.querySelector("#add-url");
      var v = el ? el.value : "";
      F.lastInput = v;
      var r = submit(F, v, {});
      if (r.kind === "error") {
        /* default-OFF / no-API: render the error branch instead of
           ever queueing a fetch (no auto-parse, no slot-wait). */
        F.session = { id: "", state: "ERROR",
                      error: { code: "FEATURE_DISABLED", message: r.message },
                      draft: null, trust: null, poll: null, req: null };
      }
      if (r.kind === "reject") {
        toast(String(v).trim() ? "Ez nem tűnik TikTok / Instagram linknek." : "Illeszd be a videó linkjét.", 2600);
        if (el) { el.focus(); }
      }
      mount();               /* repaint: PENDING progress or error branch */
    });
    on("add-blank", function () { startBlank(F.lastInput || ""); });
    on("add-reset", function () { cancel(F); mount(); });
    on("add-cancel", function () { cancel(F); mount(); });
    on("add-ing-add", function () {
      addRow(host, "add-ing",
        '<input name="ing-name" placeholder="név"/>'
        + '<input name="ing-qty" placeholder="mennyiség"/>'
        + '<input name="ing-note" placeholder="megjegyzés"/>'
        + '<button type="button" class="rm">×</button>');
    });
    on("add-step-add", function () {
      addRow(host, "add-steps",
        '<input name="st-t" placeholder="mp" style="max-width:90px"/>'
        + '<input name="st-text" placeholder="lépés leírása" style="flex:2 1 200px"/>'
        + '<button type="button" class="rm">×</button>');
    });
    on("add-save", function () {
      var doc = readDoc(F);
      if (!doc) { return; }
      memSave(doc);
      toast("Recept mentve", 2200);
      F.lastInput = "";
      mount();
      openRecipe(doc.id);          /* detail view shows the saved doc */
    });
  }

  window.AddRecipe = {
    flow: flow, submit: submit, cancel: cancel, mount: mount,
    chainOpen: chainOpen, chainState: chainState, chainDraft: chainDraft, apiSet: apiSet,
    toEditor: toEditor, toLocalDoc: toLocalDoc,
    __test: { toEditor: toEditor, chainOpen: chainOpen, submit: submit, flow: flow,
              cancel: cancel, chainDraft: chainDraft, toLocalDoc: toLocalDoc,
              chainState: chainState, apiSet: apiSet, readDoc: readDoc, mount: mount },
  };
})();



