/* ============================================================
   Solin — app/tests/custom_items.spec.js  (t_a411a23e, spec §11)
   Pure unit tests for the custom "egyéb hozzávaló" row layer:
   customItemOf() validation + the API item shape (§11.2 R2/R3,
   §11.4) and one per-portion math check on totals that INCLUDE
   a custom row (fixture-2 path). Run with:
       node app/tests/portions.spec.js && node app/tests/custom_items.spec.js
   ============================================================ */
"use strict";

/* ---- browser shims so the window.* IIFEs load under Node ---- */
global.window = global;
global.document = { activeElement: null };
global.window.Solin = {
  $: () => null,
  $$: () => [],
  S: { load: (k, d) => d, save: () => {} },
  esc: (s) => String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  toast: () => {},
};
require("../fcapi.js");
require("../pairing.js");
const T = global.window.Pairing.__test;

let pass = 0, fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else {
    fail++;
    console.log(`  FAIL  ${label}\n        actual   = ${a}\n        expected = ${e}`);
  }
}

/* ---- fixture-2 custom row (spec §11.6 A2), typed verbatim ---- */
const A2 = Object.assign(T.blankCustomRow(), {
  name: "Chilipehely", qty: "5", unit: "g", price: "0.35", currency: "USD",
  macros: { calories: "15.90", protein: "0.67", fat: "0.87", carbs: "2.83",
            fiber: "1.36", sugar: "2.10", sodium: "1.50" },
});

console.log("\ncustomItemOf — valid shapes");
{
  const r = T.customItemOf(A2);
  eq("A2 is valid (no bad fields)", r.bad, undefined);
  eq("A2 item is verbatim (7 macro keys, totals-as-typed)", r.item, {
    type: "custom", name: "Chilipehely", quantity: 5, unit: "g",
    price: 0.35, currency: "USD",
    macros: { calories: 15.9, protein: 0.67, fat: 0.87, carbs: 2.83,
              fiber: 1.36, sugar: 2.1, sodium: 1.5 },
  });
}
{
  // name-only row is VALID (§11.4: name required, everything else optional)
  const r = T.customItemOf(Object.assign(T.blankCustomRow(), { name: "Só" }));
  eq("name-only row → item without quantity/price/macros", r.item, {
    type: "custom", name: "Só",
  });
}
{
  // A2 repeat with HUF price (the §11.6 A2 currency-split repeat) —
  // currency normalized to uppercase → passes the §4.3 grammar server-side
  const r = T.customItemOf(Object.assign(T.blankCustomRow(), {
    name: "Chilipehely", qty: "5", unit: "g", price: "1.20", currency: "huf",
  }));
  eq("lowercase currency is uppercased, not rejected", r.item.currency, "HUF");
}

console.log("\ncustomItemOf — invalid shapes are excluded, never clamped (R3)");
eq("totally blank row → blank (silently skipped)",
   T.customItemOf(T.blankCustomRow()), { blank: true });
eq("empty name + values → bad [name] (excluded, NOT sent, not repaired)",
   T.customItemOf(Object.assign(T.blankCustomRow(), { name: "", qty: "5", macros: { sodium: "1.5" } })),
   { bad: ["name"], name: "(név nélkül)" });
eq("negative price → bad [price]",
   T.customItemOf(Object.assign(T.blankCustomRow(), { name: "X", price: "-5" })).bad,
   ["price"]);
eq("\"abc\" macro → bad [calories]",
   T.customItemOf(Object.assign(T.blankCustomRow(), { name: "X", macros: { calories: "abc" } })).bad,
   ["calories"]);
eq("macro >9999 → bad",
   T.customItemOf(Object.assign(T.blankCustomRow(), { name: "X", macros: { protein: "10000" } })).bad,
   ["protein"]);
eq("name >80 chars → bad [name]",
   T.customItemOf(Object.assign(T.blankCustomRow(), { name: "x".repeat(81), price: "1" })).bad,
   ["name"]);

console.log("\nper-portion math over TOTALS THAT INCLUDE the custom row");
{
  // §11.6 A2 fixture totals (paired rows + Chilipehely, sum-of-rounded §4.2)
  const totals = { calories: 783.30, protein: 70.57, fat: 18.97, carbs: 81.63,
                   fiber: 3.46, sugar: 2.20, sodium: 151.50 };
  const pp = T.perPortionOf(totals, 4);
  eq("783.30/4 → 195.83 (HALF_UP)", pp.calories, 195.83);
  eq("70.57/4 → 17.64", pp.protein, 17.64);
  eq("151.50/4 → 37.88", pp.sodium, 37.88);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
