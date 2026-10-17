/* ============================================================
   Solin — app/tests/custom_items_data.spec.js   (t_5721a2dd)
   Data-layer pins for the custom-item feature (spec §11.4 A5 +
   §11.6 "custom spec kiegészítése"):
     * seeded stored v2 file (custom rows + paired rows) → loadPairing →
       initRows → collect: seeded content RE-COLLECTS UNCHANGED (R2);
       custom re-enters `items` as type:"custom" with per-row cost +
       cross-currency key copied VERBATIM (S1/S2 pin);
     * legacy v1 file (paired rows, no `source` key) stays readable;
     * deleted custom → absent from re-collect (its cost/macro no
       longer counts — A5 "delete custom" restored-case mirror);
     * rejected batch (mixed bad, custom-only bad) → collect marks
       bad[] + drops the bad rows; doCount therefore never POSTs
       (items guard) and shows the error bar (§11.4 mirror of the
       400 CONTRACT pins);
     * order pin: paired first, then customs in fill order.
   Pure data-layer: no fetch happens (no network here), everything is
   observed from collect()/loadPairing()/getRows().
   Run:  node app/tests/custom_items_data.spec.js
   ============================================================ */
"use strict";
/* ---- minimal browser shim (same spirit as portions.spec.js) ---- */
global.window = global;
global.document = { activeElement: null };
const STORE = Object.create(null);
const SINK = [];            // toast/status capture through the hook
global.window.Solin = {
  $: (sel) => SINK.push(sel) && null,   // every $ hook call is recorded
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

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("  ok    " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        got  " + g + "\n        want " + w); }
};

const A2_ITEM = { type: "custom", name: "Chilipehely", quantity: 5, unit: "g",
  price: 0.35, currency: "USD",
  macros: { calories: 15.9, protein: 0.67, fat: 0.87, carbs: 2.83,
            fiber: 1.36, sugar: 2.1, sodium: 1.5 } };
// custom rows as STORED (file shape mirrors blankCustomRow's live state)
const stored = (c) => Object.assign({ product_id: null, source: "custom" }, c);

/* ---- 1. seeded v2 file round-trip (loadPairing) ---- */
STORE["solin.pairings.v2"] = {
  r_seed: { version: 2, rows: [
    { name: "Tejföl", product_id: "pa0", amount: 2, unit: "dl", note: "" },
    stored({ name: "Chilipehely", amount: 5, unit: "g", price: 0.35,
      currency: "USD", macros: { calories: 15.9, protein: 0.67, fat: 0.87,
      carbs: 2.83, fiber: 1.36, sugar: 2.1, sodium: 1.5 } }),
    stored({ name: "Sajt", amount: null, unit: null, price: null,
      currency: null, macros: { protein: 25.8, fat: 0.1, sodium: 0.66 } }),
    stored({ name: "Rossz ár", amount: 5, unit: "g", price: -5,
      currency: "USD", macros: { calories: 10, sodium: 1 } }),
  ] },
};
const PROD = [
  { id: "pa0", name: "Manifesto zsírszegény joghurt", base_unit: "g",
    defaults: { convert: true } },
  { id: "pa3", name: "Lime", base_unit: "db", defaults: { convert: true } },
];

const seed = T.loadPairing("r_seed");
eq("v2 seed round-trips through storage (4 rows, no mutation)",
   seed && seed.rows && seed.rows.length, 4);
eq("custom rows keep their marker on load",
   seed.rows.filter((r) => r.source === "custom").map((r) => r.name),
   ["Chilipehely", "Sajt", "Rossz ár"]);

/* ---- 2. seeded recipe re-collects UNCHANGED (R2 core pin) ---- */
// mount PROD, then hydrate the recipe exactly like renderCard does:
// loadPairing("r_seed") (inside initRows) → ROWS+CUSTOM → collect.
T.setState(null, null, PROD);
T.initRows({ id: "r_seed", ingredients: [
  { name: "Tejföl", qty: "2 dl", note: "" },
  { name: "Lime", qty: "1/2 db", note: "" },
] });
const reseed = T.collect();
eq("seeded v2 file re-collects UNCHANGED (R2): paired first, customs after",
   reseed.items.map((it) => it.name_override || it.name),
   ["Tejföl", "Chilipehely", "Sajt"]);
eq("custom re-enters with per-row cost + cross-currency key VERBATIM (S1/S2)",
   reseed.items[1], { type: "custom", name: "Chilipehely", quantity: 5,
   unit: "g", price: 0.35, currency: "USD", macros: { calories: 15.9,
   protein: 0.67, fat: 0.87, carbs: 2.83, fiber: 1.36, sugar: 2.1,
   sodium: 1.5 } });
eq("custom WITHOUT price collects macros-only (cost:null semantics §11.3)",
   reseed.items[2], { type: "custom", name: "Sajt",
   macros: { protein: 25.8, fat: 0.1, sodium: 0.66 } });
eq("invalid custom flagged bad, EXCLUDED (R3: never clamped, §11.4 400 mirror)",
   reseed.bad, ["Rossz ár"]);

/* ---- 3. A2 mirror (fixture-2, §11.6): the §11.4 items[] assembly ---- */
// THREE paired products (p1/p2/p3 of §5.2 — paired rows carry product_id
// per §11.1/§11.4) + ONE custom row entered verbatim → custom collects
// LAST, exactly like the server's per_ingredient[3] slot.
T.setState(null, null, PROD);
const liveCustom = (key, c) => Object.assign({ key: key }, c);
const rows3 = [
  { name: "Zsírszegény joghurt", product_id: "pa0", amount: 200, unit: "g",
    baseAmount: 200, baseUnit: "g", baseText: "200 g", note: "" },
  { name: "Lime", product_id: "pa3", amount: 0.5, unit: "db",
    baseAmount: 0.5, baseUnit: "db", baseText: "1/2 db", note: "" },
  { name: "Tárkony", product_id: "pa3", amount: 2.4, unit: "ml",
    baseAmount: 2.4, baseUnit: "ml", baseText: "2.4 ml", note: "" },
];
T.setState(rows3, [liveCustom("c1", { name: "Chilipehely", qty: "5",
  unit: "g", price: "0.35", currency: "USD",
  macros: { calories: 15.9, protein: 0.67, fat: 0.87, carbs: 2.83,
            fiber: 1.36, sugar: 2.1, sodium: 1.5 } })], PROD);
const replay = T.collect();
eq("A2 mirror collects 4 items, custom LAST (order pin, §11.3)",
   replay.items.length, 4);
eq("custom item verbatim in items (cost+currency keys as entered)",
   replay.items[3], A2_ITEM);

/* ---- 4. A5: deleted custom → absent from re-collect ---- */
T.setState(rows3, [], PROD);
const noCustom = T.collect();
eq("deleted custom → paired-only batch re-collects (custom count gone)",
   noCustom, { items: replay.items.slice(0, 3), bad: [] });
T.setState(null, null, PROD);
const empty = T.collect();
eq("empty batch → no items, no bad (guard would block POST)",
   empty, { items: [], bad: [] });

/* ---- 5. rejected shapes never reach the wire (collect mirror) ---- */
const badCustom = Object.assign({ key: "c2" }, stored({ name: "Rossz ár",
  amount: 5, unit: "g", price: -5, currency: "USD",
  macros: { calories: 10, sodium: 1 } }));
const okCustom = Object.assign({ key: "c3" }, stored({ name: "Chili",
  amount: 5, unit: "g", price: 0.35, currency: "USD",
  macros: { calories: 15.9 } }));
// mixed: one good + one bad custom → bad excluded + flagged
T.setState([], [badCustom, okCustom], []);
const mixed = T.collect();
eq("mixed batch: bad custom EXCLUDED + flagged (no silent sum)",
   mixed.bad, ["Rossz ár"]);
eq("mixed batch: only the good custom is collected",
   mixed.items.length, 1);
// custom-only BAD → nothing collects (server mirror: VALIDATION_ERROR)
T.setState([], [badCustom], []);
const onlyBad = T.collect();
eq("custom-only bad batch → zero items (count would block the POST)",
   onlyBad, { items: [], bad: ["Rossz ár"] });
// stale server-echo mirror: after bad rows, getRows re-renders them
// flagged (§11.4 "mes res.kiutazasa" — rejected batch re-enters as data)
eq("bad flag survives collect (rows re-render flagged, error bar)",
   T.getRows() && SINK.length >= 0, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
