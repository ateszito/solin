/* ============================================================
   Solin — tests/scale.spec.js
   Pure unit tests for the scaling engine (app/scale.js),
   run with:  node app/tests/scale.spec.js
   Covers spec §5 worked-example tables, §3 rounding, §4.0
   free-text fallback, §3.1 min-1 rule, and acceptances 1–5,7.
   ============================================================ */
"use strict";

// Minimal browser shim so scale.js (a window.* IIFE) loads under Node.
global.window = global;
require("../scale.js");
const S = global.window.SolinScale;

let pass = 0, fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else {
    fail++;
    console.log(`  FAIL ${label}\n       actual   = ${a}\n       expected = ${e}`);
  }
}
function group(name, fn) { console.log(`\n${name}`); fn(); }

/* Canonical r1 ingredient list (seed shape — free-text qty) */
const R1 = [
  { name: "vöröshagyma", qty: "200 g", note: "apróra vágva" },
  { name: "kolbász", qty: "50 g", note: "apróra vágva" },
  { name: "csirkeemlő", qty: "650 g" },
  { name: "só", qty: "jódag", note: "ízlés szerint" },
  { name: "csili", qty: "kb. 1 db", note: "ízlés szerint" },
  { name: "füstölt paprika", qty: "1 tk" },
  { name: "bors", qty: "½ tk" },
  { name: "fokhagyma", qty: "1-2 gerezd", note: "darálva" },
  { name: "paradicsompüré", qty: "3 evőkanál" },
  { name: "tejszín", qty: "160 g", note: "vagy rizs-tejszín" },
  { name: "víz", qty: "kb. 3 evőkanál", note: "opcionális, öntönységhez" },
  { name: "tészta", qty: "240 g", note: "már FŐTT" },
  { name: "spenót", qty: "80 g", note: "opcionális, de fontos" },
  { name: "parmezán", qty: "40 g", note: "rágratva végül" },
];

group("parseQty — spec §4.0 free-text classifier", () => {
  eq('"650 g"', S.parseQty("650 g").scalable, true);
  eq('"jódag" not scalable', S.parseQty("jódag").scalable, false);
  eq('"1-2 gerezd" not scalable (no midpoint guess)', S.parseQty("1-2 gerezd").scalable, false);
  eq('"½ tk" → 0.5 tk', [S.parseQty("½ tk").amount, S.parseQty("½ tk").unit], [0.5, "tk"]);
  eq('"kb. 3 evőkanál" → 3 evőkanál', [S.parseQty("kb. 3 evőkanál").amount, S.parseQty("kb. 3 evőkanál").unit], [3, "evőkanál"]);
  eq('"to taste" not scalable', S.parseQty("2 to taste").scalable, false);
  eq("numeric+count: '3 gerezd'", [S.parseQty("3 gerezd").amount, S.parseQty("3 gerezd").unit], [3, "gerezd"]);
});

group("roundHalfUp — no banker's drift", () => {
  eq("3.923… → 4 (0dp)", S.roundHalfUp(3.923, 0), 4);
  eq("2.215 → 2.22 (2dp, half-up)", S.roundHalfUp(2.215, 2), 2.22);
  eq("36.923 → 36.92 (2dp)", S.roundHalfUp(36.923, 2), 36.92);
  eq("0.369 → 0.4 (1dp)", S.roundHalfUp(0.369, 1), 0.4);
});

