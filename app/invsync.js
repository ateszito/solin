/* ============================================================
   Solin — app/invsync.js   (t_96fcfc2a)
   Custom extra ingredient → permanent inventory product.
   Pure DATA LAYER (no DOM, no view code).

   Contract anchors (verified against the real code, Oct 2026):
   * transport goes through window.FcApi.createProduct → api("") →
     POST {apiBase}/api/v1/inventory (fcapi.js header: canonical base,
     locked by devops t_7fc7904f + parent t_47368aba). createProduct
     posts the body VERBATIM, so what we validate here is what the
     server sees — validation must mirror the server grammar.
   * one save emits ONE payload (no per-field fan-out).
   * validation failures and duplicate-name hits BLOCK the whole batch
     (blanket rejection): nothing is sent, nothing is written, the
     pairing stays exactly as it was, written or not.
   * duplicate lookups are casefold+trim name matches.

   Run unit tests:  node app/tests/custom_item_save.spec.js
   ============================================================ */
(function () {
  "use strict";

  var MACRO_KEYS = ["calories", "protein", "fat", "carbs",
                    "fiber", "sugar", "sodium"];

  /* ---- unit → basis: display unit + factor to its base unit ----
     Families mirror fcapi.js UNIT_FAMILIES (mass/liquid/count) and the
     §4.5-style rule: anything outside one family (pcs ↔ g/ml included)
     is NOT derivable → blocked, never clamped. */
  var MASS_EQUIV = { g: 1, kg: 1000, mg: 0.001 };      // → "g"
  var LIQ_EQUIV = { ml: 1, dl: 100, l: 1000,
                    "evőkanál": 15, "teáskanál": 5 };   // → "ml"
  var COUNT_UNITS = ["pcs", "db", "darab", "szelet", "szem",
                     "gerezd", "fej"];

  function basisOf(unit) {
    var u = String(unit == null ? "" : unit).trim().toLowerCase();
    if (u === "") return null;
    if (Object.prototype.hasOwnProperty.call(MASS_EQUIV, u))
      return { family: "mass", base: "g", factor: MASS_EQUIV[u] };
    if (Object.prototype.hasOwnProperty.call(LIQ_EQUIV, u))
      return { family: "liquid", base: "ml", factor: LIQ_EQUIV[u] };
    if (COUNT_UNITS.indexOf(u) >= 0)
      return { family: "count", base: "pcs", factor: 1 };
    return null; // unknown symbol → NOT derivable
  }

  /* Flat numeric: "2.4", "1/2", "2×3", "2 x 3" → number; else null.
     EMPTY is NOT a number here (null): empty stays empty — silently
     skipped, never treated as an error. */
  function parseFlat(text) {
    var s = String(text == null ? "" : text).trim();
    if (s === "") return null;
    var d = /^(\d+(?:[.,]\d+)?)(?:\s*(?:\/|÷)\s*(\d+(?:[.,]\d+)?))?$/.exec(s);
    if (d) {
      var a = Number(d[1].replace(",", "."));
      var b = d[2] ? Number(d[2].replace(",", ".")) : null;
      var v = b != null && b !== 0 ? a / b : a;
      return v > 0 ? v : null;
    }
    var x = /^(\d+(?:[.,]\d+)?)\s*[×xX]\s*(\d+(?:[.,]\d+)?)$/.exec(s);
    if (x) {
      var v2 = Number(x[1].replace(",", ".")) * Number(x[2].replace(",", "."));
      return v2 > 0 ? v2 : null;
    }
    return null;
  }

  /* Compound amount labels ("1/2 db", "2×3 db", "10 g") split into the
     numeric amount + the trailing unit (unit resolution is ONE table).
     A trailing symbol that is NOT a known unit stays part of the
     amount text → parseFlat fails → the row blocks (never clamped). */
  function splitQtyUnit(text) {
    var s = String(text == null ? "" : text).trim();
    if (s === "") return { amount: null, unit: "" };
    var sp = s.lastIndexOf(" ");
    if (sp < 0) return { amount: parseFlat(s), unit: "" };
    var head = s.slice(0, sp).trim();
    var tail = s.slice(sp + 1).trim();
    var amount = parseFlat(head);
    if (amount != null && basisOf(tail)) return { amount: amount, unit: tail };
    return { amount: parseFlat(s), unit: "" };
  }

  /* ---- validation BEFORE saving: ONE function, ONE call (and only
     ONE call per row). `bad = errors`. Grammar mirrors pairing.js
     customItemOf 1:1 — a totally empty row is `{skip:true}` (silent),
     everything else that is not exactly right returns
     `{blocked:true, errors:[...], name}` and the WHOLE batch refuses.
     Additive data-layer gates on top of the grammar:
       * price or macros with an empty or unresolvable unit → blocked
         (no basis to convert against);
       * a compound qty label's trailing unit goes through the SAME
         table (no second one is parsed);
       * name double-listing (casefold+trim) → blocked.           */
  function validateCustom(row, products) {
    var s = function (v) { return String(v == null ? "" : v).trim(); };
    var macros = row.macros || {};
    var macroFilled = MACRO_KEYS.some(function (k) {
      return s(macros[k]) !== "";
    });
    var filled = !!(s(row.name) !== "" || s(row.qty) !== "" ||
                   s(row.unit) !== "" || s(row.price) !== "" || macroFilled);
    if (!filled) return { skip: true };          // empty = silent skip

    var errors = [];
    var bad = function (msg) {
      if (errors.indexOf(msg) < 0) errors.push(msg);
    };

    if (s(row.name) === "") bad("name");          // empty name WITH values
    if (s(row.name).length > 80) bad("name");
    var q = splitQtyUnit(row.qty);
    if (s(row.qty) !== "" && q.amount == null) bad("quantity");
    var unit = s(row.unit);
    if (unit.length > 10) bad("unit");
    if (s(row.unit).length > 10 ||
        (s(row.unit) === "" && q.unit !== "" && !basisOf(q.unit))) {
      bad("unit");                                // compound label unit too
    }
    if (s(row.price) !== "" && !(Number(s(row.price)) > 0)) bad("price");
    var cur = s(row.currency).toUpperCase();
    if (s(row.price) !== "" && !/^[A-Z]{3}$/.test(cur)) bad("currency");
    MACRO_KEYS.forEach(function (k) {
      var v = s(macros[k]);
      if (v !== "" && (!/^\d+(\.\d{1,2})?$/.test(v) || Number(v) > 9999))
        bad(k);
    });

    /* price or macros WITHOUT a convertible basis → not savable: the
       basis must exist to be converted (UNITS_INCOMPATIBLE upstream). */
    var effUnit = unit !== "" ? unit : q.unit;
    var basis = basisOf(effUnit);
    if ((macroFilled || s(row.price) !== "") && (effUnit === "" || !basis))
      bad("unit");

    if (errors.length) {
      return { blocked: true, errors: errors,
               name: s(row.name) || "(név nélkül)" };
    }

    /* ---- duplicate lookup, casefold+trim name match, checked on the
       WHOLE listing (seeded products AND saved customs). A double
       listing refuses the batch; the pairing is NOT silently edited. */
    var n = s(row.name).trim().toLowerCase();
    var hits = (products || []).filter(function (p) {
      return p && String(p.name == null ? "" : p.name)
                 .trim().toLowerCase() === n;
    });
    if (hits.length) {
      return { blocked: true, dup: true, name: s(row.name),
               existing: hits.map(function (h) { return h.id; }),
               errors: ["duplicate"] };
    }
    return { ok: true };
  }

  /* ---- data-layer gate. `customSavable`: false on ANY failed rule —
     a row with EITHER field flag → false (nothing persists on its
     basis). Default batch behaviour is blanket rejection: any blocked
     (or duplicate) row blocks the WHOLE batch, nothing POSTs.
     Called directly by the (then wired) Node mirror spec; pairing.js
     keeps its own toEngine/getRows for the moment — this file ships
     the data layer, the UI triads re-anchor later. */
  function customSavable(row, products) {
    var v = validateCustom(row, products);
    if (v.skip) return false;                     // empty: not savable, silent
    return !v.blocked;                            // blocked → whole batch blocks
  }

  /* ---- one custom row → ONE inventory product doc.
     Shape (independent-partial-fields contract §3.4 — keys create()
     accepts): name, serving_size, serving_label, base_unit (the key
     the pure engine reads — macros_per_item causes #6 rejection and
     is NEVER sent), macros_per_100 (7 keys, canonical order), prices.
     Pricing FIRST (empty pricing stays empty, never fabricated).
     Flat macros are transformed to per-basis amounts (basis g/ml;
     cross-family and empty → no basis → blocked). */
  function toProductDoc(row, products) {
    var v = validateCustom(row, products);
    if (v.skip) return v;
    if (v.blocked) return v;

    var s = function (x) { return String(x == null ? "" : x).trim(); };
    var q = splitQtyUnit(row.qty);
    var unitRaw = s(row.unit);
    var unit = unitRaw !== "" ? unitRaw : q.unit;
    var basis = basisOf(unit);
    var amount = q.amount;
    if (amount == null) amount = parseFlat(s(row.qty));

    var doc = {
      name: s(row.name),
      serving_size: s(row.qty),
      serving_label: s(row.qty),
      base_unit: null,
      macros_per_100: null,
      prices: [],
    };

    if (basis && amount != null && amount > 0) {
      doc.base_unit = basis.base;
      // pack_size: total quantity on its basis (2–3 decimals are fine —
      // they are parsed, NOT clamped: "1/2 db" and "2×3 db" resolve here)
      doc.pack_size = Math.round(amount * basis.factor * 1000) / 1000;
    }

    var m = {};
    var anyM = false;
    MACRO_KEYS.forEach(function (k) {
      var raw = s((row.macros || {})[k]);
      if (raw === "" || Number(raw) === 0) { m[k] = 0; return; } // 0 = "done"
      anyM = true;
    });
    if (anyM && basis && amount != null && amount > 0) {
      // entered macros are TOTALS for the used quantity (mirrors the
      // count grammar) → convert to per-100 of the basis unit
      var scale = 100 / (amount * basis.factor);
      MACRO_KEYS.forEach(function (k) {
        var raw = s((row.macros || {})[k]);
        if (raw !== "" && Number(raw) !== 0)
          m[k] = Math.round(Number(raw) * scale * 100) / 100;
      });
      doc.macros_per_100 = m;   // formulas sit in macros_per_100
    } else if (anyM || s(row.price) !== "") {
      return { blocked: true, errors: ["basis"],
               name: s(row.name) || "(név nélkül)",
               message: "no convertible basis — fix unit or macrós amount" };
    }

    if (s(row.price) !== "" && basis && amount != null && amount > 0) {
      // TOTAL price → unit price per display unit (never fabricated)
      doc.prices = [{
        amount: Math.round((Number(row.price) /
                            amount) * 10000) / 10000,
        currency: s(row.currency).toUpperCase() || "HUF",
        is_primary: true,
        source: "custom",
      }];
    }
    return { ok: true, doc: doc };
  }

  /* ---- assembly slot: custom-first, ONE save = ONE payload.
     There is deliberately NO second resolution path for custom entries:
     a custom either validates on its basis or blocks the batch. A batch
     with ANY invalid entry is refused WHOLE (no POST, no write, pairing
     stays as it was — "nothing rolls back, nothing auto-adds").
     `products` = the injected listing (seeded products + saved customs);
     in the browser the caller passes the fresh live list, the Node spec
     injects its own. Empty batch → no request, identical to the count-
     path's items guard (empty never POSTs). */
  function toServerItems(rows, products) {
    var blocked = (rows || []).map(function (r) {
      return validateCustom(r, products);
    }).filter(function (v) { return v.blocked; });
    if (blocked.length) {
      return { blocked: true, errors: blocked };   // whole batch refuses
    }
    var items = [];
    (rows || []).forEach(function (r) {
      var d = toProductDoc(r, products);
      if (d.ok) items.push(d.doc);
    });
    return { blocked: false, items: items };        // empty stays empty
  }

  /* ---- the save itself. Default transport = window.FcApi.createProduct
     (api("") → POST {apiBase}/api/v1/inventory). Node specs inject
     {fetchImpl} or {transport}. Failure = the promise REJECTS with the
     normalized error ({status, code, message}) — the pairing above sees
     "Saved failed" and NOTHING changed: this layer writes nothing to
     any store, so there is nothing to roll back (rollback = no write).
     `customSavable` false anywhere → sent:false, no transport call. */
  function saveToInventory(rows, opts) {
    var o = opts || {};
    if (o.blocked) {                               // batch-level block first
      return Promise.resolve({ ok: false, sent: false, stage: "blocked",
                               message: "batch blocked — nothing was saved" });
    }
    var rows = rows || [];
    var listing = o.products || [];
    var bad = [];
    rows.forEach(function (r) {
      if (!customSavable(r, listing)) bad.push(r);
    });
    if (bad.length) {
      return Promise.resolve({ ok: false, sent: false, stage: "validate",
                               message: "invalid rows — nothing was saved",
                               errors: bad });
    }
    var docs = rows.map(function (r) { return toProductDoc(r, listing).doc; });
    if (!docs.length) {
      return Promise.resolve({ ok: true, sent: false, stage: "empty" });
    }
    var post = o.transport || o.createProduct ||
               (typeof window !== "undefined" && window.FcApi &&
                window.FcApi.createProduct) || null;
    if (!post) {
      return Promise.resolve({ ok: false, sent: false, stage: "offline",
                               message: "no transport — nothing was saved",
                               docs: docs });
    }
    return Promise.all(docs.map(function (d) {
      return Promise.resolve().then(function () { return post(d); });
    })).then(function (docs2) {
      return { ok: true, sent: true, stage: "saved", docs: docs2 };
    }, function (err) {
      return { ok: false, sent: true, stage: "transport",
               message: (err && err.message) || "save failed",
               status: err && err.status, code: err && err.code,
               rollback: "none — pairing untouched, nothing to roll back" };
    });
  }

  if (typeof window !== "undefined") {
    window.InvSync = {
      MACRO_KEYS: MACRO_KEYS, basisOf: basisOf, parseFlat: parseFlat,
      splitQtyUnit: splitQtyUnit, validateCustom: validateCustom,
      customSavable: customSavable, toProductDoc: toProductDoc,
      toServerItems: toServerItems, saveToInventory: saveToInventory,
    };
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      MACRO_KEYS: MACRO_KEYS, basisOf: basisOf, parseFlat: parseFlat,
      splitQtyUnit: splitQtyUnit, validateCustom: validateCustom,
      customSavable: customSavable, toProductDoc: toProductDoc,
      toServerItems: toServerItems, saveToInventory: saveToInventory,
    };
  }
})();
