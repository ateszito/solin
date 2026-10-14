/* ============================================================
   Solin — app/tests/portions.spec.js
   Pure unit tests for the PORTION UI split (app/pairing.js) +
   the fcapi.js portions passthrough, run with:
       node app/tests/portions.spec.js

   Ground truth: tests/fixtures/PORTIONS.json (engine-verified,
   design/PORTIONS.md §8) — we assert the client's per_portion
   block is EXACTLY r2(totals / N) for every macro field, and that
   the HTML shown in the result card matches the fixture numbers
   (the "type 6" acceptance) and that total_cost is never divided.
   ============================================================ */
"use strict";

/* ---- minimal browser shims so the window.* IIFEs load under Node ---- */
global.window = global;

// Fake DOM just enough for pairing.js: $("#sel") + element .value etc.
const els = {};
const mkEl = (id) => ({
  id, value: "", innerHTML: "", textContent: "",
  classList: {
    _s: new Set(["hidden"]),
    add(...c) { c.forEach((x) => this._s.add(x)); },
    remove(...c) { c.forEach((x) => this._s.delete(x)); },
    toggle(c, on) { (on === true ? this._s.add(c) : this._s.delete(c)); },
    contains(c) { return this._s.has(c); },
  },
  dataset: {},
  focus() {},
  addEventListener() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
});
["pg-result", "pg-status", "pg-portions-in", "pg-portions-err",
 "pairing-section", "pg-rows", "pg-badge", "pairing"].forEach((id) => els["#" + id] = mkEl(id));
global.document = { activeElement: null };

// Solin core: $, S, esc, toast (pairing.js destructures at load)
global.window.Solin = {
  $: (sel) => els[sel] || null,
  $$: () => [],
  S: { load: (k, d) => d, save: () => {} },
  esc: (s) => String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  toast: () => {},
};

require("../fcapi.js");
require("../pairing.js");
const Fc = global.window.FcApi;
const P = global.window.Pairing.__test;

let pass = 0, fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else {
    fail++;
    console.log(`  FAIL  ${label}\n        actual   = ${a}\n        expected = ${e}`);
  }
}
function ok(label, cond) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}
function group(name, fn) { console.log(`\n${name}`); fn(); }

/* ---- canonical fixture (engine-verified reference) ---- */
const F = JSON.parse(require("fs").readFileSync(
  require("path").join(__dirname, "..", "..", "tests", "fixtures", "PORTIONS.json"), "utf8"));
const TOTALS = F.expected_totals;
const COST = F.expected_total_cost;
const KEYORDER = ["calories", "protein", "fat", "carbs", "fiber", "sugar", "sodium"];

group("MACRO_KEYS canonical order (contract §3.2 / §11.5)", () => {
  eq("7 keys, same order as totals", P.MACRO_KEYS, KEYORDER);
});

group("halfUp2 — C2 ROUND_HALF_UP 2 dp (contract §6)", () => {
  eq("17.475 -> 17.48 (HALF_UP, not banker's)", P.halfUp2(17.475), 17.48);
  eq("4.525 -> 4.53", P.halfUp2(4.525), 4.53);
  eq("0.525 -> 0.53", P.halfUp2(0.525), 0.53);
  eq("0.025 -> 0.03", P.halfUp2(0.025), 0.03);
  eq("37.5 -> 37.5 (already 1 dp)", P.halfUp2(37.5), 37.5);
  eq("100 -> 100", P.halfUp2(100), 100);
  eq("null -> 0 (pad missing)", P.halfUp2(null), 0);
  eq("0.01666... -> 0.02", P.halfUp2(0.10 / 6), 0.02);
  eq("1.005-ish exact: 20.005 -> 20.01 (string-exact, no float drift)",
     P.halfUp2(20.005), 20.01);
  eq("0.1 + 0.2 style input: 127.9 -> 127.9", P.halfUp2(127.9), 127.9);
});

group("perPortionOf — every fixture row (n=1,3,4,6,8,100) matches engine", () => {
  for (const row of F.portions_reference) {
    eq(`n=${row.portions} => exact fixture block`,
       P.perPortionOf(TOTALS, row.portions), row.per_portion);
  }
  // key order preserved (contract §11.5)
  eq("per_portion key order == totals order",
     Object.keys(P.perPortionOf(TOTALS, 4)), KEYORDER);
});

