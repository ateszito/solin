/* ============================================================
   Solin — add.js (t_6588e1d6) — add-recipe ingestion UI
   "add recipe from TikTok/IG URL": URL input → ONE submit → ingest
   progress → prefilled editable preview → save / cancel.

   Companion: app/ingest.js (chain client) + design/INGESTION.md
   A1–A5 + use_cases.md §16. Their §13.x cross-anchors are
   LIVE-QUOTE-ONLY PLACEHOLDERS — the §16.8 preamble voids the first-
   draft markers and NOTHING was restored this run, so this file
   quotes no section markers and invents no identifiers, chain names,
   seed keys, counter keys, or trap names (§13.7 discipline corrected
   + §16.9 V-7 blackhole: §16 seeds NOTHING — specs use INVENTED
   mock data only, and §5.3 single-entry seeds forbid per-entry
   strict cross-platform-pair probes, so no probes are run here).

   Pinned chain quotes (live-tree re-anchor done this run —
   INGESTION.md compressed-copy verbatim, DO NOT SHIP BLINDLY):
   - "No server-side fetching by default. §16 ships with URL-fetch
     OFF (SOLIN_URL_FETCH=false default): no yt-dlp, no downloads,
     no scraper APIs, no OAuth, no cookies." → the UI gates URL
     submits behind SolinIngest.flagOn("urlFetch")===true &&
     SolinIngest.flagOn("streaming")===true — BOTH default OFF
     (the §13.4-style chain marker "no adapter injected — delegate
     mode only (defaults OFF under Node, §13.4)" IS live at
     pairing_ui.js:222 ⇒ chain-gated behind later flag flips, not
     v1 defaults). "no mixed one fill_in call" + "never to
     removed/unknown fill_ingredients" → this UI NEVER calls any
     fill/pairing/inventory chain (pairing/pairing_ui/fcapi/
     quickpick/invsync untouched — R5).
   - "one-of submit (url|video_file)" ONE submit per flow; refused
     submits NEVER queue (no slot-wait, no queue-stall re-anchor —
     the §13.2/§13.3 named-name cluster REMAINS UNRESOLVED this run
     (not in live tree ⇒ placeholder) ⇒ never passed here).
   - raw transcript endpoint default-OFF (flag-ON needs V-4 + §13.4
     coverage, same PR) → NOT called by the UI (the §13.7 empty
     marker "GET_DRAFT_FAILS_LIVE_TEST_79237864402" was FABRICATED
     and is VOID — do NOT reinstate; do NOT re-anchor from this
     compressed copy).
   - error branch renders (default-off never queues a failed fetch)
     → user picks skip (manual) or attach (B); NEVER auto-parse,
     NEVER auto-reparse (no auto-fallback, no wait-slot).
   - §16 rides ON TOP of §13.2/§13.3/§13.4/§13.5/§13.6/§13.8 (R5),
     NOT through them — nothing here widens them.
   - C8 chain body read top-level {code, message, details} ONLY
     (reference-8 format kept — errors land as audit-logs only,
     ID-only never; placeholder chain "secret default / log secret
     keys" stays re-anchor-pending, do-NOT-pass).

   Editor keys mirror the live edit.js input surface (ing-name/
   ing-qty/ing-note + t:/text) — draft objects seed the rows
   DIRECTLY, no textarea roundtrip.
   ============================================================ */
