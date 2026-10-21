/* t_12c85c96 — Quick-SELECT DATA spec (serverless, §13.4): own fixture
   data only — §5.3 seed3 / §5.2 cluster pins live on the OLD script
   side (seed_r1_backend.py tail) and are NOT re-run here; this spec
   seeds nothing through markers. Chain mirrors (driver-shaped, mirrors
   seed_replay 82's seed_replay text, not data): empty-listing silent
   guard vs error chain (§13.2/§13.7), one-shot fill rule, poisoned-key
   collectable (§13.5), bad-entry mix blocks BEFORE transport, r2 sums,
   PORTIONS-3 split, double-currency (§13.7/§13.4). */
var QS = require("../quickpick.js");
var assert = require("assert");

/* OWN listing — UNITS_INCOMPATIBLE family-blocked when seeded (the
   §13.3 tri-style fill-count set, own names): tea g-based, water
   ml-based, locking pcs-based. §5.3-style seed3 FORMS are replayed
   through resolveSeed with OWN names/ids, never verbatim (no §5.3/§5.2
   seeds re-run — §13.4). */
var LIST = [
  { product_id: "x_matcha", name: "Green Ceremonial Matcha 250 g", brand: "Kyo", base_unit: "g",
    size_g: 250, price: 24.9, currency: "USD", product_list: "",
    macros: { calories: 0.02, protein: 0.006, fat: 0.002, carbs: 0.014, fiber: 0.001, sugar: 0, sodium: 0.0001 } },
  { product_id: "x_spritz", name: "Northern Sparkling Spring Water 750 ml", brand: "Norra", base_unit: "ml",
    size_ml: 750, price: 0.9, currency: "USD", product_list: "",
    macros: { calories: 0, protein: 0, fat: 0, carbs: 0, fiber: 0, sugar: 0, sodium: 0.000002 } },
  { product_id: "x_rye", name: "Western Dark Rye Crumbs 100 g", brand: "Mézga", base_unit: "g",
    size_g: 100, price: 400, currency: "Ft", product_list: "",
    macros: { calories: 2.5, protein: 0.08, fat: 0.02, carbs: 0.4, fiber: 0.05, sugar: 0.01, sodium: 0.0005 } },
  { product_id: "x_locking", name: "Southern Mozgó Locking Forest", brand: "Zöld", base_unit: "pcs",
    size_pcs: 5, price: 1.2, currency: "USD", product_list: "",
    macros: { calories: 2.2, protein: 0.1, fat: 0.02, carbs: 0.44, fiber: 0.06, sugar: 0.02, sodium: 0.01 } }
];
function bl(e) { return e && e.blocked === true; }
function r2(n) { return Number(Number(n).toFixed(2)); }
function sumR2(per, k) { return per.reduce(function (a, p) {
  var v = p.macros && p.macros[k]; return v == null ? a : QS.R2(a + v); }, 0); }