group("parsePortions — design §5 reject/accept (E1–E8)", () => {
  eq("1 -> 1", P.parsePortions("1"), 1);
  eq("6 -> 6", P.parsePortions("6"), 6);
  eq("999 -> 999 (max bound)", P.parsePortions("999"), 999);
  eq("' 6 ' (whitespace) -> 6", P.parsePortions(" 6 "), 6);
  eq("+6 -> 6", P.parsePortions("+6"), 6);
  // rejects — design: NOT clamp, NOT silent
  eq("0 -> null (E3)", P.parsePortions(0), null);
  eq("-3 -> null (E4)", P.parsePortions("-3"), null);
  eq("2.5 -> null (E5, integral required)", P.parsePortions("2.5"), null);
  eq("1000 -> null (E7, >999)", P.parsePortions("1000"), null);
  eq("'abc' -> null (E6, non-numeric)", P.parsePortions("abc"), null);
  eq("'' -> null", P.parsePortions(""), null);
  eq("null -> null", P.parsePortions(null), null);
  eq("7.5 -> null (QA case)", P.parsePortions("7.5"), null);
});

group("fcapi.countMacros — portions passthrough in request body", () => {
  // Stub fetch: capture the body, return a canned 200.
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = opts && opts.body;
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => ({ totals: TOTALS, per_portion: undefined,
                          total_cost: COST, portions: 6,
                          per_ingredient: [], warnings: [] }),
    };
  };
  window.SolinCfg = { apiBase: () => "http://test.local" };

  return Promise.resolve(Fc.countMacros([{ product_id: "p1", quantity: 200, unit: "g" }], 6))
    .then(() => {
      const body = JSON.parse(captured);
      eq("body.portions == 6 when valid", body.portions, 6);
      eq("body.items intact", body.items[0], { product_id: "p1", quantity: 200, unit: "g" });
      return Promise.resolve(Fc.countMacros([{ product_id: "p1", quantity: 200, unit: "g" }], undefined))
        .then(() => {
          const body2 = JSON.parse(captured);
          eq("body has NO portions key when omitted (backward-compat)",
             Object.prototype.hasOwnProperty.call(body2, "portions"), false);
        });
    })
    .then(() => Promise.resolve(Fc.countMacros([{ product_id: "p1", quantity: 200, unit: "g" }], "junk"))
      .then(() => {
        const body3 = JSON.parse(captured);
        eq("non-integral 'junk' -> key omitted (fallback), no crash",
           Object.prototype.hasOwnProperty.call(body3, "portions"), false);
      }))
    .then(() => runRenderTests())
    .catch((e) => { fail++; console.log("  FAIL  async: " + e.message); finish(); });
});