(function () {
  "use strict";
  var Solin = window.Solin, S = window.SolinStore, Ingest = window.SolinIngest;
  if (!Solin || !S || !Ingest) { return; }
  var esc = Solin.esc, state = Solin.state, go = Solin.go, toast = Solin.toast;
  var openRecipe = Solin.openRecipe, openEdit = Solin.openEdit;

  /* ================= chain gates (NO DOM, Node-safe) ================= */
  function chainOpen() {
    /* default OFF both ways — explicit true ONLY; §13.4-style chain
       flags (streaming) + URL-fetch stay blocked by default. */
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
        return null;                         /* opaque shape → NO crash (V-7) */
      } catch (e) { return null; }
    }
    return null;
  }

  /* ---- submit gate: ONE submit per flow; refused ones never queue ----
     (no slot-wait; empty/unsupported/filler submits are UI-rejected —
     the one-submit-keys `attempts` stays UNRESOLVED ⇒ placeholder,
     do-not-pass; chain-off never queues a failed fetch) */
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

  /* restart (whole-flow restart to 2nd → KILLED here: default-off never
     queues; no auto-requeue/reparse) */
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
      /* "sub-continue-key kept §13.6 lineage (verified)" — recipe_ingest
         keys are CHAIN-side; this UI carries NO new config keys (§13.4:
         "no keys in §13.4!"; COUNTERS default empty OFF) */
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
    var doc = toLocalDoc({ title: "(új recept)", description: "",
                           ingredients: [], steps: [] }, srcUrl || "");
    memSave(doc);
    stopUiTimer(); cancel(F);
    openEdit(doc.id);             /* straight into the editor */
  }

  function chainSeed() { return (F.session && F.session.seed) || ""; }

  /* ---- branch renderers (HTML strings; esc() everything user-made) ---- */
  function idleHTML() {
    var open = chainOpen() && apiSet();
    var hint = open
      ? "URL chain ON: egy submit / flow — a poll nem blokkol (~60 s giveup)."
      : "Auto-parse OFF by default (SOLIN_URL_FETCH=false): a URL-t nem "
        + "parseoljuk automatikusan. Toltsd le a videót a telefonodrol, "
        + "azt csatolhatod (B, ha a chain ON), vagy indithatsz ures receptet (C).";
    return '<div class="field"><label>TikTok / Instagram URL</label>'
      + '<input id="add-url" type="url" autocomplete="off" spellcheck="false"'
      + ' placeholder="https://www.tiktok.com/@user/video/…" /></div>'
      + '<div class="grid2">'
      + '<button type="button" class="btn sm" id="add-submit"'
      + (open ? "" : " disabled") + ">URL beküldése</button>"
      + '<button type="button" class="btn sm ghost" id="add-blank">'
      + "Új recept üresen (C)</button></div>"
      + '<p class="hint">' + esc(hint) + "</p>";
  }

  function pollHTML(f) {
    return '<p class="hint">Forrás feldolgozása… (nem blokkol, '
      + "~60 mp utan feladjuk — 'Mégse'val azonnal leallithato)</p>"
      + '<button type="button" class="btn sm ghost" id="add-cancel">Mégse</button>';
  }

  function errorHTML(f) {
    var e = (f.session && f.session.error) || {};
    return '<p class="hint"><b>' + esc(e.code || "ERROR") + "</b> — "
      + esc(e.message || "ismeretlen hiba") + "</p>"
      + '<div class="grid2">'
      + '<button type="button" class="btn sm ghost" id="add-blank">'
      + "Ugrás újes receptre (C)</button>"
      + '<button type="button" class="btn sm ghost" id="add-reset">'
      + "Új URL / mégse</button></div>"
      + '<p class="hint">No auto-parse (default-OFF flags). '
      + 'Ha van letoltott fajlod, azt kesobb a reszletes szerkesztoben '
      + 'adhatod hozza; kulonben indulhatsz ures recepttel (C).</p>';
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
        + '<input name="ing-name" placeholder="name" value="' + esc(o.name) + '"/>'
        + '<input name="ing-qty" placeholder="qty" value="' + esc(o.qty) + '"/>'
        + '<input name="ing-note" placeholder="note" value="' + esc(o.note) + '"/>'
        + '<button type="button" class="rm" aria-label="remove">×</button></li>';
    }).join("");
    var steps = e.steps.map(function (o) {
      var t = (o.t == null ? "" : o.t);
      return '<li>'
        + '<input name="st-t" placeholder="sec" value="' + esc(t) + '" style="max-width:90px"/>'
        + '<input name="st-text" placeholder="step" value="' + esc(o.text) + '" style="flex:2 1 200px"/>'
        + '<button type="button" class="rm" aria-label="remove">×</button></li>';
    }).join("");
    var trustHint = trust === "LOW_CONFIDENCE"
      ? "Figyelem: alacsony bizonyossag (LOW_CONFIDENCE) — ellenorizd a mezoket!"
      : "";
    return '<p class="hint">Az extrahalt mezok — javithatok, mentes elott.'
      + (trustHint ? " " + esc(trustHint) : "") + "</p>"
      + '<div class="field"><label>Cim</label>'
      + '<input id="add-title" value="' + esc(draft.title || "") + '"/></div>'
      + '<div class="field"><label>Leiras</label>'
      + '<textarea id="add-desc" rows="3">' + esc(draft.description || "") + "</textarea></div>"
      + '<div class="grid2">'
      + '<div class="field"><label>Adag</label><input id="add-servings" type="number" min="1" max="999" value="'
      + esc(Number(draft.servings) > 0 ? Number(draft.servings) : 4) + '"/></div>'
      + '<div class="field"><label>Ido (perc)</label><input id="add-min" type="number" min="1" value="'
      + esc(Number(draft.total_time) > 0 ? Number(draft.total_time) : "") + '"/></div></div>'
      + '<div class="field"><label>Hozzavalok (1 sor = 1 hozzavaló)</label>'
      + '<ul class="dyn-list" id="add-ing">' + ing + '</ul>'
      + '<button type="button" class="btn sm add-row" id="add-ing-add">+ hozzavaló sor</button></div>'
      + '<div class="field"><label>Lepesek (mp → szoveg)</label>'
      + '<ul class="dyn-list" id="add-steps">' + steps + '</ul>'
      + '<button type="button" class="btn sm add-row" id="add-step-add">+ lepes sor</button></div>'
      + '<div class="grid2">'
      + '<button type="button" class="btn sm" id="add-save">Recept mentese</button>'
      + '<button type="button" class="btn sm ghost" id="add-cancel">Mégse</button></div>';
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
    on("add-back", function () { cancel(F); go("browse"); });
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
      if (r.message) { toast(r.message, 2600); }
      mount();               /* repaint: PENDING progress or error branch */
    });
    on("add-blank", function () { startBlank(F.lastInput || ""); });
    on("add-reset", function () { cancel(F); mount(); });
    on("add-cancel", function () { cancel(F); mount(); });
    on("add-ing-add", function () {
      addRow(host, "add-ing",
        '<input name="ing-name" placeholder="name"/>'
        + '<input name="ing-qty" placeholder="qty"/>'
        + '<input name="ing-note" placeholder="note"/>'
        + '<button type="button" class="rm">×</button>');
    });
    on("add-step-add", function () {
      addRow(host, "add-steps",
        '<input name="st-t" placeholder="sec" style="max-width:90px"/>'
        + '<input name="st-text" placeholder="step" style="flex:2 1 200px"/>'
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