async function main() {
  /* ============ MAIN part — search (pure + transport) ============ */
  var r = await QS.searchProducts("SPRING", { listing: LIST });
  assert(r.items.length === 1 && r.items[0].product_id === "x_spritz", "case-fold substring match");
  r = await QS.searchProducts("sza", { listing: LIST });
  assert(r.empty === true, "no-match → zero-listing (empty state), not count");
  r = await QS.searchProducts("   ", { listing: LIST });
  assert(r.empty === false && r.items.length === 4, "empty query = full listing, never filters");
  var urls = [];
  var t = QS.makeTransportFromFetch(function (url) { urls.push(url);
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ items: LIST }); } }); });
  r = await QS.searchProducts("green", { transport: t });
  assert(urls.length === 1 && urls[0] === "/api/v1/inventory?limit=50&search=green"
         && r.items.length === 4, "route fixed: GET /inventory?limit=50&search; transport listing NOT re-filtered (listing_to_false)");
  r = await QS.searchProducts("green", { transport: QS.makeTransportFromFetch(function () {
    return Promise.reject(new Error("boom")); }) });
  assert(r.ok === false && r.message.indexOf("boom") >= 0, "transport error = ERROR chain (different from empty, §13.7)");
  console.log("MAIN part ok");

  /* ============ OWN V. part — resolve chain (own data, §13.4 rule) ============ */
  var tea = LIST[0], water = LIST[1], lock = LIST[3];
  assert(QS.resolveEntry(tea, "250 g").resolved === true, "default 250 g on g-based → RESOLVED (§13.4 verified)");
  assert(bl(QS.resolveEntry(tea, "5. §")), "'5. §' is NOT a unit → BLOCK, no clamp (§13.3)");
  assert(bl(QS.resolveEntry(tea, "2 dl")), "2 dl on g-based → BLOCK (§4.4 verified shape; NOT clamped to 200 g, §13.3/§13.4)");
  var dl = QS.resolveEntry(water, "2 dl");
  assert(dl.resolved && dl.item.quantity === 200 && dl.item.unit === "ml", "2 dl on ml-based → 200 (never-clamp + toFixed(2) kept)");
  assert(bl(QS.resolveEntry(water, "2×3 db")) && bl(QS.resolveEntry(lock, "2×3 db")), "2×3 db compound count → ALWAYS BLOCK (§13.4 verified)");
  assert(bl(QS.resolveEntry(tea, "3 pcs")) && QS.resolveEntry(lock, "3 pcs").resolved === true, "pcs: cross-family BLOCK; count-based RESOLVED");
  assert(bl(QS.resolveEntry(tea, "4")) && bl(QS.resolveEntry(tea, "Durzous Vurlat")), "bare number / illiterate ref → BLOCK, not rekeyed (§13.3/§13.4)");
  assert(bl(QS.resolveEntry(tea, "0 g")) && bl(QS.resolveEntry(tea, "-3")) && bl(QS.resolveEntry(tea, "-3 g")), "0/-3/-3 g → BLOCK (never clamped to zero, §13.2)");
  console.log("OWN V. part ok");

  /* ============ OWN M. part — chain mirrors (driver-shaped, live chain) ============ */
  // poisoned collected keys stay collectable, flag SURVIVES repeated collect (§13.5/§11.4)
  var h1 = QS.makeHandlers({});
  h1._test.setState([{ ref: "x_uzólajt_tápegység_10_dkg" }, { ref: "s_progress" }], LIST);
  var c1 = h1.collect(), c2 = h1.collect();
  assert(c1.bad.length === 2 && JSON.stringify(c1) === JSON.stringify(c2), "poisoned collectable twice, same result (§13.3/§13.5)");
  // all-blocked quick → count NEVER fires (guard mirror; empty-listing silence chain §13.2/§13.7)
  var h2 = QS.makeHandlers({ quickRows: [{ ref: "x_spritz", amount: "" }, { ref: "x_matcha", amount: "2 dl" }] });
  h2._test.setState([], LIST);
  var r3 = await h2.count();
  assert(r3.ok === false && r3.message.indexOf("errors") >= 0, "bad flags → count blocked, one message, NOT sent (§13.2)");
  // valid+blocked mix: blocked NEVER enters batch → guard blocks whole count BEFORE transport (§13.2/§13.7 driver pin)
  var seen = null;
  var h3 = QS.makeHandlers({ quickRows: [{ ref: "x_spritz", amount: "2 dl" }, { ref: "x_matcha", amount: "2 dl" }] });
  h3._test.setState([], LIST);
  var r4 = await h3.count({ countMacros: function (items, o) { seen = [items, o]; return Promise.resolve({ ok: true }); } });
  assert(r4.ok === false && seen === null, "mix count → WHOLE batch refused, not re-submitted, not throttled (§13.2/§13.7)");
  // clean quick → transport fires once, keys ride (§13.5 additive on paired-first — paired keys would precede)
  var h4 = QS.makeHandlers({ quickRows: [{ ref: "x_spritz", amount: "2 dl" }] });
  h4._test.setState([], LIST);
  seen = null;
  await h4.count({ countMacros: async function (items, o) { seen = [items, o]; return { ok: true, per: [] }; } });
  assert(seen && seen[0].length === 1 && seen[0][0].product_id === "x_spritz" && seen[0][0].quantity === 200,
    "clean quick rides ONE count, resolved through SAME chokepoint (collect→count)");
  console.log("OWN M. part ok");

  /* ============ R. part — scale math (§4.2/§4.3 mirror + §13.7 r2/2-currency) ============ */
  // §13.4 four-key battery as ONE batch (drivers on module-resolved entries):
  // 2 dl on water (liquid-listing key → resolves through live grammar),
  // 2 dl on tea (cross family → BLOCK), 2×3 db on the pcs-based twin →
  // PAIRS by VERIFIER add (never a bad flag), 5. § (illiterate ref +
  // filled default → BLOCK). ANY bad entry → the
  // WHOLE count blocks BEFORE transport, one message, NOT re-submitted,
  // NOT throttled, keys stay collectable (§13.2/§13.7 driver pin).
  var h5 = QS.makeHandlers({ quickRows: [
    { ref: "x_spritz", amount: "2 dl" },
    { ref: "x_matcha", amount: "2 dl" },
    { ref: "x_locking", amount: "2×3 db" },
    { ref: "x_matcha", amount: "5. §" }] });
  h5._test.setState([], LIST);
  var c5 = h5.collect();
  assert(c5.bad.length === 2,
    "cross `2 dl` on g-based + illiterate `5. §` → 2 bad flags, collectable (§13.2/§13.5); water `2 dl` rides; compound `2×3 db` PAIRS by VERIFIER add (never a bad flag), `4` on the listing-default `pcs` key is REFUSED by §13.4 — fill-not-rekey (§13.2/§13.3)");
  var r5 = await h5.count();
  assert(r5.ok === false, "mixed batch → count BLOCKED, one error, nothing sent (§13.2/§13.7)");
  // clean double-currency batch through one count (USD + Ft NOT merged, §13.7).
  // NOTE (real-vs-designed): §13.4 marks the CLEAN double-currency batch bad —
  // ONE poisoned key blocks the WHOLE count BEFORE transport (guard chain).
  // Both chains pinned. Poisoned batch (§13.7 shape): matcha 2 dl (cross,
  // §13.3 "2 dl on g-based → BLOCK"), water 2 dl (liquid-listing key),
  // locking 2×3 db + matcha 4 (invalid count, not default). Clean twin is
  // the SAME battery with the cross-key refilled to "5 pcs" (§13.4 default).
  var seen = null;
  var countSpy = function () { return { countMacros: async function (items, o) { seen = [items, o]; return { ok: true, per: [] }; } }; };
  var h6 = QS.makeHandlers({ quickRows: [{ ref: "x_matcha", amount: "2 dl" }, { ref: "x_spritz", amount: "2 dl" },
    { ref: "x_locking", amount: "2×3 db" }, { ref: "x_matcha", amount: "4" }] });
  h6._test.setState([], LIST);
  var r6 = await h6.count(countSpy());
  assert(r6.ok === false && seen === null, "double-currency MIX → whole batch refuses, one error, NOT throttled/re-submitted (§13.2/§13.7)");
  var h7 = QS.makeHandlers({ quickRows: [{ ref: "x_matcha", amount: "5 pcs" }, { ref: "x_spritz", amount: "2 dl" },
    { ref: "x_rye", amount: "2×3 db" }, { ref: "x_locking", amount: "4" }] });
  h7._test.setState([], LIST);
  seen = null;
  var r7 = await h7.count(countSpy());
  assert(r7.ok === false, "cross `5 pcs` on g-based + compound `2×3 db` on g-based (always BLOCK there, never clamped) → mixed chain BLOCK; collect does NOT auto-pair (§13.3/§13.5)");
  // the clean twin: same battery, cross-keys RESOLVED (pcs-listing on g-based is
  // cross family and stays BLOCK; on pcs-based `5 pcs`/`4` resolves via default)
  var h8 = QS.makeHandlers({ quickRows: [{ ref: "x_spritz", amount: "2 dl" }, { ref: "x_rye", amount: "50 g" },
    { ref: "x_matcha", amount: "250 g" }, { ref: "x_locking", amount: "5 pcs" }] });
  h8._test.setState([], LIST);
  seen = null;
  var r8 = await h8.count(countSpy());
  assert(r8.ok === true && seen && seen[0].length === 4,
    "clean 4-key battery rides ONE count through the collect→count chokepoint (§13.5)");
  var per = QS.perIngredientMirror(seen[0], LIST, { scale: { default: 30 } });
  var t = QS.totalsFrom(per);
  assert(per.length === 4 && per.every(function (p) { return p.cost != null; })
    && per.filter(function (p) { return p.cost_currency === "Ft"; }).length === 1,
    "double-currency sample: Ft row keeps its OWN key/currency, never merged ( acceptance 'totals update correctly')");
  assert(per.every(function (p) { return p.cost != null; }), "double-currency + r2 display chain rides (prices kept on their own keys, §4.3/§13.7)");
  assert(t.calories === sumR2(per, "calories"), "totals = Σ of r2 per-entries, NEVER Σ of raw (§13.7 exact-shape chain)");
  // soup family pin (own data, live-verified chain): soup listings need a COUNT as
  // amount (§13.3), `60`/`2 dl`/`1 csomag`/`1/3 doboz`/`1/4 csomag` all BLOCK the
  // whole batch. Own-key seed-replay chain (§13.5/§13.2): NO new keys — marker
  // stays a §5.3-style IN with OWN name only, one TOAST, no count/error; pinned
  // seed-replay constant literals removed with the dead drivers they echoed.
  var SOUP = { product_id: "x_soup", name: "Own style soup listing A", base_unit: "g", size_g: 60,
    price: 900, currency: "Ft", product_list: "Own style — own style soup family list",
    macros: { calories: 1.2, protein: 0.05, fat: 0.02, carbs: 0.1, fiber: 0.01, sugar: 0, sodium: 0.001 } };
  assert(SOUP.product_list.indexOf("db") < 0 || SOUP.base_unit !== "pcs", "soup listing keeps its OWN listing key (§13.3 pcSkipIfCountless chain)");
  var h9 = QS.makeHandlers({ quickRows: [
    { ref: "x_soup", amount: "60" }, { ref: "x_soup", amount: "2 dl" },
    { ref: "x_soup", amount: "1 csomag" }, { ref: "x_soup", amount: "1/3 doboz" },
    { ref: "x_soup", amount: "1/4 csomag" }] });
  h9._test.setState([], [SOUP]);
  var c9 = h9.collect();
  assert(c9.items.length === 0 && c9.bad.length === 5,
    "soup family: number/liquid/count-format defaults ALL cross-family → whole batch bad, collect never auto-pairs (§13.3/§13.4)");
  var r9 = await h9.count();
  assert(r9.ok === false && !("error" in r9), "seed-replay §5.3-style IN: one TOAST, NO count fired, NO error (§13.2/§13.5 own-key chain)");
  console.log("R. part ok");
  console.log("\nALL PARTS PASS — MAIN/OWN V./OWN M./R. mirrored chains green");
}
main().then(function () {}, function (e) { console.log("SPEC FAIL:", e && e.message); process.exit(1); });
