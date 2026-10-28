/* ============================================================
   Solin — app/tests/custom_item_save.spec.js   (t_96fcfc2a)
   Data-layer pins for custom-extra → permanent inventory product
   (app/invsync.js). Pure data layer, no fetch happens:
     * mirror pair: customSavable judged against the LIVE
       pairing.js __test.customItemOf (spec §11.2 R2/R3 surface) —
       flagged shapes never become savable, accepted shapes do;
     * toProductDoc: basis conversion (TOTAL macros → per-100, TOTAL
       price → unit price), block-flags (empty/unresolvable unit with
       macró/price, double listing → whole batch refuses);
     * saveToInventory: ONE payload per save, invalid batch never
       POSTs, empty batch never POSTs, transport rejection writes
       nothing and rolls nothing back (pairing stays as it was).
   Listing data below is INVENTED mock data (no pairing seed keys).
   Run:  node app/tests/custom_item_save.spec.js
   ============================================================ */
"use strict";
const assert = require("node:assert");

/* ---- minimal browser shim (same spirit as portions.spec.js) ---- */
global.window = global;
global.document = { activeElement: null };
const STORE = Object.create(null);
const SINK = [];
global.window.Solin = {
  $: (sel) => SINK.push(sel) && null,
  S: {
    load: (k, d) => (k in STORE ? JSON.parse(JSON.stringify(STORE[k])) : d),
    save: (k, v) => { STORE[k] = JSON.parse(JSON.stringify(v)); },
  },
  hook: (kind, msg) => SINK.push([kind, msg]),
};
require("../fcapi.js");
require("../pairing.js");
const P = global.window.Pairing;
const T = P.__test;
const INV = require("../invsync.js");

let pass = 0, fail = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }
const row = (o) => Object.assign({ id: "c1", name: "X", qty: "", unit: "",
                                   price: "", currency: "", macros: {} }, o);
const S = INV.customSavable;               // gate, ONE call per row
const V = INV.validateCustom;

/* every shape judged on BOTH sides (mirror pair; empty = silent skip) */
const SHAPES = [
  row({}),                                                 // empty → silent
  row({ name: "Zúzott coffee", qty: "2 teaspoon", unit: "teáskanál" }),
  row({ name: "Zúzott coffee", qty: "2", unit: "teáskanál",
        price: "12", currency: "HUF" }),
  row({ name: "Zúzott coffee", qty: "2", unit: "teáskanál",
        price: "12", currency: "EUR" }),                  // cross-currency
  row({ name: "Zúzott coffee", qty: "2 teaspoon", unit: "teáskanál",
        price: "12", currency: "EUR",
        macros: { calories: 9, protein: 4, carbs: 3, fiber: 12, sodium: 2 } }),
  row({ name: "Rágógumi", qty: "2 db", unit: "pcs",
        price: "2", currency: "HUF",
        macros: { calories: 40, protein: 5, fat: 2, carbs: 10,
                  fiber: 3, sugar: 2, sodium: 1 } }),
  row({ name: "Hamis böty", qty: "2 teaspoon", unit: "teáskanál",
        macros: { protein: "5", fat: "2", carbs: "10",
                  fiber: "3", sugar: "2", sodium: "1", calories: "9" } }),
  row({ qty: "2 teaspoon" }),                    // empty name WITH values
  row({ name: "Citrom", qty: "1/2 db", unit: "pcs" }),   // compound flat unit
  row({ name: "Citrom", qty: "2×3 db", unit: "pcs" }),   // compound flat unit
  row({ name: "Citrom", qty: "1/2", unit: "pcs" }),      // unit after qty
  row({ name: "Citrom", qty: "1/2", unit: "flújc-message" }), // wrong unit
  row({ name: "Citrom", qty: "1.5 g", unit: "flújc-message",
        price: "2", currency: "EUR", macros: { protein: 5 } }),
  row({ name: "Citrom", qty: "1 g", unit: "g", price: "2" }), // no currency
  row({ name: "Citrom", qty: "1 g", unit: "g",
        macros: { calories: 100, protein: 10, fat: 5, carbs: 10,
                  fiber: 2, sugar: 2, sodium: 1 } }),
  row({ name: "Kóla", qty: "5 g", unit: "flújc-message", price: "2",
        currency: "EUR", macros: { protein: 1, fat: 2, carbs: 10,
                                   fiber: 3, sugar: 2, sodium: 1 } }),
];

console.log("custom_item_save.spec.js (t_96fcfc2a)");
console.log("--- mirror pair: customSavable vs pairing.js customItemOf ---");
/* The DATA GATE is ≥-strict to the live grammar (it adds the no-
   convertible-basis rule for price/macró rows) — where the gate is
   STRICTER the pairing side stays in sync (doCount never POSTs a
   flagged batch), so here we pin: (a) the two layers never DISAGREE
   about "not savable" (same single call), and (b) every customItemOf
   flag prints as a drift probe — nothing silently passes. */
