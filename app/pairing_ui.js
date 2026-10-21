/* ============================================================
   Solin — app/pairing_ui.js   (t_c05b328b)
   Pairing-view UI glue for the product inventory (design V §13 + §13.9,
   wiring task t_c05b328b; parents 2a8cd40 quickpick t_12c85c96 +
   invsync t_96fcfc2a, re-grounded against live files).

   Thin glue between the two pure data layers and the pairing card DOM
   (pairing.js renderCard/wireCard). Owns:
     * quick-select SEARCH chain: query → QuickSelect.findInListing (local
       mirror listing, no network) → render-ready hits, wrapped in the
       loading → (list | empty | err) state machine; empty and error are
       SEPARATE chains (t_96fcfc2a pin — never merged into "no data").
       FRESH remote fetch (contract §4.3 GET /inventory?search= via
       FcApi.listProducts) is the remote sibling chain.
     * quick-select ADD chain: picked product + amount text →
       QuickSelect.resolveEntry (template A grammar, §13.3 order: resolve
       FIRST, then amount) → working-set entry {source:"quick"}. Blocked
       inputs (cross-family, empty amount, unknown uid) NEVER reach the
       working set — resolve never clamps (§13.2 mirror rule).
     * live PREVIEW block — whole-batch preview built with
       QuickSelect.perIngredientMirror (display twin of the server's
       macros.py math). Non-authoritative (§13.4): Számolás stays the
       truth; this re-renders when a quick entry is pushed or a custom
       row is saved (totals update rule, task body).

   Pure logic: no live DOM, no direct fetch, no backend requirement.
   Node-safe: requires only under Node (globalThis, no window); the
   browser wires by window-injection only. Seed/marker replay (§5.3
   "%E2%QA23"-style keys, seed3-marker) is NOT decoded here — §13.4/§13.7
   own-data rule: fresh suites carry no seed keys and read their data
   from the script; this file owns the live UI chains + their §13.2
   block-first mirrors.
   ============================================================ */
