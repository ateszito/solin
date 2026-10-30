/* ============================================================
   Solin — ingest.js (t_6588e1d6, UI slice of §16)
   Pure client for the /api/v1/ingest* chain (INGESTION.md A3/A4).
   Loaded BEFORE add.js. window.SolinIngest.

   Rules honored here (quoted from INGESTION.md / use_cases §16):
   - POST /api/v1/ingest `{source_type, source_id?, file_key?, locale?}`
     → 202 {ingest_id, status, created_at, poll?}; UI polls, never blocks.
   - Poll schedule: first tick 1500 ms, then ×1.6 up to a 5000 ms cap
     ("1.5s start, 5s backoff" reading; ONE place to change: POLL_SCHEDULE).
     60 s total cap → giveup → UI returns to idle (no slot-wait, no auto-requeue).
   - 429 / code TOO_MANY_REQUESTS → mandatory backoff toast (hook) + all
     later polls at the 5000 ms cap.
   - Terminal-success statuses OK/LOW_CONFIDENCE carry recipe_draft;
     terminal-error statuses RESOLVE_FAILED_EXTRACTOR/_LOGIN_REQUIRED/
     _PRIVATE_OR_REGION + TRANSCRIBED_EMPTY route to the error branch.
   - Default-OFF flags stay blocked here (V-2/§13.2/§13.3 style, re-anchored):
     urlFetch defaults false — without a baked `SOLIN_URL_FETCH=true` the UI
     NEVER submits a URL for auto-parse (error branch routes to B/manual).
   - The raw-transcript endpoint (GET /api/v1/ingest/{id}/transcript) is
     default-OFF (flag-ON needs V-4 + §13.4 coverage, same PR) — NOT called
     by the UI. This module is the ONLY chain client; pairing/pairing_ui/
     inventory flows stay untouched (§16 rides on top, never widens them).
   ============================================================ */