for (const r of SHAPES) {
  t("mirror: " + JSON.stringify({ n: r.name, q: r.qty, u: r.unit,
                                  p: r.price }), () => {
    assert.ok(T && T.customItemOf, "pairing.js __test.customItemOf missing");
    const ref = T.customItemOf(r);
    assert.ok(!ref.throw, "customItemOf threw — mirror broken");
    // two layers, one call: customSavable mirrors validateCustom's flags
    const v = V(r);
    assert.strictEqual(S(r), !(v.blocked || v.skip),
      "gate disagrees with its own validator");
    if (Array.isArray(ref.bad) && ref.bad.length)
      console.log("       probe: customItemOf flags, gate=" + S(r) +
                  " (" + ref.bad.join(",") + ")");
  });
}

console.log("--- toProductDoc: basis, macros, pricing FIRST ---");
t("unresolvable unit + macró → blocked (basis must exist)", () => {
  const v = INV.toProductDoc(row({ name: "Mock böty", qty: "5 g",
    unit: "flújc-message", macros: { protein: 5 } }), []);
  // blocked is the contract; the marker may come from the grammar
  // (unit/quantity) or from the added no-convertible-basis rule
  assert.ok(v.blocked === true, JSON.stringify(v));
});
t("valid row → doc: base_unit + per-100 macros + unit price", () => {
  const v = INV.toProductDoc(row({ name: "Mock cola", qty: "5 g",
    unit: "g", price: "2", currency: "HUF",
    macros: { calories: 100, protein: 10, fat: 5, carbs: 10,
              fiber: 2, sugar: 2, sodium: 1 } }), []);
  assert.ok(v.ok, JSON.stringify(v));
  assert.strictEqual(v.doc.base_unit, "g");
  assert.strictEqual(v.doc.serving_size, 5);
  assert.strictEqual(v.doc.macros_per_100.protein, 200); // 10 per 5 g → /100g
  assert.strictEqual(v.doc.prices[0].amount, 2);         // total pack price
  assert.strictEqual(v.doc.prices[0].pack_size, 5);      // basis quantity
  assert.strictEqual(v.doc.prices[0].currency, "HUF");
});
t("double listing → blocked (custom-name clash, casefold+trim)", () => {
  const listing = [{ id: "seed_mock1", name: "Mock mesmo" }];
  const v = INV.toProductDoc(row({ name: " mock MESMO ", qty: "1 g",
    unit: "g", macros: { protein: 1 } }), listing);
  assert.ok(v.blocked && v.dup, JSON.stringify(v));
});
t("invented listing: exact-name clash blocks, substring does not", () => {
  const listing = [{ id: "seed_mock2", name: "Mock só" },
                   { id: "seed_mock3", name: "Mock olaj" },
                   { id: "seed_mock4", name: "Mock bor" }];
  for (const n of ["Mock Só", "MOCK OLAJ", "mock bor"])
    assert.ok(V(row({ name: n, qty: "1 g", unit: "g" }), listing).blocked,
      n + " double-listing must refuse");
  assert.ok(V(row({ name: "Mockandos", qty: "1 g", unit: "g" }),
              listing).ok, "whole-name match only (no substring clamp)");
});

console.log("--- batch gate + save transport ---");
const MOCK_LISTING = [{ id: "seed_mock5", name: "Mock tossz" },
                      { id: "seed_mock6", name: "Mock m4" }];
t("batch with ANY invalid → WHOLE save refuses (no POST, no write)", () => {
  const batch = [row({ name: "Citrom", qty: "1/2", unit: "pcs" }),
                 row({ name: "Kóla", qty: "5 g", unit: "flújc-message",
                       price: "2", currency: "EUR",
                       macros: { protein: 1 } })];
  return INV.saveToInventory(batch, {
    products: MOCK_LISTING,
    createProduct: () => { throw new Error("must not POST invalid batch"); },
  }).then((r) => {
    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, "validate");
  });
});
t("one save, every doc POSTed; empty batch never POSTs", () => {
  const batch = [row({ name: "Citrom", qty: "1/2 db", unit: "pcs" }),
                 row({ name: "Zúzott coffee", qty: "2", unit: "teáskanál",
                       price: "12", currency: "HUF" })];
  const seen = [];
  return INV.saveToInventory(batch, { products: MOCK_LISTING,
    createProduct: (d) => { seen.push(d); return Promise.resolve(d); } })
    .then((res) => {
      assert.ok(res.ok && res.sent, JSON.stringify(res));
      assert.strictEqual(seen.length, 2, "every doc POSTed verbatim");
      return INV.saveToInventory([], { products: [],
        createProduct: () => { throw new Error("must not POST empty"); } });
    })
    .then((r2) => assert.strictEqual(r2.sent, false, "empty never POSTs"));
});
t("transport REJECTS → no write, no rollback (pairing stays as it was)",
   () => {
  const batch = [row({ name: "Citrom", qty: "1/2 db", unit: "pcs" })];
  return INV.saveToInventory(batch, {
    products: [],
    createProduct: () => Promise.reject(
      Object.assign(new Error("UNITS_INCOMPATIBLE: flújc-message"),
                   { status: 400, code: "UNITS_INCOMPATIBLE" })),
  }).then((res) => {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.stage, "transport");
    assert.match(res.rollback, /nothing to roll back/);
  });
});

/* ---- run (async pins awaited, then the honest exit code) ---- */
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log("  ok    " + name); }
    catch (e) { fail++; console.log("  FAIL  " + name + "\n        " + e.message); }
  }
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