(function (root) {
  "use strict";
  var node = (typeof require === "function") && (typeof window === "undefined");
  var QS = null, Inv = null;
  if (node) {
    // UMD tails hang the handle itself off module.exports; accept both shapes.
    try { var m1 = require("./quickpick.js"); QS = m1.QuickSelect || m1; } catch (e) { QS = null; }
    try { var m2 = require("./invsync.js"); Inv = m2.InvSync || m2; } catch (e) { Inv = null; }
  } else if (root) {
    QS = root.QuickSelect || null;
    Inv = root.InvSync || null;
  }

  var MACROS = ["calories", "protein", "fat", "carbs", "fiber", "sugar", "sodium"];

  function r2(n) { return Math.round(n * 100) / 100; }
  function un(v) { return v === "" || v === null || v === undefined ? null : v; }
  function num(v) {
    if (v === "" || v === null || v === undefined) return null;
    var n = parseFloat(String(v).replace(/,/g, "."));
    return isFinite(n) ? n : null;
  }
  function clone(o) { return o === null || o === undefined ? o : JSON.parse(JSON.stringify(o)); }

  /* ---------- seed-chain lookup (pairing side) --------------------------
     A seeding call carries {recipe, custom, uidToPid, listing}: the
     complete chain input (uid→product backing + per-ingredient display
     amount/unit + custom rows → §13 A0/A4 "all-present resolves to
     null"). Empty amount/unit → blocked-empty; unknown uid → blocked-
     unknown; cross-family unit → blocked-cross (NO clamp, §13.2/§4.1).
     Blocked chains NEVER reach the working set and NEVER re-seed — a
     reseed only clears its own chain and re-runs its own picks (A10:
     "stays blocked until removed"). `opts.countAdapter === true`
     switches to delegated counting (one chain for UI + adapter);
     default-off keeps Node pure (no DOM/fetch), §13.4. */
  function chainState(call, opts) {
    var o = opts || {};
    var i, list = call.listing || [];
    var byId = {}, byName = {};
    for (i = 0; i < list.length; i++) {
      var d = list[i];
      if (!d) continue;
      if (d.id != null) byId[String(d.id)] = d;
      var nm = String(d.name || "").trim().toLowerCase();
      if (!(nm in byName)) byName[nm] = d;
    }
    function unitToBase(qty, unit, pdoc) { // family gate, NO clamp (§13.2/§4.1)
      if (qty == null || !(qty > 0)) return "blocked-empty";
      var fu = QS && QS.S && typeof QS.S.basisOf === "function" ? QS.S.basisOf(unit) : null;
      var fb = QS && QS.S && typeof QS.S.basisOf === "function"
        ? QS.S.basisOf(String(pdoc.base_unit || "").toLowerCase()) : null;
      if (unit != null && (!fu || !fb || fu.family !== fb.family)) return "blocked-cross";
      var factor = (unit != null && fu && fb && fu.family === fb.family) ? fu.factor / fb.factor : 1;
      return { amount: r2(qty * factor), unit: unit == null ? String(pdoc.base_unit || "").toLowerCase() : unit };
    }
    var res = { recipeId: call.recipeId || null, state: [], blocked: [] };
    var rows = call.recipe || [];
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var pdoc = r.product_id != null ? byId[String(r.product_id)] : null;
      if (!pdoc) continue;                       // unresolved → nothing computable (rule 2)
      var inBase = unitToBase(num(r.amount), un(r.unit), pdoc);
      if (inBase === "blocked-empty") {
        res.blocked.push({ name: r.name,
          message: "Nincs mennyiség megadva ehhez a termékhez (a " + r.name
            + " nem számít be)." });
        continue;
      }
      if (inBase === "blocked-cross") {
        res.blocked.push({ name: r.name,
          message: "Nem számolható: " + r.name + " — a mértékegység ("
            + (r.unit || "—") + ") és a termék alapmértékegysége ("
            + pdoc.base_unit + ") nem ugyanabba a csoportba tartozik." });
        continue;
      }
      res.state.push({ product_id: String(r.product_id), name: r.name,
        quantity: inBase.amount, unit: un(inBase.unit) });
    }
    var customs = call.custom || [];
    for (i = 0; i < customs.length; i++) {
      var c = customs[i];
      var blank = true;
      for (var k = 0; k < MACROS.length; k++) {
        var v = num(c.macros && c.macros[MACROS[k]]);
        if (v != null && v > 0) { blank = false; break; }
      }
      var pv = num(c.price);
      if (!blank || (pv != null && pv > 0)) blank = false;
      if (blank) continue;                        // computable-only (rule 2)
      var ent = { name: String(c.name || "").trim(), quantity: un(c.amount),
        unit: un(c.unit), type: "custom", macros: {}, source: "quick-glue" };
      for (var k2 = 0; k2 < MACROS.length; k2++) {
        ent.macros[MACROS[k2]] = un(c.macros && c.macros[MACROS[k2]]);
      }
      var cur = un(c.currency);
      if (pv != null) { ent.price = { amount: pv, currency: cur || "HUF" }; }
      if (cur && String(cur).toUpperCase() !== "HUF") {
        ent.warnings = ["CROSS_CURRENCY_EXCLUDED"];  // display-only note, §4.3 rule 2
      }
      res.state.push(ent);
    }
    var picks = call.picks || [];                  // pushed quick selects
    for (i = 0; i < picks.length; i++) {
      var pk = picks[i];
      var doc = byId[String(pk.uid)];
      if (!doc) {
        res.blocked.push({ name: pk.name || pk.uid,
          message: "Nem számolható: " + (pk.name || "") + " — nincs olyan raktári"
            + " termék (" + pk.uid + "), a quick kijelöléshez nem tartozik termék." });
        continue;
      }
      var qq = num(pk.amount);
      var qu = un(pk.unit);
      if (qq == null) {                            // empty amount silently skips (UI toasts)
        continue;
      }
      var famU = QS && QS.S && typeof QS.S.basisOf === "function" ? QS.S.basisOf(qu) : null;
      var famP = QS && QS.S && typeof QS.S.basisOf === "function"
        ? QS.S.basisOf(String(doc.base_unit || "").toLowerCase()) : null;
      if (qu != null && (!famU || !famP || famU.family !== famP.family)) {
        res.blocked.push({ name: doc.name,
          message: "Nem számolható kombináció: " + doc.name + " — a megadott egység ("
            + qu + ") nem egyeztethető a termék alapmértékegységéhez ("
            + (doc.base_unit || "?") + ")." });
        continue;
      }
      res.state.push({ product_id: String(doc.id), name: doc.name,
        quantity: r2(qq * (famU && famP && famU.family === famP.family ? famU.factor / famP.factor : 1)),
        unit: un(famP ? famP.base : doc.base_unit), source: "quick" });
    }
    return res;
  }

  /* ---------- harness trio (§13.4/§13.5, §5.3-style replay) --------------
     Mirrors the live §4.4 trio shapes so Node specs can drive through
     them (task body: "Specs must drive this through __test with own
     data"). count()/preview() DELEGATE to the injected adapter when
     present (opts.adapter = {count, preview} — "replace with adapter if
     present"), and otherwise replay own §5.3-style "seed3" strings
     (name + amount + unit, rule 1) via QuickSelect.resolveEntry — never
     a re-derived chain search, never full State math (§13.4). No seed
     markers, no %RESOURCE: keys, no listing fetch under Node (serverless
     + own-data rule, §13.4/§13.7); fresh-chain default is OFF so the
     suites stay serverless. Handlers arrive as FRESH SOURCES (the
     hand-written trio shape, §13.4 — build-script legacy is dead). */
  function makeHandlers(o) {
    o = o || {};
    var adapter = o.adapter || null;   // {count, preview} — replaces re-derivation
    var listing = (o.listing || []).filter(Boolean);
    var byId = {};
    listing.forEach(function (d) { if (d.id != null) byId[String(d.id)] = d; });

    function resolveSeed(seed3) { // own-data §5.3-style replay (NOT chain math)
      var p = String(seed3 || "").trim().split(/\s+/);
      if (p.length < 2) return { blocked: true, code: "UNRESOLVED",
        message: "UNRESOLVED (" + seed3 + " — seed3 needs name + amount, §5.3 rule 1)" };
      var name = p[0];
      var doc = null;
      for (var i = 0; i < listing.length; i++) {
        var nm = String(listing[i].name || "").trim().toLowerCase();
        if (nm === name.toLowerCase()) { doc = listing[i]; break; }
      }
      if (!doc) return { blocked: true, code: "NO_MATCH",
        message: "NO_MATCH (" + seed3 + " — name not in listing, §13.3)" };
      var amountText = p.slice(1).join(" ");
      if (QS && typeof QS.resolveEntry === "function") {
        return QS.resolveEntry(doc, amountText);   // template A grammar, §13.3
      }
      return { blocked: true, code: "NO_ADAPTER", message: "NO_ADAPTER" };
    }
    function collect() { // §13.2 chain mirror — empty inputs ignored
      var out = { items: [], blocked: [], skipped: [] };
      var seeds = o.seeds || [];
      seeds.forEach(function (s) {
        var r = resolveSeed(s);
        if (r.skipped) { out.skipped.push(s); return; }          // empty = never count
        if (r.blocked) { out.blocked.push({ seed: s, code: r.code, message: r.message }); return; }
        if (r.resolved) out.items.push(r.item);
      });
      // §13.2 block-first: ANY blocked seed → whole batch refused (no clamp,
      // no silent drop); blocked batches NEVER POST.
      if (out.blocked.length) return { blocked: true, kind: "chain", blocked_keys: out.blocked,
        message: "Nem számolható: " + out.blocked.map(function (b) { return b.code; }).join(", ") };
      return out;
    }
    function count(items, opts) {
      if (adapter && typeof adapter.count === "function") return adapter.count(items, opts);
      return { kind: "chain", skipped: true, message:
        "no adapter injected — delegate mode only (defaults OFF under Node, §13.4)" };
    }
    function preview(agg) {
      if (adapter && typeof adapter.preview === "function") return adapter.preview(agg);
      return { kind: "chain", skipped: true, message: "preview delegated (formatting-only here)" };
    }
    function state() { return { listing: listing.length, adapter: !!adapter, unit_table: 49 }; }
    return { collect: collect, count: count, preview: preview, state: state };
  }

  /* ---------- previewText — FORMATTING ONLY (no math re-derivation) -----
     Renders whatever the data block returns (per-ingredient mirror or
     aggregate): flagged rows → "Nem számolható:" block lines that stay
     UNPARSED (§13.6-2 — the accept-8 no-dot default also stays
     unparsed); zero/empty macros never counted (§13.2-2: empty = never
     counted, renders as DEFAULT_BLOCKED); double keys render under BOTH
     currency lines, never merged (§13.7); per-key warnings (§13.2
     blocked-keys rule) render as warnings beside the row. */
  function previewText(result, labels) {
    var L = labels || {};
    var lines = [];
    var rows = (result && result.per) ? result.per : (Array.isArray(result) ? result : []);
    rows.forEach(function (row) {
      var name = row.name_override || row.name || row.product_id || "?";
      if (row.flagged || (row.warnings && row.warnings.length && !row.macros)) {
        lines.push((L.blocked || "Nem számolható") + ": " + name + " — " +
          (row.message || row.code || (L.unparsed || "UNPARSED")));   // stays unparsed
        return;
      }
      var m = row.macros || {};
      var shown = MACROS.filter(function (k) { return m[k] != null; });
      if (!shown.length) { lines.push((L.blocked || "Nem számolható") + ": " + name +
        " — " + (L.default_blocked || "DEFAULT_BLOCKED")); return; }    // empty never counted
      var parts = shown.map(function (k) { return k + " " + m[k]; });
      var cost = row.cost == null ? "" : " · " + row.cost + " " + (row.cost_currency || "Ft");
      lines.push(name + (row.quantity != null ? " " + row.quantity + (row.unit ? " " + row.unit : "") : "") +
        " — " + parts.join(", ") + cost);
      if (row.cost_currency && row.cost_currency !== "HUF") {       // §13.7 double currency
        lines.push("  · " + row.cost_currency + " (külön, nem számít össze Ft-tel)");
      }
    });
    return lines.join("\n");
  }

  root.PairingUI = { chainState: chainState, makeHandlers: makeHandlers,
    previewText: previewText, MACROS: MACROS };
  if (typeof module !== "undefined" && module.exports) module.exports = root.PairingUI;
})(typeof window !== "undefined" ? window : globalThis);
