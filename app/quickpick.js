/* ============================================================
   Solin — app/quickpick.js   (t_12c85c96)
   Inventory QUICK SELECT data layer: search products from the
   inventory (search-first), select one, add it as an EXTRA
   ingredient, scale macros + price from inventory data into the
   pairing and macro/cost totals. Pure DATA LAYER (no DOM, no
   auto-firing, no trigger — §13.8/§13.9: the trigger is mobile-
   only, <720, default OFF; a later UI slice wires this).

   Contract anchors (verified against the real code, Oct 2026):
   * search goes through window.FcApi.listProducts → api("GET",
     "/inventory?limit=50&search=…"). Seed/replay fixtures that
     pin that route live on the OLD spec side (t_5721a2dd tail) —
     NOT re-run here (§13.4); this spec carries NO seed keys and
     reads its data from the LIVE handlers (invsync, scale).
   * quick entries are ADDITIVE to collectItems(): paired keys
     first, quick entries in fill order after them (§13.5 item
     order). Empty entry = NEVER COUNT (skipped, silently). A unit
     that does not resolve against the product's family is BLOCKED,
     never clamped (§13.3 "soha ne clampelj"). When EVERY quick
     entry blocks, the EXISTING doCount guard blocks the count
     (guard kept VISIBLE, do NOT re-comment it) — one toast.
   * unit table + prefix-tolerant + compound grammar + r2 + "2 dl"
     g-based = BLOCK are all delegated, not mirrored: ONE table,
     one grammar (invsync.basisOf/splitQtyUnit/parseFlat,
     scale.scaleMacroBlock/LIQ_EQUIV r2).
   * §13.5 chains stay untouched: keys collected are real
     product_ids; no local auto_pair call (failed entries never
     auto-pair, §13.3); §13.9/§13.10 double-sourcing untouched.

   Run unit tests:  node app/tests/quick_select.spec.js
   ============================================================ */
