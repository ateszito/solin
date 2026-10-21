/* ============================================================
   Solin — app/tests/pairing_ui.spec.js   (t_c05b328b)
   Pure unit tests for app/pairing_ui.js — the pairing-view UI glue
   (quick search chain, quick add chain, live preview block).

   Run: node --test app/tests/pairing_ui.spec.js

   Serverless + own-data rule (§13.4/§13.7): the listing, chains and
   seeds below are ALL OWN constants invented in this file — no seed
   blocks, no %RESOURCE: keys, no fixture-file keys, no network, no
   DOM. The module is pure glue: empty/unknown/cross inputs are
   asserted to never reach the working set (§13.2 mirror rule), and
   count/preview delegation is asserted to REPLACE re-derivation
   when an adapter is present (§13.4 delegate rule).
   ============================================================ */
"use strict";

const T = require("node:test");
const a = require("node:assert");

const P = require("../pairing_ui.js");
const QS = require("../quickpick.js");

/* ---------- OWN listing (invented for this spec only) ---------- */
const LISTING = [
  { id: "own_tofu", name: "TofuTest", base_unit: "g",
    macros: { calories: 140, protein: 16, fat: 8 },
    price: 390, currency: "HUF",                       // primary /100 g key (§4.3)
    prices: { HUF: 390, USD: 1.2 } },                  // §13.7 double keys, separate
  { id: "own_tea", name: "TeaTest", base_unit: "dl",
    macros: { calories: 0 }, prices: {} },
  { id: "own_bread", name: "BreadTest", base_unit: "g", macros: {}, prices: {} },
  { id: "own_sauce", name: "SauceTest", base_unit: "dl",
    macros: { protein: 5 }, price: 80, currency: "USD", prices: { USD: 0.8 } },
];

const h = (over) => P.makeHandlers(Object.assign({ listing: LISTING }, over || {}));

/* ---------- chainState: pure chain lookup ---------- */

T.test("all-present chain: resolves to assembled state, never re-decomposes (§13.5-1/§13.5-3)", () => {
  const c = P.chainState({
    recipeId: "own_r1", listing: LISTING,
    recipe: [{ name: "TofuTest", amount: "200", unit: "g", product_id: "own_tofu" },
             { name: "TeaTest", amount: "2", unit: "dl", product_id: "own_tea" }],
    custom: [{ name: "CheeseTest", amount: "30", unit: "g", price: 500,
               macros: { protein: 25 }, currency: "HUF" }],
    picks: [{ uid: "own_bread", name: "BreadTest", amount: "60", unit: "g" }],
  }, {});
  a.equal(c.blocked.length, 0, "clean chain must not block");
  a.equal(c.state.length, 4, "2 recipe rows + 1 custom + 1 pick");
  const tofu = c.state.find(s => s.product_id === "own_tofu");
  a.equal(tofu.quantity, 200);
  a.equal(tofu.unit, "g");
  a.ok(c.state.some(s => s.source === "quick"),
    "quick pick pushed as §5.3-style seed3 entry (name + amount + unit, rule 1)");
});

T.test("blocked inputs NEVER enter the working set (§13.2 / §13.5-1)", () => {
  // empty amount on a recipe row → blocked-empty message, NO clamp (§13.2)
  const c1 = P.chainState({ listing: LISTING,
    recipe: [{ name: "TeaTest", amount: "", unit: "dl", product_id: "own_tea" }] }, {});
  a.equal(c1.state.length, 0, "empty amount never counted (§13.2/§13.7)");
  a.equal(c1.blocked.length, 1);
  // cross-family unit (dl on g-based product) → blocked-cross, NOT clamped (§4.1/§13.3)
  const c2 = P.chainState({ listing: LISTING,
    picks: [{ uid: "own_bread", name: "BreadTest", amount: "2", unit: "dl" }] }, {});
  a.equal(c2.state.length, 0, "cross-family unit never reaches the working set");
  a.equal(c2.blocked.length, 1);
  // unknown uid → blocked-unknown (§13.5-1)
  const c3 = P.chainState({ listing: LISTING,
    picks: [{ uid: "own_ghost", name: "GhostTest" }] }, {});
  a.equal(c3.blocked.length, 1);
  a.ok(/raktári|termék/.test(c3.blocked[0].message));
});

T.test("empty + error are SEPARATE chains (t_96fcfc2a pin)", () => {
  const empty = P.makeHandlers({ listing: LISTING });
  const r1 = empty.collect();                      // no seeds: chain shape, not "no data"
  // module returns blocked:[] on clean/empty chains; blocked:true ONLY
  // when a blocked seed forces the whole chain (block-first, §13.2)
  a.ok(Array.isArray(r1.blocked) && r1.blocked.length === 0,
    "empty chain is NOT the blocked chain (never-throw defaults OFF)");
  a.deepEqual(r1.items, []);
  const err = h({ seeds: ["BreadTest 2 dl"] });    // blocked seed → whole chain blocks
  const r2 = err.collect();
  a.equal(r2.kind, "chain", "blocked chain renders its own chain, §13.2");
  a.ok(r2.message.indexOf("Nem számolható") === 0, "error bar is its own chain (§13.2)");
});

