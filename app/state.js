/* ============================================================
   Solin v3 — state.js
   Persistence layer: localStorage keys + load/save helpers.
   Edits are stored as per-recipe patches layered over SOLIN_DATA.
   ============================================================ */

window.SolinStore = (function () {
  const K = {
    edits:          "solin.edits.v1",          // { recipeId: {field: value, ...} } (incl. ingredients/steps arrays)
    inventory:      "solin.inventory.v1",      // [{name, qty, unit, subs: [..]}]
    have:           "solin.have.v1",           // [string] — "what I have at home"
    ui:             "solin.ui.v1",             // last active tab, filters
    checks:         "solin.checks.v1",         // { recipeId: [ingredient name, ...] } — checked-off ingredients
    stepChecks:     "solin.step_checks.v1",    // { recipeId: [stepIndex, ...] } — completed steps
    meals:          "solin.foodcounter.meals.v1", // [{id, name, items, totals, total_cost, saved_at}]
    deletedRecipes: "solin.deleted_recipes.v1",   // [recipeId, ...] tombstones for cross-device delete sync
    resetEdits:     "solin.reset_edits.v1",       // [recipeId, ...] pending edit resets
    shoppingList:   "solin.shopping_list.v1"      // [{id, name, qty, category, checked, recipe_title}]
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

  /* ---- recipes: merge seed data with user edits ----
     Custom recipes flagged `_blank` are drafts that were started with
     "Üres recept indítása" but never saved — they are hidden from every
     list (only getRecipe(id) resolves them, for the editor). */
  const CUSTOM_KEY = "solin.custom.recipes.v1";
  function getRecipes(opts) {
    const edits = load(K.edits, {});
    const custom = load(CUSTOM_KEY, []);
    const withDrafts = !!(opts && opts.includeDrafts);
    return custom.filter((r) => withDrafts || !r._blank).concat(window.SOLIN_DATA.recipes).map((r) => {
      const patch = edits[r.id] || {};
      const out = Object.assign({}, r);
      Object.keys(patch).forEach((f) => { out[f] = patch[f]; });
      return out;
    });
  }
  function getRecipe(id) {
    return getRecipes({ includeDrafts: true }).find((r) => r.id === id) || null;
  }
  // First successful save turns a draft into a real recipe.
  function finalizeCustomRecipe(id) {
    const nowIso = new Date().toISOString();
    save(CUSTOM_KEY, load(CUSTOM_KEY, []).map((r) => {
      if (r.id !== id || !r._blank) return r;
      const o = Object.assign({}, r, { updated_at: nowIso });
      delete o._blank;
      return o;
    }));
    const delList = load(K.deletedRecipes, []).filter((x) => x !== id);
    save(K.deletedRecipes, delList);
    syncRecipesWithBackend();
  }
  // Drop abandoned drafts (e.g. the tab was closed mid-edit), except
  // the one currently open in the editor.
  function purgeBlankRecipes(exceptId) {
    const list = load(CUSTOM_KEY, []);
    const keep = list.filter((r) => !r._blank || r.id === exceptId);
    if (keep.length !== list.length) {
      list.filter((r) => r._blank && r.id !== exceptId).forEach((r) => resetEdits(r.id));
      save(CUSTOM_KEY, keep);
    }
  }
  function saveEdit(id, patch) {
    const edits = load(K.edits, {});
    const stamped = Object.assign({}, patch, { _updated_at: new Date().toISOString() });
    edits[id] = Object.assign({}, edits[id] || {}, stamped);
    save(K.edits, edits);
    const resets = load(K.resetEdits, []).filter((x) => x !== id);
    save(K.resetEdits, resets);
    syncRecipesWithBackend();
  }
  function resetEdits(id) {
    const edits = load(K.edits, {});
    delete edits[id];
    save(K.edits, edits);
    const resets = load(K.resetEdits, []);
    if (id && !resets.includes(id)) {
      resets.push(id);
      save(K.resetEdits, resets);
    }
    try {
      const base = (window.SolinCfg && window.SolinCfg.apiBase && (typeof window.SolinCfg.apiBase === "function" ? window.SolinCfg.apiBase() : window.SolinCfg.apiBase)) || "";
      const endpoint = (base ? base.replace(/\/+$/, "") : "") + "/api/v1/recipes/edits/" + encodeURIComponent(id);
      fetch(endpoint, { method: "DELETE" }).catch(() => {});
    } catch (e) {}
    syncRecipesWithBackend();
  }
  function hasEdits(id) {
    const e = load(K.edits, {})[id];
    if (!e) return false;
    const keys = Object.keys(e).filter((k) => k !== "_updated_at");
    return keys.length > 0;
  }
  function editFields(id) {
    return Object.keys(load(K.edits, {})[id] || {}).filter((k) => k !== "_updated_at");
  }
  // User-created (u-*) recipes only — seed recipes are immutable.
  function deleteCustomRecipe(id) {
    save(CUSTOM_KEY, load(CUSTOM_KEY, []).filter((r) => r.id !== id));
    const delList = load(K.deletedRecipes, []);
    if (id && !delList.includes(id)) {
      delList.push(id);
      save(K.deletedRecipes, delList);
    }
    resetEdits(id);
    setChecks(id, []);
    setStepChecks(id, []);
    // Delete on backend
    try {
      const base = (window.SolinCfg && window.SolinCfg.apiBase && (typeof window.SolinCfg.apiBase === "function" ? window.SolinCfg.apiBase() : window.SolinCfg.apiBase)) || "";
      const endpoint = (base ? base.replace(/\/+$/, "") : "") + "/api/v1/recipes/" + encodeURIComponent(id);
      fetch(endpoint, { method: "DELETE" }).catch(() => {});
    } catch (e) {}
    syncRecipesWithBackend();
  }

  async function syncRecipesWithBackend() {
    try {
      const base = (window.SolinCfg && window.SolinCfg.apiBase && (typeof window.SolinCfg.apiBase === "function" ? window.SolinCfg.apiBase() : window.SolinCfg.apiBase)) || "";
      const endpoint = (base ? base.replace(/\/+$/, "") : "") + "/api/v1/recipes/sync";
      const localCustom = load(CUSTOM_KEY, []);
      const localEdits = load(K.edits, {});
      const localDeleted = load(K.deletedRecipes, []);
      const localResetEdits = load(K.resetEdits, []);
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          custom_recipes: localCustom.filter((r) => !r._blank),
          edits: localEdits,
          deleted_ids: localDeleted,
          reset_edit_ids: localResetEdits
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        let changed = false;
        const remoteDeleted = new Set(
          (Array.isArray(data.deleted_ids) ? data.deleted_ids : []).concat(localDeleted)
        );
        if (remoteDeleted.size > 0) {
          save(K.deletedRecipes, Array.from(remoteDeleted));
        }
        if (localResetEdits.length > 0) {
          save(K.resetEdits, []);
        }

        if (data && Array.isArray(data.custom_recipes)) {
          const remoteMap = {};
          data.custom_recipes.forEach((r) => { if (r && r.id) remoteMap[r.id] = r; });
          const merged = [];
          const seen = new Set();
          localCustom.forEach((lr) => {
            if (!lr || !lr.id) return;
            if (lr._blank) {
              merged.push(lr);
              seen.add(lr.id);
            } else if (remoteDeleted.has(lr.id)) {
              // Purged by tombstone! Do not keep.
              changed = true;
            } else if (remoteMap[lr.id]) {
              merged.push(Object.assign({}, lr, remoteMap[lr.id]));
              seen.add(lr.id);
            } else {
              merged.push(lr);
              seen.add(lr.id);
            }
          });
          data.custom_recipes.forEach((rr) => {
            if (rr && rr.id && !seen.has(rr.id) && !remoteDeleted.has(rr.id)) {
              merged.push(rr);
              seen.add(rr.id);
              changed = true;
            }
          });
          if (JSON.stringify(merged) !== JSON.stringify(localCustom)) {
            save(CUSTOM_KEY, merged);
            changed = true;
          }
        }
        if (data && data.edits && typeof data.edits === "object") {
          const resetSet = new Set(localResetEdits);
          const mergedEdits = {};
          Object.keys(data.edits).forEach((rid) => {
            if (!resetSet.has(rid) && !remoteDeleted.has(rid)) {
              mergedEdits[rid] = data.edits[rid];
            }
          });
          Object.keys(localEdits).forEach((rid) => {
            if (!remoteDeleted.has(rid)) {
              const loc = localEdits[rid];
              const rem = mergedEdits[rid];
              if (!rem || !rem._updated_at || (loc._updated_at && loc._updated_at >= rem._updated_at)) {
                mergedEdits[rid] = Object.assign({}, rem || {}, loc);
              }
            }
          });
          if (JSON.stringify(mergedEdits) !== JSON.stringify(localEdits)) {
            save(K.edits, mergedEdits);
            changed = true;
          }
        }
        return changed;
      }
    } catch (e) {
      console.warn("Recipes background sync failed:", e);
    }
    return false;
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

  let _kamraCache = null;

  async function syncKamraFromApi() {
    try {
      const base = (window.SolinCfg && window.SolinCfg.apiBase && (typeof window.SolinCfg.apiBase === "function" ? window.SolinCfg.apiBase() : window.SolinCfg.apiBase)) || "";
      const endpoint = (base ? base.replace(/\/+$/, "") : "") + "/api/v1/kamra";
      const resp = await fetch(endpoint);
      if (resp.ok) {
        const items = await resp.json();
        if (Array.isArray(items) && items.length) {
          _kamraCache = items;
          save(K.inventory, items);
          return items;
        }
      }
    } catch (e) {
      console.warn("Could not sync Kamra from API, using local storage:", e);
    }
    return getInventory();
  }

  function getInventory() {
    if (_kamraCache && _kamraCache.length) return _kamraCache;
    const v = load(K.inventory, null);
    if (v && v.length) {
      _kamraCache = v;
      return v;
    }
    return INV_DEFAULT;
  }
  function setInventory(list) {
    _kamraCache = list;
    save(K.inventory, list);
  }

  function findByBase(name) {
    const n = norm(name);
    return getInventory().find((i) => {
      if (norm(i.name) === n) return true;
      if (i.name_en && norm(i.name_en) === n) return true;
      if (Array.isArray(i.synonyms) && i.synonyms.some((s) => norm(s) === n)) return true;
      return false;
    }) || null;
  }

  // Known substitutes for an ingredient: the user's pantry entry first,
  // then the seed suggestions — de-duplicated (similar() equality).
  // Shared by the recipe detail view and the "Mit főzzek?" matcher.
  function subsFor(name) {
    const inv = findByBase(name);
    const fromInv = inv ? (inv.subs || []) : [];
    const seed = (window.SOLIN_DATA && window.SOLIN_DATA.suggestedSubs) || {};
    const baseKey = Object.keys(seed).find((k) => similar(k, name));
    const fromSeed = baseKey ? seed[baseKey] : [];
    const out = [];
    fromInv.concat(fromSeed).forEach((s) => {
      const str = typeof s === "string" ? s : (s.name || s.name_en || "");
      if (str && !out.some((o) => similar(o, str))) out.push(str);
    });
    return out;
  }

  /* ---- ingredient check-off (survives reloads — you can leave the
         app mid-cook and come back to the same state) ---- */
  function getChecks(id) {
    const all = load(K.checks, {});
    return Array.isArray(all[id]) ? all[id] : [];
  }
  function setChecks(id, names) {
    const all = load(K.checks, {});
    if (names && names.length) all[id] = names; else delete all[id];
    save(K.checks, all);
  }

  /* ---- step completion check-off ---- */
  function getStepChecks(id) {
    const all = load(K.stepChecks, {});
    return Array.isArray(all[id]) ? all[id] : [];
  }
  function setStepChecks(id, indices) {
    const all = load(K.stepChecks, {});
    if (indices && indices.length) all[id] = indices; else delete all[id];
    save(K.stepChecks, all);
  }

  /* ---- what I have (unified Kamra stock) ---- */
  function getHave()  { return load(K.have, []); }
  function setHave(l) { save(K.have, l); }
  function isInStock(name) {
    const have = getHave();
    return have.some((h) => similar(h, name));
  }
  function toggleStock(name) {
    const clean = String(name || "").trim();
    if (!clean) return getHave();
    const have = getHave();
    const idx = have.findIndex((h) => similar(h, clean));
    if (idx >= 0) {
      have.splice(idx, 1);
    } else {
      have.push(clean);
    }
    setHave(have);
    return have;
  }

  /* ---- smart shopping list ---- */
  function getShoppingList() {
    return load(K.shoppingList, []);
  }
  function setShoppingList(list) {
    save(K.shoppingList, Array.isArray(list) ? list : []);
  }
  function addShoppingItems(items, recipeTitle) {
    const list = getShoppingList();
    let addedCount = 0;
    (items || []).forEach((item) => {
      const rawName = typeof item === "string" ? item : (item && item.name) || "";
      const name = String(rawName).trim();
      if (!name || isInStock(name)) return;
      const qty = (typeof item === "object" && item && item.qty) ? String(item.qty).trim() : "";
      const invEntry = findByBase(name);
      const category = (invEntry && invEntry.category) || "other";
      const existing = list.find((x) => !x.checked && similar(x.name, name));
      if (existing) {
        if (qty && existing.qty && !existing.qty.includes(qty)) {
          existing.qty = existing.qty + " + " + qty;
        } else if (qty && !existing.qty) {
          existing.qty = qty;
        }
        if (recipeTitle && existing.recipe_title && !existing.recipe_title.includes(recipeTitle)) {
          existing.recipe_title = existing.recipe_title + ", " + recipeTitle;
        }
      } else {
        list.push({
          id: "shp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
          name: invEntry ? invEntry.name : name,
          name_en: invEntry ? (invEntry.name_en || "") : "",
          qty: qty,
          category: category,
          checked: false,
          recipe_title: recipeTitle || ""
        });
        addedCount++;
      }
    });
    setShoppingList(list);
    return addedCount;
  }

  /* ---- ui ---- */
  function getUI()   { return load(K.ui, { tab: "browse", tag: null }); }
  function setUI(u)  { save(K.ui, u); }

  /* ---- saved meals (food counter sessions, client-side) ---- */
  function getMeals() { return load(K.meals, []); }
  function saveMeals(l) { save(K.meals, l); }

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
    getRecipes, getRecipe, saveEdit, resetEdits, hasEdits, editFields, deleteCustomRecipe,
    finalizeCustomRecipe, purgeBlankRecipes, syncRecipesWithBackend,
    getInventory, setInventory, syncKamraFromApi, findByBase, subsFor,
    getChecks, setChecks,
    getStepChecks, setStepChecks,
    getHave, setHave, isInStock, toggleStock,
    getShoppingList, setShoppingList, addShoppingItems,
    getUI, setUI,
    getMeals, saveMeals,
    norm, similar
  };
})();