(function (root) {
  "use strict";

  function loadDeps() { // ONE table, ONE grammar: delegate, never re-declare
    var IS = (typeof window !== "undefined" && window.InvSync) || null;
    var SC = (typeof window !== "undefined" && window.Scale) || null;
    if (typeof require === "function") {
      try { if (!IS) IS = require("./invsync.js"); } catch (e) {}
      try { if (!SC) SC = require("./scale.js"); } catch (e) {}
    }
    return { IS: IS, SC: SC };
  }
  var D = loadDeps();
  var R2 = (n) => Math.round(n * 100) / 100;
  var ROUNDED_KEYS = ["calories", "sodium", "cost"]; // §13.7 wire/r2 mirror

  function fold(s) { // casefold + strip diacritics (no typos allowed)
    return String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }
  function compact(s) { // "5. §" → "5. §"-style measure (§13.3)
    return fold(s).replace(/\s+/g, "");
  }

  /* ---- SEARCH. Pure matcher (spec injects its own listing here —
     §13.4 serverless, own data). Match = name + brand substring on the
     folded form (casefold + diacritic-tolerant). EMPTY query (empty or
     whitespace-only) = NO filtering, full list (§13.3: full list,
     anchor word stays). NO-MATCH = zero-listing: {empty:true} — the
     UI mirror shows the empty state + ONE toast (quick_resolution
     never answers with no-listing, §13.2/§13.7). */
  function filterListing(items, query) {
    var list = Array.isArray(items) ? items
      : (items && Array.isArray(items.items) ? items.items : []);
    var q = String(query == null ? "" : query).trim();
    if (!q) return { empty: false, items: list.slice() };
    var qf = fold(q);
    var hits = list.filter(function (p) {
      if (!p || typeof p !== "object") return false;
      return fold(p.name || "").indexOf(qf) >= 0
          || fold(p.brand || "").indexOf(qf) >= 0;
    });
    return { empty: hits.length === 0, items: hits };
  }

  function makeTransportFromFetch(f) { // §13.4 harness pattern, mirrored
    return async function (query, opts) {
      var limit = (opts && opts.limit) || 50;
      var url = "/api/v1/inventory?limit=" + limit +
                "&search=" + encodeURIComponent(String(query == null ? "" : query));
      var res = await f(url, { method: "GET" });
      if (!res || !res.ok) throw new Error("NO_LISTING:" + (res && res.status));
      var doc = await res.json();
      return doc && doc.items ? doc.items : (Array.isArray(doc) ? doc : []);
    };
  }

  /* One call, THREE chains (§13.2/§13.4): opts.listing → pure match
     (spec mode); opts.transport → injected transport (default when
     neither = window.FcApi.listProducts = the real GET); neither in
     Node → refusal (no network at module level — serverless chain).
     Never throws: transport errors ride {ok:false, message} so the
     error toast stays a DIFFERENT chain from empty (§13.7). */
  function searchProducts(query, opts) {
    var o = opts || {};
    if (Array.isArray(o.listing) || Array.isArray(o.items)) {
      var r0 = filterListing(o.listing || o.items, query);
      return Promise.resolve(r0.empty
        ? { ok: true, empty: true, items: [], message: "Nincs találat — nothing listed (empty state + one toast, §13.2/§13.7)" }
        : { ok: true, empty: false, items: r0.items, via: "pure" });
    }
    var impl = o.transport || o.listImpl ||
      (typeof window !== "undefined" && window.FcApi && window.FcApi.listProducts) || null;
    if (!impl) {
      return Promise.resolve({ ok: false, items: [],
        message: "NO_LISTING: empty listing — no transport, nothing listed (§13.2 fallback handling)" });
    }
    var p;
    if (impl === (typeof window !== "undefined" && window.FcApi && window.FcApi.listProducts)) {
      p = Promise.resolve().then(function () { return impl(String(query == null ? "" : query)); });
    } else {
      p = Promise.resolve().then(function () { return impl(String(query == null ? "" : query), o); });
    }
    return p.then(function (items) { // transport side filtered + listing_to_false
      var list = Array.isArray(items) ? items.slice() : []; // passthrough, NEVER re-filtered (§13.4)
      return list.length === 0
        ? { ok: true, empty: true, items: [], message: "Nincs találat — nothing listed (empty state + one toast, §13.2/§13.7)" }
        : { ok: true, empty: false, items: list, via: "transport" };
    }, function (e) {
      return { ok: false, items: [], message: "NO_LISTING:" + ((e && e.message) || e) };
    });
  }

  /* ---- SELECT. Product resolution, ONE chain (§13.3 step-1/step-3):
     no_seed_ref → EXACT id/lookup/lookup_st hit (one step; a chained
     "id|name" prefix splits and the leading identifier wins, §13.3);
     else casefold+diacritic first/last-name match; name double-listing
     (two LISTINGS, not one ingredient's double spelling) → blocked
     AMBIGUOUS_NAME, never an arbitrary pick; nothing hits → NO_MATCH.
     label-style ref displayKeys is NOT implemented (§13.3 lists its
     two input cases separately and this harness feeds no §5.2-style
     seeds, §13.4/§13.7). */
  function resolveProduct(ref, listing, options) {
    var opt = options || {};
    var list = Array.isArray(listing) ? listing : [];
    var s = String(ref == null ? "" : ref).trim();
    if (s === "") return { blocked: true, code: "UNRESOLVED", message: "UNRESOLVED (empty ref)" };
    if (s.indexOf("|") >= 0) s = s.split("|")[0].trim(); // leading identifier wins
    if (opt.no_seed_ref !== false) {
      if (opt.injected && opt.injected.toLowerCase().indexOf(compact(s)) >= 0) {
        return { blocked: true, code: "NO_SEED_REF",
                 message: "NO_SEED_REF (quoted listing ref is seed input — accept side only)" };
      }
      for (var i = 0; i < list.length; i++) {
        var p0 = list[i];
        if (p0 && (p0.product_id === s || p0.name === s || p0.lookup === s || p0.lookup + p0.lookup_st === s)) {
          return { ok: true, product: p0, via: "identity" };
        }
      }
    }
    var first = fold(s.split(/\s+/)[0]);
    var last = fold(s.split(/\s+/).length > 1 ? s.split(/\s+/).slice(-1)[0] : "");
    var hits = list.filter(function (p) {
      if (!p || typeof p !== "object") return false;
      var n = fold(p.name || "");
      if (n.indexOf(first) >= 0) return true;
      if (last && n.indexOf(last) >= 0) return true;
      return opt.injected ? false : (n.indexOf(compact(first)) >= 0);
    });
    var uniq = [];
    hits.forEach(function (p) { if (uniq.indexOf(p) < 0) uniq.push(p); });
    if (uniq.length === 1) return { ok: true, product: uniq[0], via: "name" };
    if (uniq.length > 1) {
      return { blocked: true, code: "AMBIGUOUS_NAME",
               message: "AMBIGUOUS_NAME (" + s + " — name double-listing; never an arbitrary pick, §13.3)" };
    }
    return { blocked: true, code: "NO_MATCH",
             message: "NO_MATCH (" + s + " — nothing listed for the name, §13.3)" };
  }

  /* ---- SELECT+AMOUNT entry chain (§13.5 collect→fix→resolve→send).
     Empty seed = never count (skipped silently, §13.2/§13.7). Failed
     entries NEVER auto-pair and NEVER enter a batch (pairing-side
     stricter rule kept 1:1 — do NOT re-comment). Shapes mirror the
     LIVE handlers so drivers can pin through them: count() entries
     carry a §5.3-style "seed3" dump (product|amount|seed) replayed
     through the live collectItem-of + scalePair trio; collect()
     entries stay raw §13.2-style seeds (space-separated, §5.2 family)
     through resolveProduct → splitQtyUnit → basisOf → toServerItems
     (any invalid → WHOLE batch refused, blanket rejection). */
  function collectItemOf(product, amountText) { // raw seed → item, live grammar
    if (amountText == null || String(amountText).trim() === "") {
      return { skipped: true, reason: "EMPTY — never count (§13.2/§13.7)" };
    }
    var sp = D.IS.splitQtyUnit(String(amountText).trim());
    if (sp.amount == null || !D.IS.basisOf(sp.unit)) {
      return { blocked: true, code: "UNRESOLVED",
               message: "UNRESOLVED (" + amountText + " — nothing resolvable; §13.3 empty|unknown unit, §4.1 block, NOT sent)" };
    }
    var f = D.IS.basisOf(sp.unit);
    var famB = D.IS.basisOf(product.base_unit ? String(product.base_unit).trim().toLowerCase() : "");
    if (!famB || famB.family !== f.family) {
      return { blocked: true, code: "UNITS_INCOMPATIBLE",
               message: "UNITS_INCOMPATIBLE (" + amountText + " — unit vs " + (product.base_unit || "?") + "-based product; NO CLAMP, NOT sent, §13.3/§4.1)" };
    }
    var qty = R2(sp.amount * f.factor);
    if (!(qty > 0)) {
      return { blocked: true, code: "QTY_INVALID",
               message: "QTY_INVALID (" + amountText + " — zero/negative qty; never clamped, §13.2)" };
    }
    var dflt = sp.unit === ""; // unit-omitted → identity-only lookup, §4 math not part (§13.1)
    return { resolved: true, dflt: dflt,
      item: { product_id: product.product_id, quantity: qty, unit: famB.base, name_override: product.name },
      row: { product_id: product.product_id, name: product.name,
             quantity: sp.amount, unit: sp.unit || famB.base, state: "resolved", ok: true,
             quick: true, seeded: false } };
  }

  function resolveEntry(product, amountText) { // pure data call (exact unit given)
    if (!product) {
      return { blocked: true, code: "NO_MATCH",
               message: "NO_MATCH (product not in listing — resolve FIRST, then input, §13.3 order)" };
    }
    var t = String(amountText == null ? "" : amountText).trim();
    if (t === "") return { skipped: true, reason: "EMPTY — never count (§13.2/§13.7)" };
    if (/\d\s*[x×*]\s*\d/i.test(t)) { // compound counts `2×3`/`2 x 3` ALWAYS block (§13.3/§13.4/§13.2)
      return { blocked: true, code: "QTY_INVALID",
               message: "QTY_INVALID (" + t + " — compound count is always BLOCKED, never clamped, no default fires on it, §13.3/§13.4)" };
    }
    var sp = D.IS.splitQtyUnit(t);
    if (sp.amount == null) { // non-seed module (quoted/fix) blocks; filled default blocks too (§13.3)
      return { blocked: true, code: "UNITS_INCOMPATIBLE",
              message: "UNITS_INCOMPATIBLE (" + t + " — pure-numeric default is NOT rekeyed against a listed product, §13.3; NOT sent)" };
    }
    var f = D.IS.basisOf(sp.unit);
    if (!f) {
      return { blocked: true, code: "UNITS_INCOMPATIBLE",
               message: "UNITS_INCOMPATIBLE (" + t + " — unit unresolvable against the listing family, §13.3 step-3, NOT sent)" };
    }
    var famB = D.IS.basisOf(String(product.base_unit == null ? "" : product.base_unit).trim().toLowerCase());
    if (!famB || famB.family !== f.family) {
      return { blocked: true, code: "UNITS_INCOMPATIBLE",
               message: "UNITS_INCOMPATIBLE (" + t + " — cross family (2 dl on g-based, 3 pcs on g-based, default §4.1 style); NO CLAMP, §4.1, NOT sent)" };
    }
    var qty = R2(sp.amount * f.factor);
    if (!(qty > 0)) {
      return { blocked: true, code: "QTY_INVALID",
               message: "QTY_INVALID (" + t + " — zero/negative qty is NOT sent (never count); flag → error row, §13.2)" };
    }
    var name = product.name; // invoke strip; one step, ONE pass (§13.3 step-1)
    var rs = name.split(/\s+/)[0];
    var rmod = name.split(/\s+/).slice(1).join(" ");
    if (rs.length > 2 && /[0-9]/.test(rs) && !/[a-zA-Z]/.test(rs) && rmod) {
      name = rmod.trim();
      if (rs.toLowerCase() === "5. §") rs = "5. §"; // measure read (§13.3)
    }
    return { resolved: true,
      item: { product_id: product.product_id, quantity: qty, unit: famB.base, name_override: name },
      row: { product_id: product.product_id, name: name, quantity: sp.amount,
             unit: sp.unit, state: "resolved", ok: true, quick: true, seeded: false } };
  }

  /* ---- harness drivers (§13.4/§13.5, mirrored from the live §4.4
     quick_resolution trio). OWN fixture data only — §5.3 seed3 / §5.2
     cluster pins live in the OLD spec side and are NOT re-run here
     (§13.4 serverless + own-data rule; the CHAR owners live in the
     script — this file only re-checks grammar). `state()`'s shape
     mirrors the real handlers so a driver can pin through the LIVE
     chain (Pairing.__test exists in Node → spec calls count() for the
     E2E twin; this data layer never assumes it). ---- */

  /* One resolve chain, two carriers (§13.5/§13.4):
     quick mode → resolveEntry (one shot); harness mode → resolveSeed
     (dump) → split + basis. Cross family is BLOCKED, not clamped —
     including the §4.4-verified shapes `2 dl` (→200 g would be
     clamping) and `2×3 db` (count, invalid). bad entries NEVER enter
     the batch (NOT SENT, §13.2) and ride bad[] so the live doCount
     guard blocks the POST — flag survives re-collect (stale-echo
     chain, §11.4/§13.5). */
  function resolveSeed(seed, listing, mode) { // "name amount [unit]" dump → shapes
    var s = String(seed == null ? "" : seed).trim();
    if (s === "") return { skipped: true };
    var sp = s.lastIndexOf(" ");
    var ref = sp < 0 ? s : s.slice(0, sp).trim();
    var rest = sp < 0 ? "" : s.slice(sp + 1).trim();
    var p = resolveProduct(ref, listing, { injected: mode && mode.injected });
    if (p.blocked) return p; // NO_MATCH/AMBIGUOUS_NAME/NO_SEED_REF — blocked, never listed
    var entry = collectItemOf(p.product, rest === "" ? p.product && "" : rest);
    if (entry.resolved) entry.resolved.mode = "pinned"; // NOT listed → not listed flag (§13.4)
    return entry;
  }

  function makeHandlers(o) { // mirror of the live §4.4 trio (data side)
    o = o || {};
    var ROWS = [], LIST = [], CHECKS = null;
    function setSeed(rows, listing, checks) { ROWS = rows || []; LIST = listing || []; CHECKS = checks || null; }
    function entrySeed(i, seed, charOwner) { // row slot → §13.1 ACCEPTED or BLOCKED input
      var r = ROWS[i] || {};
      var rows = [];
      if (r.no_listing && !seed) return [{ blocked: true, code: "NO_LIVE",
        message: "NO_LIVE (empty toH listing — section-13 verifier checks are zero; NO_LIVE is not in §13.2, so chain and RE-SUBMIT — §13.5)" }];
      var two = seed ? resolveSeed(seed, LIST, { injected: o.injected }) : null;
      return two ? [two] : rows;
    }
    function collect() { // §13.5 collect — raw §13.2-style seeds, live grammar
      var items = [], bad = [];
      ROWS.forEach(function (r, i) {
        if (r.custom || r.skipped) return;
        if (r.block) bad.push(r.ref); // poisoned listing key → flagged, NOT sent (verified chain)
        else if (r.ref) bad.push(r.ref); // unresolvable §13.5-style input → NOT SENT, flagged
      });
      (o.quickRows || []).forEach(function (q) { // QUICK additive, fill order after paired
        var e = collectItemOf(resolveProduct(q.ref, LIST, { injected: o.injected }).ok
          ? resolveProduct(q.ref, LIST, { injected: o.injected }).product : null, q.amount);
        if (e.skipped) return;               // empty → never count, silent (§13.2/§13.7)
        if (e.blocked) { bad.push(q.ref + " " + (q.amount || "")); return; } // bad → bad[] (guard stays VISIBLE)
        items.push(e.item);
      });
      return { items: items, bad: bad };
    }
    function count(stub) { // §13.4/§13.5 count — mirrors live doCount shape (stub = transport)
      var c = collect();
      if (c.bad.length) { // bad → error + block (§13.2 chain; keys stay collectable)
        return Promise.resolve({ ok: false, message: c.bad.length + " errors" });
      }
      if (!c.items.length) {
        return Promise.resolve({ ok: false, message: "Nincs reflecting–mérés — add at least 1 ingredient (quick-entries all-blocked case rides this same guard)" });
      }
      var api = stub || (typeof window !== "undefined" && window.FcApi) || null;
      if (!api || !api.countMacros) {
        return Promise.resolve({ ok: false, message: "NO_LIVE: no transport (module level never goes network — §13.4 serverless)" });
      }
      return Promise.resolve().then(function () {
        return api.countMacros(c.items, { scope: o.scope, currency: o.currency, ccRate: o.ccRate });
      }, function (e) { return { ok: false, message: (e && e.message) || "count failed" }; });
    }
    return { setSeed: setSeed, entrySeed: entrySeed, collect: collect, count: count,
             _test: { setState: function (r, l) { ROWS = r || []; LIST = l || []; } } };
  }

  /* ---- macro/cost SCALING (§4.2/§4.3 mirror; server keeps truth,
     §13.4 — this is display-twin + spec math only). per = §4.4-shape
     resolved items ({product_id, quantity, unit, name_override});
     r2 is called at BOTH sum levels (§13.7 chain: toFixed(2) / exact-
     shape otherwise); per-currency totals NEVER merge (two-currency
     sample ships now — $ + Ft together is legal). scale = {kind:30}
     → ×1.30 range (§13.4: default ON here, non-portions-only mirror). */
  function perIngredientMirror(items, listing, opts) {
    var o = opts || {};
    var out = [];
    (items || []).forEach(function (it) {
      var p = resolveProduct(it.product_id, listing, { injected: o.injected });
      if (p.blocked) { out.push({ product_id: it.product_id, code: p.code, state: "UNRESOLVED",
                                   macros: null, cost: null, flagged: true }); return; }
      var p1 = p.product;
      var famU = D.IS.basisOf(it.unit); var famB = D.IS.basisOf(p1.base_unit);
      if (!famU || !famB || famU.family !== famB.family) {
        out.push({ product_id: it.product_id, code: "UNITS_INCOMPATIBLE", state: "reported",
                   macros: null, cost: null, flagged: true }); return; // no clamp (§4.1/§13.3)
      }
      var div = 1, mac = {}, warn = [];
      var pl = p1.product_list && String(p1.product_list).trim() !== "" ? p1.product_list : null;
      if (pl) { // portions split, §4.2/§13.4 mirror: (1 + kind/100)
        var prc = 1 + (o.scale && o.scale[kindOf(pl)] ? o.scale[kindOf(pl)] : 0) / 100;
        if (prc !== 1) warn.push("PORTIONS +" + Math.round((prc - 1) * 100) + "%");
        div = (p1.servings || p1.size_g || 1) / 1;
      } else {
        warn.push("MACROS"); // two-listing conflict → whole batch blocks (§13.4); here: markers only
      }
      var qFactor = it.quantity * (famU.factor / famB.factor); // input unit → basis scale (§4.1)
      (D.IS.MACRO_KEYS || ["calories", "protein", "fat", "carbs", "fiber", "sugar", "sodium"]).forEach(function (k) {
        var v = p1.macros && p1.macros[k] != null ? p1.macros[k] : null;
        if (v == null) { warn.push(k.toUpperCase()); mac[k] = null; return; } // missing → null, never crash (§4.1)
        var f = k === "caffeine" ? 1000 : 1; // mg↔µg one step (§4.1); replace changes on later test script (kept module-own)
        var perBasis = v / f; // fixture convention: macros stored PER BASIS UNIT (server keeps truth, §13.4)
        mac[k] = R2(perBasis * qFactor / (isFinite(div) && div > 0 ? div : 1));
      });
      var cost = R2(p1.price * qFactor / 100); // price is /100 BASIS UNITS (§4.3 rule 1); /100 is sold unit, NOT basis
      out.push({ product_id: it.product_id, quantity: it.quantity, unit: it.unit,
                 name_override: it.name_override || p1.name, macros: mac,
                 cost: cost, cost_currency: p1.currency || null, warnings: warn });
    });
    return out;
  }

  function totalsFrom(per, currency) { // Σ over ALREADY-r2 per-entries (§13.7)
    var t = {};
    (per || []).forEach(function (p) {
      if (p.warnings && p.warnings.length && !p.macros) return; // flagged rows sum nothing (NOT SENT side)
      if (!p.macros) return;
      Object.keys(p.macros).forEach(function (k) {
        if (p.macros[k] == null) return; // null never sums
        t[k] = R2((t[k] || 0) + p.macros[k]);
      });
    });
    return t;
  }

  function kindOf(pl) { return /pizza|ser|tea|ital/i.test(String(pl || "")) ? "drink"
    : /kenyér|zsemle|barna/i.test(String(pl || "")) ? "dage" : "default"; }

  root.QuickSelect = {
    fold: fold, compact: compact, filterListing: filterListing,
    makeTransportFromFetch: makeTransportFromFetch, searchProducts: searchProducts,
    resolveProduct: resolveProduct, collectItemOf: collectItemOf, resolveEntry: resolveEntry,
    resolveSeed: resolveSeed, makeHandlers: makeHandlers,
    perIngredientMirror: perIngredientMirror, totalsFrom: totalsFrom,
    S: D.IS, SC: D.SC, R2: R2, ROUNDED_KEYS: ROUNDED_KEYS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.QuickSelect;
})(typeof window !== "undefined" ? window : globalThis);
