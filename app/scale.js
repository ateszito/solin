/* ============================================================
   Solin v3 — scale.js
   Recipe scaling engine (frontend, per docs/design/RECIPE_SCALING.md).

   Canonical model (spec §2–§4):
     f = available / anchor.base          (exact, never rounded mid-way)
     new  = base * f  → ROUND_HALF_UP per unit class:
       mass   (g, kg, mg)          → 2 decimals
       liquid (ml, l, cup, tbsp, tsp) → 1 decimal
       count  (gerezd, db, szelet, fej, tojás, darab, szál, gombóc)
                                            → whole number, min 1
       non-parseable free text     → base unchanged, "manual" flag

   The seed (app/data.js) still carries free-text `qty` strings, so this
   module owns its OWN lenient parser for those legacy rows (spec §4.0):
   anything it cannot split into a clean number+unit is left untouched
   and flagged manual — it never guesses midpoints of ranges.

   Everything here is pure (no DOM, no network): the API-client piece
   also lives here, with an automatic same-origin fallback to the
   local engine on network failure, per the spec §7 table
   ("frontend-logika, backend nem számol").
   ============================================================ */
window.SolinScale = (function () {
  "use strict";

  /* ------------------------------------------------------------
     Unit classes — spec §3 canonical table.
     ------------------------------------------------------------ */
  const MASS   = ["g", "kg", "mg"];                     // → 2 decimals
  const LIQUID = ["ml", "l", "cup", "tbsp", "teáskanál", "tk", "evőkanál"]; // → 1 decimal
  const COUNT  = ["gerezd", "db", "szelet", "fej", "tojás", "tojás", "darab", "szál", "gombóc"]; // → whole, min 1

  function unitClass(unit) {
    const u = String(unit || "").trim().toLowerCase();
    if (MASS.includes(u))   return "mass";
    if (LIQUID.includes(u)) return "liquid";
    if (COUNT.includes(u))  return "count";
    return "other"; // → manual (to taste / pcs / free text)
  }

  /* ------------------------------------------------------------
     ROUND_HALF_UP (spec: "ROUND_HALF_UP, per-unit tizedes" —
     NOT the default half-to-even).  JS Math.round is half-up
     for positive values; we add the smallest EPSILON bump to
     counter float drift at exact midpoints (e.g. a decimal like
     2.215 stored as 2.2149999… still rounds up).
     ------------------------------------------------------------ */
  function roundHalfUp(value, decimals) {
    const f = Math.pow(10, decimals);
    return Math.round((value + Number.EPSILON) * f) / f;
  }

  /* ------------------------------------------------------------
     Scale ONE ingredient (pure).
     base  : the BASE amount (number).
     f     : the scale factor (number, > 0).
     unit  : unit string.
     Returns { amount: number, unit: string, manual: false }
     ------------------------------------------------------------ */
  function scaleIngredient(base, unit, f) {
    const cls = unitClass(unit);
    let scaled;
    if (cls === "mass") {
      scaled = roundHalfUp(base * f, 2);
    } else if (cls === "liquid") {
      scaled = roundHalfUp(base * f, 1);
    } else if (cls === "count") {
      scaled = Math.max(1, roundHalfUp(base * f, 0));  // min-1 rule (spec §3.1)
    } else {
      return { amount: base, unit: unit, manual: true };
    }
    if (scaled < 0) scaled = 0;
    return { amount: scaled, unit: unit, manual: false };
  }

  /* ------------------------------------------------------------
     Parse a free-text qty string (spec §4.0 fallback).
     "650 g"    → { amount: 650, unit: "g", scalable: true }
     "jódag"    → { amount: null, unit: "jódag", scalable: false }
     "1-2 gerezd" → { amount: null, unit: "gerezd", scalable: false } (range — no midpoint guess)
     "kb. 1 db" → { amount: 1, unit: "db", scalable: true } ("kb." tolerated)
     "½ tk"     → { amount: 0.5, unit: "tk", scalable: true }
     "3 evőkanál" → { amount: 3, unit: "evőkanál", scalable: true }
     "to taste" / "pc" → { scalable: false }
     ------------------------------------------------------------ */
  function parseQty(raw) {
    let qty = String(raw == null ? "" : raw).trim().toLowerCase();
    if (!qty) return { amount: null, unit: "", scalable: false };

    // Fuzzy marker present? (affects scalable flag, spec §4)
    const fuzzy = /\bkb\.?|némi|apró/.test(String(raw));
    // Strip leading filler ("kb.", "némi", "apró") so the number can
    // still be extracted ("kb. 3 evőkanál" → 3 evőkanál).
    qty = qty.replace(/^(kb\.?|némi|apró)\s+/i, "");

    // Range: "1-2 …" or "1 - 2 …" — spec says NOT scalable (no midpoint).
    if (/^[\d.,]+\s*[-–]\s*[\d.,]+/.test(qty)) {
      return { amount: null, unit: matchUnit(qty), scalable: false };
    }

    // Fraction: "½" "¼" "¾" "3/4"
    const fracMap = {"½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3};
    let amount = null;
    const first = qty.charAt(0);
    if (fracMap[first] != null) {
      amount = fracMap[first];
      qty = qty.slice(1);
    } else {
      const m = qty.match(/^([\d]+(?:[.,][\d]+)?|[.,][\d]+)/);
      if (m) {
        amount = Number(m[1].replace(",", "."));
      }
    }
    const unit = matchUnit(qty);
    // Spec §4: approximate markers make a row non-scalable even when
    // a number is present ("kb. 1 db" — no scaling).
    return { amount, unit: unit || "", scalable: !fuzzy && amount != null && amount > 0 && !!unit };
  }

  const UNIT_WORDS = [
    "evőkanál", "teáskanál", "gerezd", "darab", "gombóc",
    "tbsp", "tsp", "evőkanál", "ml", "g", "kg", "mg", "cup", "l",
  ];
  function matchUnit(text) {
    const words = String(text || "").trim().toLowerCase().split(/\s+/);
    for (const w of words) {
      const clean = w.replace(/[^a-züőáléíóű]/gi, "");
      if (MASS.includes(clean) || LIQUID.includes(clean) || COUNT.includes(clean)) return clean;
    }
    return null;
  }

  /* ------------------------------------------------------------
     Scale a FULL recipe (pure).
     ingredients : array of seed-shaped {name, qty, note?} rows.
     anchorName  : which ingredient is the anchor (by name).
     available   : the user's available amount (in anchor's unit).
     Returns {
       factor: number,
       anchor: { name, unit } | null,
       items: [{ name, base, baseQty, unit, amount, scaled, manual, note }]
     }
     - base: the recipe's original amount (number, null if unparseable)
     - amount: the scaled displayed value (number, null if manual)
     - scaled: true when the value changed from base
     ------------------------------------------------------------ */
  function scaleRecipe(ingredients, anchorName, available) {
    const rows = (ingredients || []).map((ing) => {
      const parsed = parseQty(ing.qty);
      return {
        name: ing.name,
        unit: parsed.unit || String(ing.qty || ""),
        base: parsed.scalable ? parsed.amount : null,
        baseQty: String(ing.qty || ""),
        note: ing.note || "",
      };
    });

    const anchor = rows.find((r) => r.name === anchorName) || null;
    if (!anchor || anchor.base == null || available == null || available <= 0) {
      // No usable factor — everything stays at base, manual flag on
      // non-scalable rows (the row map below handles that uniformly).
      const items = rows.map((r) => ({ ...r, amount: r.base, scaled: false, manual: r.base == null }));
      return { factor: 1, anchor: anchor ? { name: anchor.name, unit: anchor.unit } : null, items };
    }

    const f = available / anchor.base;   // exact, spec §2.2
    const items = rows.map((r) => {
      if (r.base == null) {
        return { ...r, amount: null, scaled: false, manual: true };
      }
      const s = scaleIngredient(r.base, r.unit, f);
      return {
        ...r,
        amount: s.amount,
        unit: s.unit,
        scaled: s.amount !== r.base,
        manual: s.manual,
        unit: r.unit,
      };
    });
    // Anchor always shows exactly `available` (user's stated amount).
    const a = items.find((i) => i.name === anchorName);
    if (a) {
      a.amount = Number(available);
      a.scaled = available !== a.base;
      a.manual = false;
    }
    return { factor: f, anchor: { name: anchor.name, unit: anchor.unit }, items };
  }

  /* ------------------------------------------------------------
     Anchor selection (spec §6.3): the largest-mass g/kg ingredient.
     If the user wants a different anchor they pick one explicitly.
     ------------------------------------------------------------ */
  function selectAnchors(ingredients) {
    return (ingredients || [])
      .map((ing) => {
        const p = parseQty(ing.qty);
        return { name: ing.name, amount: p.amount, unit: p.unit, scalable: p.scalable };
      })
      .filter((x) => x.scalable && (x.unit === "g" || x.unit === "kg"))
      .sort((a, b) => b.amount - a.amount)
      .map((x) => x.name);
  }

  /* ------------------------------------------------------------
     API client — spec §8 (optional hardening endpoint).
     Tries POST /api/v1/recipes/{id}/scale first; on any network
     error falls back to the local engine (spec §7: frontend-logika
     is the canonical path; API is a thin hardening layer).
     The payload uses ingredient_name (per-ingredient id/slug is an
     open question in spec §10-Q1, not a requirement for v1).
     Returns the SAME shape as scaleRecipe() so the caller doesn't
     care which engine produced it.
     ------------------------------------------------------------ */
  async function scaleViaApi(recipeId, anchorName, available, ingredients) {
    // config.js exports apiBase as a HELPER FUNCTION (window.SolinCfg.apiBase()),
    // not a string property. Calling it via the same accessor the rest of the
    // app uses keeps us consistent (config.js header: "go through
    // window.SolinCfg — apiBase(), flag()"). We still tolerate a plain string
    // export so either shape works.
    const cfgApiBase = window.SolinCfg && window.SolinCfg.apiBase;
    const apiBase = (typeof cfgApiBase === "function" ? cfgApiBase() : cfgApiBase) || "";
    const url = `${apiBase}/api/v1/recipes/${encodeURIComponent(recipeId)}/scale`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ingredient_id: anchorName,  // name OR 0-based index (resolve_ingredient)
          available_amount: available,
        }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      return {
        factor: (data.scale_factor_num != null ? data.scale_factor_num
               : (data.scale_factor != null ? Number(data.scale_factor) : 1)),
        anchor: data.anchor ? { name: data.anchor.name, unit: data.anchor.unit } : null,
        items: (data.ingredients || []).map((x) => ({
          name: x.name,
          base: x.base_amount != null ? x.base_amount : null,
          baseQty: x.base_qty || (x.base_amount != null ? `${x.base_amount} ${x.base_unit || x.unit || ""}` : ""),
          unit: x.unit || "",
          note: x.note || "",
          amount: x.amount != null ? x.amount : null,
          // Backend doesn't flag `scaled`; compute it — changed vs base.
          scaled: !!x.scalable && x.amount != null && x.amount !== x.base_amount,
          manual: !!x.manual,
        })),
      };
    } catch (e) {
      // Silent fallback: the local engine is the canonical path (spec §7).
      // The API is an optional hardening layer per spec §8.
      return scaleRecipe(ingredients, anchorName, available);
    }
  }

  /* ------------------------------------------------------------
     UI render helpers (pure string → HTML, no DOM mutation —
     detail.js applies the result to an already-mounted element).
     ------------------------------------------------------------ */
  function fmtAmount(amount, unit) {
    if (amount == null) return "";
    if (unit === "g" || unit === "kg" || unit === "mg") {
      return (+amount).toFixed(2).replace(/\.?0+$/, "") + " " + unit;
    }
    if (LIQUID.includes(unit)) {
      return (+amount).toFixed(1) + " " + unit;
    }
    return String(amount) + " " + unit;
  }

  function fmtFactor(f) {
    // Show a clean × label: 1 → ×1.00, 1.3077 → ×1.31, 0.7385 → ×0.74
    if (f == null || f <= 0) return "×1.00";
    const rounded = roundHalfUp(f, 2);
    return "×" + (rounded % 1 === 0 ? rounded.toFixed(2) : String(rounded));
  }

  return {
    scaleIngredient,
    scaleRecipe,
    selectAnchors,
    parseQty,
    roundHalfUp,
    scaleViaApi,
    fmtAmount,
    fmtFactor,
    units: { MASS, LIQUID, COUNT },
  };
})();