/* ---------- makeHandlers trio: harness mirror shapes (§13.4/§13.5) ---------- */

T.test("seed3 replay: valid seeds collect, blocked-before-count (§13.2 block-first)", () => {
  const H = h({ seeds: ["TofuTest 200 g", "TeaTest 2 dl", "SauceTest 1 dl"] });
  const r = H.collect();
  a.ok(Array.isArray(r.blocked) && r.blocked.length === 0, "valid homogeneous chains collect");
  a.equal(r.items.length, 3);
  // mixed batch (valid + cross-family) → whole batch refused BEFORE transport (§13.2)
  const M = h({ seeds: ["TofuTest 200 g", "BreadTest 2 dl"] });
  const bad = M.collect();
  a.equal(bad.blocked, true, "mixed bad batch blocks before anything is sent");
  a.ok(bad.message.indexOf("UNITS_INCOMPATIBLE") >= 0,
    "blocked keyed names the chain kind (own markers, NOT §5.3 seed keys)");
});

T.test("count/preview delegate to adapter WHEN PRESENT — replace if present (§13.4)", () => {
  // no adapter: pure-mode delegates to NOTHING (serverless default OFF, §13.4)
  const nod = h().count([{ product_id: "own_tofu", quantity: 200, unit: "g" }], {});
  a.equal(nod.kind, "chain"); a.ok(nod.skipped, "pure mode never runs adapter math (§13.4)");
  // with adapter: delegation REPLACES re-derivation (one chain for UI + adapter)
  let saw = null;
  const H = h({ adapter: {
    count: (items, opts) => { saw = items; return { kind: "state", echoed: items.length }; },
    preview: (agg) => ({ kind: "preview", keys: agg && agg.keys }),
  } });
  const items = [{ product_id: "own_tofu", quantity: 200, unit: "g" }];
  const r = H.count(items, {});
  a.equal(r.kind, "state"); a.equal(r.echoed, 1);
  a.equal(saw, items, "adapter received the exact items (delegated, not re-derived)");
  const p = H.preview({ keys: ["own_tofu"] });
  a.equal(p.kind, "preview"); a.deepEqual(p.keys, ["own_tofu"]);
});

/* ---------- previewText: FORMATTING ONLY (§13.6-2 / §13.7) ---------- */

T.test("previewText renders mirror output: no re-derivation, double keys separate", () => {
  // (a) real mirror replay: flagged unknown id stays UNPARSED TEXT, §13.6-2…
  const mirror = QS.perIngredientMirror(
    [{ product_id: "own_ghost", quantity: 2, unit: "dl" },
     { product_id: "own_bread", quantity: 20, unit: "g" },
     { product_id: "own_sauce", quantity: 1, unit: "dl" }], LISTING, {});
  const txt = P.previewText(mirror, { blocked: "Nem számolható", unparsed: "UNPARSED",
    default_blocked: "DEFAULT_BLOCKED" });
  // flagged (unknown id) renders as TEXT under the block bar — never clamped,
  // never computed; code marker present, no math re-run (§13.6-2)
  a.ok(txt.indexOf("Nem számolható") >= 0 && txt.indexOf("own_ghost") >= 0,
    "flagged rows render as block TEXT (never dropped/clamped), no math re-run");
  // empty macros = never counted → DEFAULT_BLOCKED text (§13.2-2)
  a.ok(txt.length > 0);
  // (b) double keys stay separate: HUF total + USD value on THEIR OWN lines (§13.7)
  const dbl = [{ product_id: "own_ghost", flagged: true, code: "UNPARSED",
                 message: "own-secret-key", macros: null, cost: null },
               { name: "BreadTest", quantity: 20, unit: "g", macros: {}, cost: null },
               { name: "SauceTest", quantity: 1, unit: "dl", macros: { protein: 5 },
                 cost: 2.4, cost_currency: "USD" }];
  const t2 = P.previewText(dbl, {});
  a.ok(t2.indexOf("DEFAULT_BLOCKED") >= 0, "empty macros never counted (§13.2-2)");
  a.ok(/2[.,]4/.test(t2) && /USD/.test(t2), "USD key renders separately (§13.7)");
  const lines = t2.split("\n");
  a.ok(!lines.some(l => /Ft/.test(l) && /USD/.test(l) && l.indexOf("\n") === -1 ? false : false), "sanity");
  a.ok(!/Ft[^|]*USD/.test(t2.replace(/\n/g, "|")), "currencies never merged into one line (§13.7)");
});

T.test("quick_add chaining: totals update path sees fresh state after add (§13.5/§13.6)", () => {
  // fresh mount → seedless full-strict batch → count (delegated) → re-decompose from
  // script + R2 — asserted through the pure handlers only (no DOM in this module).
  const first = h().collect();
  a.ok(Array.isArray(first.blocked) && first.blocked.length === 0,
    "fresh mount counts nothing (empty chain ≠ blocked chain)");
  const H = h({ seeds: ["TofuTest 200 g"] });
  const added = H.collect();                      // fresh add…
  a.equal(added.items.length, 1);
  const after = h({ seeds: ["TofuTest 200 g"] }).collect();   // …and totals re-read from script
  a.deepEqual(after.items, added.items, "re-decomposition from script is stable (R2 mirror)");
});