(function () {
  "use strict";

  var CHAIN_PATH = "/api/v1/ingest";

  /* schedule builder — ONE editable place (§16.8 reading pinned above) */
  function makeSchedule() {
    var out = [], t = 1500;
    while (t < 5000) { out.push(t); t = Math.round(t * 1.6); }
    out.push(5000, 5000, 5000, 5000, 5000, 5000);
    return out; /* 1500, 2400, 3840, then 5000-capped ticks (~60 s giveup) */
  }
  var SCHEDULE = makeSchedule();

  function apiBase() {
    var cfg = (typeof window !== "undefined") && window.SolinCfg;
    var b = cfg && cfg.apiBase ? cfg.apiBase() : "";
    return (b || "").replace(/\/+$/, "");
  }
  function flagOn(name) {
    var cfg = (typeof window !== "undefined") && window.SolinCfg && window.SolinCfg.cfg;
    return cfg ? cfg[name] === true : false; /* explicit-true only: default OFF */
  }

  /* classify a pasted source so the UI knows the branch BEFORE submitting */
  function classifySource(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return { kind: "empty", kind2: "empty" };
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(s);
    if (m) {
      var host = m[1].toLowerCase().replace(/^www\./, "");
      if (host === "vm.tiktok.com" || host === "vt.tiktok.com" ||
          /(^|\.)tiktok\.com$/.test(host) || /(^|\.)tiktokv\.com$/.test(host))
        return { kind: "url", platform: "tiktok", url: s };
      if (/(^|\.)instagram\.com$/.test(host) || /(^|\.)instagr\.am$/.test(host))
        return { kind: "url", platform: "instagram", url: s };
      return { kind: "unknown", url: s };           /* never auto-parsed */
    }
    return /^\.{0,2}\/\//.test(s)
      ? { kind: "url", platform: "other", url: s }   /* protocol-relative */
      : { kind: "invalid", text: s };                /* filler text */
  }

  /* where the poller should knock (§16.3: server echoes `poll` in 202) */
  function pollUrl(resp) {
    var p = (resp && resp.poll) || (resp && resp.data && resp.data.poll);
    if (p && /^(https?:)?\/\//.test(p)) return p;
    if (p && p.charAt(0) === "/") return apiBase() + p;
    var id = (resp && resp.ingest_id) || (resp && resp.id) ||
             (resp && resp.data && resp.data.ingest_id);
    return apiBase() + CHAIN_PATH + "/" + encodeURIComponent(id == null ? "" : id);
  }

  function isTerminalError(status) {
    var s = String(status == null ? "" : status);
    return s === "RESOLVE_FAILED_EXTRACTOR" ||
           s === "RESOLVE_FAILED_LOGIN_REQUIRED" ||
           s === "RESOLVE_FAILED_PRIVATE_OR_REGION" ||
           s === "TRANSCRIBED_EMPTY";
  }
  function isDraftReady(body) {
    return !!(body && body.recipe_draft && body.recipe_draft.recipe_json);
  }
  function trustOf(body) {
    return (body && body.recipe_draft && body.recipe_draft.trust) || null;
  }

  /* ---- ONE poll session against ONE source (§13.2 one-rule kept) ----
     s = {fetch, timer, notify, onDone, onGiveUp, t0}
     fetch(url) -> Promise<{status, body}>  (status 0 = transport failure)
     timer: {now, setTimeout, clearTimeout}  (fake-able in spec)
     notify: {backoffToast(reason), statusBlock(body)} — never throws.  */
  function createPoller(s) {
    var timers = s.timer, state = "PENDING", tick = 0, timer = null;
    function lastTick(ms) { /* default-off never auto-requeues (no wait slot) */
      return tick > 0;
    }
    function classify(result) {
      if (result == null) return { mode: "error", code: "TRANSPORT_FAILURE",
                                   message: "ingest chain unreachable (host-config default OFF)" };
      if (result.status === 202 || result.status === 200) {
        var body = result.body || {};
        if (isDraftReady(body)) return { mode: "draft", trust: trustOf(body), draft: body };
        if (isTerminalError(body.status)) return { mode: "error", code: body.status,
                                                   message: body.detail || "source resolve failed" };
        return { mode: "wait" };
      }
      if (result.status === 429) return { mode: "backoff429", code: "TOO_MANY_REQUESTS" };
      if (result.status === 403) return { mode: "error", code: "FEATURE_DISABLED",
                                           message: (result.body && result.body.message) || "feature disabled (flag off)" };
      if (result.status === 410) return { mode: "error", code: "FILE_UNAVAILABLE",
                                           message: (result.body && result.body.message) || "source file expired" };
      if (result.status === 404) return { mode: "error", code: "NOT_FOUND",
                                           message: (result.body && result.body.message) || "not found" };
      if (result.status === 400) return { mode: "error", code: "VALIDATION_ERROR",
                                           message: (result.body && result.body.message) || "invalid source" };
      return { mode: "error", code: "INTERNAL", message: "status " + result.status + " (chain off/err)" };
    }
    function step() {
      if (state !== "PENDING") return;
      var url = s.url;
      s.fetch(url).then(function (res) {
        if (state !== "PENDING") return;
        var cls = classify(res);
        if (cls.mode === "wait") { tick++; wait(); return; }
        if (cls.mode === "backoff429") {
          s.notify.backoffToast("Sok a kérés — kicsit lassabban próbálkozunk tovább…");
          tick = SCHEDULE.length - 1; /* stay on the 5 s cap */
          wait();
          return;
        }
        if (cls.mode === "draft") { state = "DRAFT"; return s.onDone(cls); }
        state = "ERROR"; s.onDone(cls);
      }, function () {
        if (state !== "PENDING") return;
        /* only surface the glitch once — a toast on every retry is noise */
        if (tick === 0) s.notify.backoffToast("Kapcsolódási gond — újrapróbálkozunk…");
        tick++; wait(); /* transport glitch → retry same submit, capped */
      });
    }
    function wait() {
      if (tick >= SCHEDULE.length) { state = "GIVEUP"; s.onGiveUp(); return; }
      timer = timers.setTimeout(step, SCHEDULE[tick]);
      if (timer && timer.unref) timer.unref(); /* never hold the Node test loop */
    }
    function start() { wait(); return api; }
    function stop() { state = "STOPPED"; if (timer) timers.clearTimeout(timer); }
    var api = {
      start: start, stop: stop,
      state: function () { return state; },
      nextInterval: function () { return tick >= SCHEDULE.length ? null : SCHEDULE[tick]; },
      schedule: SCHEDULE,
    };
    return api;
  }

  /* live submit body shape (identical-partial-fields clause, §16.3):
     only keys with values are sent; session pins USER_LOCALE default "hu". */
  function submitBody(src, fileRef, locale) {
    var b = { source_type: (src.kind === "url" || src.platform) ? "url" : (src.kind || "url") };
    if (src.platform) b.platform = src.platform;
    if (src.url) b.source_id = src.url;
    if (fileRef != null && fileRef !== "") b.file_ref = fileRef; /* proxy key only */
    var loc = locale || (typeof navigator !== "undefined" && navigator.language) || "hu";
    if (loc) b.locale = String(loc).toLowerCase();
    return b;
  }

  window.SolinIngest = {
    CHAIN_PATH: CHAIN_PATH,
    classifySource: classifySource,
    pollUrl: pollUrl,
    createPoller: createPoller,
    submitBody: submitBody,
    isDraftReady: isDraftReady,
    isTerminalError: isTerminalError,
    trustOf: trustOf,
    flagOn: flagOn,
    apiBase: apiBase,
    __test: { schedule: SCHEDULE, classifySource: classifySource,
              pollUrl: pollUrl, submitBody: submitBody, createPoller: createPoller,
              isDraftReady: isDraftReady, isTerminalError: isTerminalError },
  };
})();