group("scaleIngredient — spec §3 unit classes", () => {
  const f_up = 850 / 650;
  eq("g 2dp: 200×f=261.54", S.scaleIngredient(200, "g", f_up).amount, 261.54);
  eq("g 2dp: 50×f=65.38 (spec UC-07 corrected value)", S.scaleIngredient(50, "g", f_up).amount, 65.38);
  eq("g 2dp: 160×f=209.23", S.scaleIngredient(160, "g", f_up).amount, 209.23);
  eq("gerezd whole: 3×f=4", S.scaleIngredient(3, "gerezd", f_up).amount, 4);
  eq("evőkanál 1dp: 3×f=3.9", S.scaleIngredient(3, "evőkanál", f_up).amount, 3.9);
  eq("tk 1dp: 1×f=1.3", S.scaleIngredient(1, "tk", f_up).amount, 1.3);
  const f_dn = 480 / 650;
  eq("downscale g: 50×f=36.92", S.scaleIngredient(50, "g", f_dn).amount, 36.92);
  eq("downscale g: 40×f=29.54 (spec UC-07 corrected value)", S.scaleIngredient(40, "g", f_dn).amount, 29.54);
  eq("downscale gerezd: 3×f=2", S.scaleIngredient(3, "gerezd", f_dn).amount, 2);
  eq("downscale ½ tk: 0.5×f=0.4 (NOT min-1 — liquid class)", S.scaleIngredient(0.5, "tk", f_dn).amount, 0.4);
  eq("min-1 count: 0.4×0.5=0.2 → 1 (spec §3.1)", S.scaleIngredient(0.4, "gerezd", 0.5).amount, 1);
  eq("manual pass-through", S.scaleIngredient(2, "to taste", 1.5), { amount: 2, unit: "to taste", manual: true });
});

group("scaleRecipe — r1 @ 850 g (spec §5.1 table)", () => {
  const r = S.scaleRecipe(R1, "csirkeemlő", 850);
  const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
  eq("factor ≈ 1.3077", Math.round(r.factor * 1e4) / 1e4, 1.3077);
  eq("anchor shows exactly 850", byName["csirkeemlő"].amount, 850);
  eq("vöröshagyma 261.54", byName["vöröshagyma"].amount, 261.54);
  eq("kolbász 65.38", byName["kolbász"].amount, 65.38);
  eq("tejszín 209.23", byName["tejszín"].amount, 209.23);
  eq("parmezán 52.31", byName["parmezán"].amount, 52.31);
  eq("tészta 313.85", byName["tészta"].amount, 313.85);
  eq("spenót 104.62", byName["spenót"].amount, 104.62);
  eq("paradicsompüré 3.9 evőkanál", byName["paradicsompüré"].amount, 3.9);
  eq("füstölt paprika 1.3 tk", byName["füstölt paprika"].amount, 1.3);
  eq("só manual, base kept", [byName["só"].manual, byName["só"].amount], [true, null]);
  eq("csili manual per spec §4 (kb. 1 db — approximate)", byName["csili"].manual, true);
  eq("seed data NOT mutated (acceptance 5)", R1[0].qty, "200 g");
});

group("scaleRecipe — r1 @ 480 g (spec §5.2 table)", () => {
  const r = S.scaleRecipe(R1, "csirkeemlő", 480);
  const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
  eq("kolbász 36.92", byName["kolbász"].amount, 36.92);
  eq("parmezán 29.54", byName["parmezán"].amount, 29.54);
  eq("fokhagyma manual (range 1-2)", byName["fokhagyma"].manual, true);
  eq("bors 0.4 tk", byName["bors"].amount, 0.4);
});

group("scaleRecipe — invalid inputs", () => {
  const r = S.scaleRecipe(R1, "csirkeemlő", 0);
  eq("available=0 → factor 1, nothing scaled", r.factor, 1);
  const r2 = S.scaleRecipe(R1, "nem-lévő", 850);
  eq("unknown anchor → factor 1", r2.factor, 1);
});

group("selectAnchors — spec §2.1 heuristic", () => {
  eq("first anchor = largest mass (csirkeemlő)", S.selectAnchors(R1)[0], "csirkeemlő");
  const order = S.selectAnchors(R1);
  eq("mass rows sorted desc", order, ["csirkeemlő", "tészta", "vöröshagyma", "tejszín", "spenót", "kolbász", "parmezán"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
