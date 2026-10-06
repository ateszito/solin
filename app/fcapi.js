/* ============================================================
   Solin v3 — fcapi.js
   Shared API helper for the product-inventory + macro-count
   backend. Used by app/foodcounter.js AND app/pairing.js so the
   two views share the exact same canonical base and error shape.

   Canonical API base (locked by devops t_7fc7904f + parent
   t_47368aba on 2026-09-26):
       apiBase() + '/api/v1/inventory'
   where apiBase() is baked by the Dockerfile into
   window.SOLIN_CONFIG.API_BASE_URL (= https://solin-dev.ateszito.com
   on dev, https://solin-staging.ateszito.com on staging,
   https://solin.ateszito.com on prod).

   This file is loaded BEFORE foodcounter.js and pairing.js in
   index.html, so window.FcApi is available in both.
   ============================================================ */
window.FcApi = (function () {
  "use strict";

  function apiBase() {
    const b = window.SolinCfg && window.SolinCfg.apiBase;
    return (typeof b === "function" ? b() : b) || "";
  }
  function base() {
    return apiBase() + "/api/v1/inventory";
  }

  /* ---- one fetch wrapper: parse JSON + normalize {code,message,fields} ---- */
  async function api(path, options) {
    const url = (base() + (path || "")).replace(/\/+$/, "");
    const res = await fetch(url, options);
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      const msg = (body && body.message) || (res.status + " " + res.statusText);
      const err = new Error(msg);
      err.status = res.status;
      err.code = body && body.code;
      throw err;
    }
    return res.status === 204 ? null : body;
  }

  /* ---- list products (GET /api/v1/inventory?limit=50) ----
     Returns the raw `items` array. Consumers may cache it
     (window.__FC_PRODUCTS by convention) for picker rendering. */
  async function listProducts(search) {
    const q = search ? "?limit=50&search=" + encodeURIComponent(search)
                     : "?limit=50";
    const doc = await api(q);
    return doc.items || [];
  }

  /* ---- fetch one product (GET /api/v1/inventory/{id}) ---- */
  function getProduct(id) {
    return api("/" + encodeURIComponent(id));
  }

  /* ---- create / update (POST / PUT /api/v1/inventory[...]) ----
     `body` follows the §3.4 independent-partial-fields contract. */
  async function createProduct(body) {
    return api("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function updateProduct(id, body) {
    return api("/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function deleteProduct(id) {
    return api("/" + encodeURIComponent(id), { method: "DELETE" });
  }

  /* ---- image upload (POST /inventory/{id}/images/{slot}) ----
     `slot` is "product_photo" | "label_photo"; `file` is a Blob / File. */
  async function uploadImage(id, slot, file) {
    const fd = new FormData();
    fd.append("file", file);
    return api("/" + encodeURIComponent(id) + "/images/" + slot, {
      method: "POST",
      body: fd,
    });
  }

  /* ---- real-macro count (POST /inventory/macros/count) ----
     `items` = [{product_id, quantity, unit, name_override?, note?}].
     Returns the canonical §4.4 MacroResult:
     {
       totals: {calories, protein, carbs, fat, fiber, sugar, sodium},
       per_ingredient: [
         {product_id, name, quantity, unit, macros:{...7},
          cost, warnings:[...]}
       ],
       total_cost: {amount, currency} | null,
       warnings: [{code, product_id}]
     }
     Missing products are *reported* (200 + PRODUCT_NOT_FOUND row),
     unit-family mismatches are reported (UNITS_INCOMPATIBLE row). */
  function countMacros(items) {
    return api("/macros/count", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items || [] }),
    });
  }

  /* ---- local cache for the picker (shared between foodcounter + pairing) ----
     Call site passes a cacheKey string so the two views never collide. */
  async function listCached(cacheKey, force) {
    const bucket = window.__FCPI_BY = window.__FCPI_BY || {};
    const now = Date.now();
    if (!force && bucket[cacheKey] && (now - bucket[cacheKey].ts) < 60000) {
      return bucket[cacheKey].items;
    }
    const items = await listProducts();
    bucket[cacheKey] = { ts: now, items };
    return items;
  }

  function imgSrc(url) {
    if (!url) return "";
    if (/^(https?:)?\/\//.test(url)) return url;
    return url.startsWith("/") ? url : "/" + url;
  }

  function fmt(v) {
    if (v == null) return "–";
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    return (Math.round(n * 100) / 100).toString();
  }

  /* ---- unit family compatibility (mirrors backend/inventory/macros.py
         §4.5 family-based conversion table so the UI can pre-filter
         which units the user can meaningfully enter for a product). ---- */
  const UNIT_FAMILIES = {
    mass:   ["g", "kg", "mg"],
    liquid: ["ml", "l"],
    count:  ["pcs"],
  };
  function unitFamily(u) {
    u = String(u || "").trim().toLowerCase();
    for (const fam of Object.keys(UNIT_FAMILIES)) {
      if (UNIT_FAMILIES[fam].includes(u)) return fam;
    }
    return null;
  }
  /* Return the units the API will accept given the product base unit.
     (Same unit family; otherwise UNITS_INCOMPATIBLE + zero row.) */
  function allowedUnitsFor(product) {
    const bu = String((product && product.base_unit) || "").toLowerCase();
    const fam = unitFamily(bu);
    if (!fam) return ["g", "ml", "pcs"];
    return UNIT_FAMILIES[fam];
  }

  return {
    api, base, apiBase,
    listProducts, listCached,
    getProduct, createProduct, updateProduct, deleteProduct,
    uploadImage, countMacros,
    imgSrc, fmt,
    UNIT_FAMILIES, unitFamily, allowedUnitsFor,
  };
})();