function runRenderTests() {
  group("renderResult — UI shows fixture numbers + invariant cost (acceptance)", () => {
    P.setLastCountFor(null); // fresh render: trust a present server block
    // 'type 6' acceptance: result HTML must carry the n=6 fixture values,
    // the whole-batch totals, and the unchanged total_cost.
    const res = {
      totals: TOTALS,
      per_ingredient: [
        { product_id: "p1", name: "chicken", quantity: 200, unit: "g",
          macros: { calories: 330, protein: 62, fat: 7.2, carbs: 0, fiber: 0, sugar: 0, sodium: 148 },
          cost: 1.495, warnings: [] },
      ],
      total_cost: COST,
      warnings: [{ code: "CROSS_CURRENCY_EXCLUDED", product_id: "p1" }],
      portions: 6,
      per_portion: F.portions_reference.find((r) => r.portions === 6).per_portion,
    };
    P.renderResult(res, 6);
    const html = els["#pg-result"].innerHTML;

    eq("per-portion cal (127.9) rendered",   html.includes(">127.9</b> kcal"), true);
    eq("per-portion protein (11.65)",        html.includes(">11.65</b> g P"), true);
    eq("per-portion fat (3.02)",             html.includes(">3.02</b> g Z"), true);
    eq("per-portion carbs (13.13)",          html.includes(">13.13</b> g C"), true);
    eq("per-portion fiber (0.35)",           html.includes(">0.35</b> g rost"), true);
    eq("per-portion sugar (0.02)",           html.includes(">0.02</b> g cukor"), true);
    eq("per-portion sodium (25)",            html.includes(">25</b> mg Na"), true);
    eq("per-portion lead '(6 adag)' (N>1)", html.includes("a 6 adagb"), true);
    eq("total-batch cal (767.4) kept",      html.includes(">767.4</b> kcal"), true);
    eq("total-batch protein (69.9) kept",   html.includes(">69.9</b> g P"), true);
    eq("total_cost UNDIVIDED (2.05 USD)",   html.includes(">2.05 USD</span>"), true);
    eq("total-batch price header present",  html.includes("AZ ÉTEL ÁRA (teljes batch)"), true);
    eq("per-portion block labeled PROMINENT", html.includes("PORTIÓNKÉNT"), true);
    eq("per-portion appears BEFORE totals block",
       html.indexOf("PORTIÓNKÉNT") < html.indexOf("ÖSSZESÍTÉS"), true);
    eq("warning chip rendered",             html.includes("Ár kizárva (másik valuta)"), true);

    // no per_portion on server (pre-portions backend) → client split path
    const res2 = {
      totals: TOTALS, per_ingredient: [], total_cost: COST, warnings: [],
    };
    P.renderResult(res2, 4);
    const html2 = els["#pg-result"].innerHTML;
    eq("client-split path: 191.85 kcal (fixture n=4)", html2.includes(">191.85</b> kcal"), true);
    eq("client-split path: 17.48 g P (fixture n=4)",  html2.includes(">17.48</b> g P"), true);
    eq("client-split path: 37.5 mg Na (fixture n=4)", html2.includes(">37.5</b> mg Na"), true);
    eq("client-split path: cost still 2.05",           html2.includes(">2.05 USD</span>"), true);

    // n=1 renders the whole batch as per-portion (per_portion == totals)
    P.renderResult({ ...res2, portions: 1 }, 1);
    const html3 = els["#pg-result"].innerHTML;
    eq("n=1: per-portion block == totals (767.4 kcal)", html3.includes(">767.4</b> kcal"), true);
    eq("n=1: lead says full-adag 1/1", html3.includes("Teljes adag (1/1)"), true);
  });

  group("stale-echo — post-fetch selector change never shows old per_portion (acceptance: no stale flash)", () => {
    const ref6 = F.portions_reference.find((r) => r.portions === 6).per_portion;
    const ref4 = F.portions_reference.find((r) => r.portions === 4).per_portion;
    // doCount() with 6 ports: LAST_RES now HAS a server per_portion for 6
    // (t_3ba0beb1 backend), and COUNTED_P == 6.
    const serverRes6 = {
      totals: TOTALS, per_ingredient: [], total_cost: COST, warnings: [],
      portions: 6, per_portion: ref6,
    };
    P.setLastCountFor(6);
    P.renderResult(serverRes6, 6);
    eq("count-for-6 shown at 6 → server block (127.9 kcal)",
       els["#pg-result"].innerHTML.includes(">127.9</b> kcal"), true);

    // user now types 4 (same LAST_RES, COUNTED_P still 6 → stale) →
    // MUST re-split totals/4 locally, not serve the stale n=6 block
    els["#pg-result"].innerHTML = "";
    P.renderResult(serverRes6, 4);
    const h = els["#pg-result"].innerHTML;
    eq("stale n=6 block NOT shown when displaying 4 (127.9 absent)",
       h.includes(">127.9</b> kcal"), false);
    eq("client re-split of 6@totals → 4 shows 191.85 kcal",
       h.includes(">191.85</b> kcal"), true);
    eq("client re-split 4 protein 17.48", h.includes(">17.48</b> g P"), true);
    eq("lead follows the NEW count (4 adagból)", h.includes("a 4 adagb"), true);
    eq("cost STILL whole-batch (2.05)", h.includes(">2.05 USD</span>"), true);

    // fresh recount at 4 → COUNTED_P refreshed to 4 → server block trusted again
    P.setLastCountFor(4);
    els["#pg-result"].innerHTML = "";
    P.renderResult({ ...serverRes6, portions: 4, per_portion: ref4 }, 4);
    eq("after fresh recount@4 → server block trusted (17.48 P)",
       els["#pg-result"].innerHTML.includes(">17.48</b> g P"), true);

    // display count is the selector value, never the server echo
    P.setLastCountFor(4);
    els["#pg-result"].innerHTML = "";
    P.renderResult({ ...serverRes6, portions: 4, per_portion: ref4 }, 6);
    const h6 = els["#pg-result"].innerHTML;
    eq("echo=4 but user shows 6 → splits 6, lead a 6 adagból",
       h6.includes("a 6 adagb"), true);
    eq("echo=4 but user shows 6 → client split n=6 (3.02 g Z)",
       h6.includes(">3.02</b> g Z"), true);
  });

  finish();
}

function finish() {
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
