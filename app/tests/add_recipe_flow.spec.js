/* ============================================================
   Solin — app/tests/add_recipe_flow.spec.js   (t_6588e1d6)
   Add-recipe ingestion flow: kernel pins (NO DOM needed).
   Pins the acceptance invariants:
     * default-OFF flags NEVER queue a fetch (0 POST/GET);
     * empty/unsupported/manual submit → reject (no queue);
     * api-unset → error branch, NO network call;
     * one submit per flow slot (refused second submit);
     * happy chain: 202 -> poll -> DRAFT -> editor-seed objects;
       qty+unit stays SEPARATE (qty=quantity, note=unit);
     * 404 poll -> error branch (attach/manual routes, never
       auto-parse; UI never blocks on slot-wait);
     * toLocalDoc carries NO transcript/tooling shapes (V-7 seed
       exemption) and keeps camel shape (browse/detail read it).
   Run:  node app/tests/add_recipe_flow.spec.js
   ============================================================ */
"use strict";
const assert = require("node:assert");

/* ---- minimal browser shim (spirit of portions.spec.js) ---- */
const CALLS = [];
class MemStorage {
  constructor(init) { this.m = Object.assign({}, init || {}); }
  getItem(k) { return k in this.m ? this.m[k] : null; }
  setItem(k, v) { this.m[k] = v; }
}
function boot({ flags = {}, base = "https://api.test", fetchImpl = null } = {}) {
  CALLS.length = 0;
  delete require.cache[require.resolve("../ingest.js")];
  delete require.cache[require.resolve("../add.js")];
  const store = new MemStorage();
  global.localStorage = store;
  global.sessionStorage = new MemStorage();
  global.window = global;
  global.document = { activeElement: null };
  global.fetch = fetchImpl || ((m, u, b) => { CALLS.push([m, u]); return Promise.resolve({ status: 499, body: {} }); });
  global.window.Solin = {
    esc: (s) => String(s), toast: () => {}, go: () => {},
    state: { activeCat: null, activeRecipe: null },
    openRecipe: () => {}, openEdit: () => {},
  };
  global.window.SolinStore = {
    getFlag: (k) => (store.getItem("solin.flags.v1") || "{}").includes(k),
  };
  global.window.SolinCfg = { cfg: flags, apiBase: () => base };
  require("../ingest.js");
  require("../add.js");
  return global.window.AddRecipe;
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/* synchronous fake clock: poller schedule (1.25s…60s) collapses to 0
   — unit pins test the CLASSIFIER + draft-parse chain, timing e6 lives
   in e2e (fake timers there too). */
const IMM = { setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {} };

/* draft fixture = ONE canonical chain shape (recipe_json passthrough) */
const DRAFT = {
  status: "done",
  recipe_draft: {
    recipe_json: {
      title: " eines Sodavod.blue.self-test",
      cuisine: "other", description: "selftest",
      servings: 2, total_time: 10,
      ingredients: [{ ingredient: "sót", quantity: "1", unit: "tk", note: "" }],
      steps: " ஒரு zódjamás lépés sós vajból.",
    },
  },
};

(async () => {
  /* --- T1 default-OFF: queue never queues, ever --- */
  {
    const A = boot({ flags: {} });                    /* COUNTERS flag OFF by default */
    const f = A.flow();
    const r = A.submit(f, "https://www.tiktok.com/@x/video/1", {});
    assert.equal(r.kind, "error", "flags-off submit -> error branch");
    assert.equal(CALLS.length, 0, "flags-off must NEVER queue a fetch");
    assert.equal(A.chainState(f), "IDLE", "no slot-wait on flags-off");
  }

  /* --- T2 api-unset (flags on, api empty): error branch, no fetch --- */
  {
    const A = boot({ flags: { urlFetch: true, streaming: true }, base: "" });
    const f = A.flow();
    const r = A.submit(f, "https://www.tiktok.com/@x/video/1", {});
    assert.equal(r.kind, "error");
    assert.equal(CALLS.length, 0, "no fetch when api base unset");
  }

  /* --- T3 rejects: empty / unsupported / manual (never auto-parse) --- */
  {
    const A = boot({ flags: { urlFetch: true, streaming: true } });
    const f = A.flow();
    assert.equal(A.submit(f, "", {}).kind, "reject");
    assert.equal(A.submit(f, "csirkepaprikás csirkéből", {}).kind, "reject");
    assert.equal(A.submit(f, "tesco.com/item/123", {}).kind, "reject");
    assert.equal(CALLS.length, 0, "rejected submits never queue a fetch");
  }

  /* --- T4 happy chain: 202 -> poll -> DRAFT, slot stays ONE --- */
  {
    const impl = (m, u) => {
      CALLS.push([m, u]);
      if (m === "POST") { return Promise.resolve({ status: 202, body: { ingest_id: "ing-1", poll_url: "/api/v1/ingest/ing-1", status: "accepted" } }); }
      return Promise.resolve({ status: 200, body: DRAFT });
    };
    const A = boot({ flags: { urlFetch: true, streaming: true }, fetchImpl: impl });
    const f = A.flow();
    const r = A.submit(f, "https://www.tiktok.com/@x/video/1", { fetch: impl, timer: IMM });
    assert.equal(r.kind, "go", "supported URL -> chain, non-blocking");
    assert.equal(A.submit(f, "https://x", { fetch: impl, timer: IMM }).kind, "refused",
      "ONE submit per flow: slot occupied, second refused");
    await tick(30);
    assert.equal(A.chainState(f), "DRAFT", "poller reached DRAFT (no UI block)");
    const d = A.chainDraft(f);
    assert(d && d.ingredients && d.steps, "draft parses to editor-seed shape");
    /* R7 (revised): qty+unit stay SEPARATE — no composition collision */
    const e = A.toEditor(d);
    assert.deepEqual(e.ing, [{ name: "sót", qty: "1", note: "tk" }],
      "quantity/UNIT parsed to separate qty/note columns");
    assert.equal(e.steps.length, 1);
    assert(!A.toLocalDoc(d, "").ingredients.some((i) => i.some), "no appended-array hack");
    /* second chain would REUSE the same key -> rejected by call itself */
  }

  /* --- T5 poll 404 -> error branch, never auto-parse requeue --- */
  {
    const impl = (m, u) => {
      CALLS.push([m, u]);
      if (m === "POST") { return Promise.resolve({ status: 202, body: { ingest_id: "i", poll_url: "/api/v1/ingest/i" } }); }
      return Promise.resolve({ status: 404, body: { message: "not found" } });
    };
    const A = boot({ flags: { urlFetch: true, streaming: true }, fetchImpl: impl });
    const f = A.flow();
    A.submit(f, "https://www.tiktok.com/@x/video/1", { fetch: impl, timer: IMM });
    await tick(30);
    assert.equal(A.chainState(f), "ERROR", "404 routes to the error branch");
    assert.doesNotThrow(() => A.mount("x"));      /* DOM-less env: guarded */
    const doc = A.toLocalDoc(A.chainDraft(f), "manual-paste (no auto-parse)");
    assert.equal(doc, null, "404 has no draft to seed — no crash (V-7)");
    const seeded = A.toLocalDoc({ title: "x",
      ingredients: [{ name: "sót", qty: "1", note: "tk" }],
      steps: [{ t: 5, text: "less" }] }, "manual-paste (no auto-parse)");
    assert(!JSON.stringify(seeded).includes("TO_JSON_TO_JSON"), "seed exemption V-7");
    assert(!JSON.stringify(seeded).includes("tesco"), "no auto-parse path carried");
  }

  /* --- T6 host rule: absolute domain only; long URL safe --- */
  {
    const impl = (m, u) => { CALLS.push([m, u]); return Promise.resolve({ status: 499, body: {} }); };
    const A = boot({ flags: { urlFetch: true, streaming: true }, base: "https://api.test/", fetchImpl: impl });
    const f = A.flow();
    const long = "https://www.instagram.com/reel/ABC123/?hl=en&x=" + "y".repeat(300);
    const r = A.submit(f, long, { fetch: impl });
    assert.equal(r.kind, "go");
    await tick(40);
    assert(CALLS.every((c) => !c[1].includes("://~/Solin")), "no hardcoded dev path");
    assert(CALLS.every((c) => new URL(c[1]).origin === "https://api.test"),
      "host rule: full absolute domain, never root, never .local");
    assert(CALLS.every((c) => c[1].length < 500), "long submit URL kept out of URLs");
  }

  /* --- T7 cancel frees the slot (immediate, manual) --- */
  {
    const A = boot({ flags: { urlFetch: true, streaming: true } });
    const f = A.flow();
    A.submit(f, "https://www.tiktok.com/@x/video/1", { fetch: (m, u) => { CALLS.push([m, u]); return new Promise(() => {}); } });
    assert.equal(A.chainState(f), "PENDING");
    A.cancel(f);
    assert.equal(A.chainState(f), "IDLE", "cancel -> slot free");
    assert.equal(A.submit(f, "https://www.tiktok.com/@y/video/2", {}).kind, "go",
      "after cancel the NEXT submit is accepted");
  }

  console.log("add_recipe_flow.spec: OK (" + CALLS.length + " trailing calls)")
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
