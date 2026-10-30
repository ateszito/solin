/* ============================================================
   Solin — app/tests/imgutil.spec.js
   Unit tests for SolinImg nutrition parsing and utility functions.
   Run: node app/tests/imgutil.spec.js
   ============================================================ */
"use strict";

const assert = require("node:assert");
const SolinImg = require("../imgutil.js");

console.log("Testing SolinImg.parseNutrition()...");

// 1. Hungarian standard label
const huLabel = `
Átlagos tápérték 100g termékben:
Energia: 680 kJ / 162 kcal
Zsír: 3,2 g
- amelyből telített zsírsavak: 0,9 g
Szénhidrát: 0,5 g
- amelyből cukrok: 0,1 g
Rost: 1,5 g
Fehérje: 31,0 g
Só: 0,18 g
`;

const resHu = SolinImg.parseNutrition(huLabel);
assert.strictEqual(resHu.calories, 162, "Calories should be 162");
assert.strictEqual(resHu.fat, 3.2, "Fat should be 3.2 (excluding telített 0.9)");
assert.strictEqual(resHu.carbs, 0.5, "Carbs should be 0.5");
assert.strictEqual(resHu.sugar, 0.1, "Sugar should be 0.1");
assert.strictEqual(resHu.fiber, 1.5, "Fiber should be 1.5");
assert.strictEqual(resHu.protein, 31.0, "Protein should be 31.0");
assert.strictEqual(resHu.sodium, 72, "0.18g salt * 400 = 72mg sodium");
console.log("  ✓ Hungarian standard label passed");

// 2. English Nutrition Facts table
const enLabel = `
Nutrition Facts
Amount Per 100g
Calories 250
Total Fat 12g
Saturated Fat 4g
Total Carbohydrate 28g
Dietary Fiber 3g
Total Sugars 5g
Protein 8g
Sodium 450mg
`;

const resEn = SolinImg.parseNutrition(enLabel);
assert.strictEqual(resEn.calories, 250, "Calories should be 250");
assert.strictEqual(resEn.fat, 12, "Fat should be 12");
assert.strictEqual(resEn.carbs, 28, "Carbs should be 28");
assert.strictEqual(resEn.fiber, 3, "Fiber should be 3");
assert.strictEqual(resEn.sugar, 5, "Sugar should be 5");
assert.strictEqual(resEn.protein, 8, "Protein should be 8");
assert.strictEqual(resEn.sodium, 450, "Sodium should be 450");
console.log("  ✓ English nutrition table passed");

// 3. Multi-line split label
const multiLineLabel = `
Tápérték / 100g
Energia
185 kcal
Zsír
5.4 g
amelyből telített zsírsavak
1.2 g
Szénhidrát
15 g
amelyből cukrok
2.1 g
Élelmi rost
3.0 g
Fehérje
18.5 g
Nátrium
120 mg
`;

const resMulti = SolinImg.parseNutrition(multiLineLabel);
assert.strictEqual(resMulti.calories, 185);
assert.strictEqual(resMulti.fat, 5.4);
assert.strictEqual(resMulti.carbs, 15);
assert.strictEqual(resMulti.sugar, 2.1);
assert.strictEqual(resMulti.fiber, 3.0);
assert.strictEqual(resMulti.protein, 18.5);
assert.strictEqual(resMulti.sodium, 120);
console.log("  ✓ Multi-line table layout passed");

// 4. Hungarian Lidl product label (from real photo OCR output)
const lidlHuPhotoOcr = `
készült. Bontatlan csomagolásban, száraz, hűvös helyen, +
minőségét megőtzi (nap/hónap/év): a csomagolás hátolda
Átlagos
Nettó tömeg;
tápértéktartalom
0/100 g
Energia
. 1986 k3/481 kcal
Zsír
4509
amelyből telített
zsírsavak
1809
Szénhidrát.
099
amelyből cukr
029
Rost
09
Fehérje
1809
6
4009
`;

const resLidlHu = SolinImg.parseNutrition(lidlHuPhotoOcr);
assert.strictEqual(resLidlHu.calories, 481, "Lidl calories should be 481");
assert.strictEqual(resLidlHu.fat, 45, "Lidl fat should be 45 (from 4509 -> 45.0g)");
assert.strictEqual(resLidlHu.carbs, 0.9, "Lidl carbs should be 0.9 (from 099 -> 0.9g)");
assert.strictEqual(resLidlHu.sugar, 0.2, "Lidl sugar should be 0.2 (from 029 -> 0.2g)");
assert.strictEqual(resLidlHu.fiber, 0, "Lidl fiber should be 0 (from 09 -> 0g)");
assert.strictEqual(resLidlHu.protein, 18, "Lidl protein should be 18 (from 1809 -> 18.0g)");
assert.strictEqual(resLidlHu.sodium, 1600, "Lidl sodium should be 1600 (4.00g salt * 400 = 1600mg)");
console.log("  ✓ Real Hungarian Lidl photo OCR passed (all 7 macros)");

// 5. English OCR variant of Lidl photo
const lidlEngPhotoOcr = `
Energia
- 1986 k3/481 kcal
Isit
450g
amelybdl telitett
zsitsavak
18,09
cyuy
Szénhidrat
0,99
amelyb6l cukr
0,29
Rost
09
Fehérje
18,09
6
400g
`;

const resLidlEng = SolinImg.parseNutrition(lidlEngPhotoOcr);
assert.strictEqual(resLidlEng.calories, 481);
assert.strictEqual(resLidlEng.fat, 45);
assert.strictEqual(resLidlEng.carbs, 0.9);
assert.strictEqual(resLidlEng.sugar, 0.2);
assert.strictEqual(resLidlEng.fiber, 0);
assert.strictEqual(resLidlEng.protein, 18);
assert.strictEqual(resLidlEng.sodium, 1600);
console.log("  ✓ English OCR variant of Lidl photo passed");

// 6. Delimiter robustness & dropped delimiter tests (45,6 / 45.6 / 45 6 / 456)
const delimiterVariantsLabel = `
Energia: 250 kcal
Zsír: 45,6 g
Fehérje: 18 6 g
Szénhidrát: 0, 9 g
Cukor: 456 g
Rost: 0 g
Só: 4, 00 g
`;
const resDelim = SolinImg.parseNutrition(delimiterVariantsLabel);
assert.strictEqual(resDelim.calories, 250);
assert.strictEqual(resDelim.fat, 45.6, "Comma delimiter 45,6 -> 45.6");
assert.strictEqual(resDelim.protein, 18.6, "Space delimiter 18 6 -> 18.6");
assert.strictEqual(resDelim.carbs, 0.9, "Spaced comma 0, 9 -> 0.9");
assert.strictEqual(resDelim.sugar, 45.6, "Dropped delimiter 456 -> 45.6");
assert.strictEqual(resDelim.fiber, 0);
assert.strictEqual(resDelim.sodium, 1600);
console.log("  ✓ Delimiter variants & dropped decimal recovery passed");

// 7. Format bytes helper
assert.strictEqual(SolinImg.formatBytes(500), "500 B");
assert.strictEqual(SolinImg.formatBytes(1500), "1.5 KB");
assert.strictEqual(SolinImg.formatBytes(5 * 1024 * 1024), "5.0 MB");
console.log("  ✓ formatBytes helper passed");

console.log("ALL SolinImg unit tests passed successfully!");
