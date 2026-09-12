/* ============================================================
   Solin v3 — state.js
   Persistence layer: localStorage keys + load/save helpers.
   Edits are stored as per-recipe patches layered over SOLIN_DATA.
   ============================================================ */

window.SolinStore = (function () {
  const K = {
    edits:      "solin.edits.v1",     // { recipeId: {field: value, ...} } (incl. ingredients/steps arrays)
    inventory:  "solin.inventory.v1", // [{name, qty, unit, subs: [..]}]
    have:       "solin.have.v1",      // [string] — "what I have at home"
    ui:         "solin.ui.v1"         // last active tab, filters
  };

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  /* ---- recipes: merge seed data with user edits ---- */
  function getRecipes() {
    const edits = load(K.edits, {});
    return window.SOLIN_DATA.recipes.map((r) => {
      const patch = edits[r.id] || {};
      const out = Object.assign({}, r);
      Object.keys(patch).forEach((f) => { out[f] = patch[f]; });
      return out;
    });
  }
  function getRecipe(id) {
    return getRecipes().find((r) => r.id === id) || null;
  }
  function saveEdit(id, patch) {
    const edits = load(K.edits, {});
    edits[id] = Object.assign({}, edits[id] || {}, patch);
    save(K.edits, edits);
  }
  function resetEdits(id) {
    const edits = load(K.edits, {});
    delete edits[id];
    save(K.edits, edits);
  }
  function hasEdits(id) {
    const e = load(K.edits, {})[id];
    return !!(e && Object.keys(e).length);
  }
  function editFields(id) {
    return Object.keys(load(K.edits, {})[id] || {});
  }

  /* ---- inventory ---- */
  const INV_DEFAULT = (function () {
    // Pre-seed from SOLIN_DATA.suggestedSubs so the inventory
    // starts ready-to-use even before the user adds anything.
    const list = [];
    Object.entries(window.SOLIN_DATA.suggestedSubs).forEach(([base, subs]) => {
      if (!list.find((i) => i.name === base)) list.push({ name: base, qty: "", unit: "", subs: [].concat(subs) });
    });
    return list;
  })();

  function getInventory() {
    const v = load(K.inventory, null);
    return v || INV_DEFAULT;
  }
  function setInventory(list) { save(K.inventory, list); }

  function findByBase(name) {
    const n = norm(name);
    return getInventory().find((i) => norm(i.name) === n) || null;
  }

  /* ---- what I have ---- */
  function getHave()  { return load(K.have, []); }
  function setHave(l) { save(K.have, l); }

  /* ---- ui ---- */
  function getUI()   { return load(K.ui, { tab: "browse", tag: null }); }
  function setUI(u)  { save(K.ui, u); }

  // Hungarian-tolerant normalization for ingredient matching
  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/ö/g, "o").replace(/ő/g, "o")
      .replace(/ü/g, "u").replace(/ű/g, "u")
      .replace(/á/g, "a").replace(/é/g, "e").replace(/í/g, "i")
      .replace(/cs/g, "c").replace(/gy/g, "g").replace(/ly/g, "l")
      .replace(/ny/g, "n").replace(/sz/g, "s").replace(/ty/g, "t").replace(/dzs/g, "ds")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .join(" ");
  }
  function similar(a, b) {
    // a or b contains the other, or they normalize equal
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    return na === nb || na.includes(nb) || nb.includes(na);
  }

  return {
    K, load, save,
    getRecipes, getRecipe, saveEdit, resetEdits, hasEdits, editFields,
    getInventory, setInventory, findByBase,
    getHave, setHave,
    getUI, setUI,
    norm, similar
  };
})();
