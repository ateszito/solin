/* ============================================================
   Solin v3 — edit.js
   Recipe editor: fields, macros, dynamic ingredient & step rows.
   Saves a patch to SolinStore and refreshes the detail view.
   ============================================================ */

window.Edit = (function () {
  const { $, $$, S, state, esc, toast, go } = window.Solin;

  let editingImages = [];

  function row(label, name, val) { return `<div class="field"><label for="ed-${name}">${label}</label><input id="ed-${name}" name="${name}" value="${esc(val)}" /></div>`; }

  function buildPhotos(images) {
    const listHtml = (images || []).map((src, idx) => `
      <div class="rec-photo-item" data-idx="${idx}">
        <img src="${esc(src)}" alt="Recept fotó ${idx + 1}" />
        <button type="button" class="rec-photo-del" title="Fotó törlése" aria-label="Fotó törlése">×</button>
        <span class="rec-photo-badge">${idx === 0 ? "Fő kép" : (idx + 1) + ". kép"}</span>
      </div>`).join("");
    return `
      <div class="field">
        <label>Recept fotók</label>
        <div class="rec-photos-grid" id="rec-photos-grid">
          ${listHtml}
        </div>
        <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <input type="file" id="ed-photos-input" accept="image/*" multiple style="display:none;" />
          <button type="button" class="btn sm" id="ed-add-photo">📷 Fotó hozzáadása</button>
          <span class="hint" style="margin:0;">Fényképezd le az ételt vagy a receptkönyv oldalát!</span>
        </div>
      </div>`;
  }

  function buildIngredients(r) {
    const rows = (r.ingredients || []).map(ing => `
      <li>
        <input name="ing-name" placeholder="név" aria-label="hozzávaló neve" value="${esc(ing.name)}"/>
        <input name="ing-qty" placeholder="mennyiség" aria-label="mennyiség" value="${esc(ing.qty ?? "")}"/>
        <input name="ing-note" placeholder="megjegyzés" aria-label="megjegyzés" value="${esc(ing.note ?? "")}"/>
        <button type="button" class="rm" aria-label="sor törlése">×</button>
      </li>`).join("");
    return `
      <div class="field">
        <label>Hozzávalók (1 sor = 1 hozzávaló)</label>
        <ul class="dyn-list" id="ing-dyn">${rows}</ul>
        <button type="button" class="btn sm add-row" id="ing-add">＋ hozzávaló sor</button>
      </div>`;
  }

  function buildSteps(r) {
    const rows = (r.steps || []).map((s, i) => `
      <li>
        <input name="st-t" placeholder="mp" inputmode="decimal" aria-label="videó időpont (mp)" value="${esc(s.t ?? "")}" style="max-width:90px"/>
        <input name="st-text" placeholder="lépés leírása" aria-label="lépés" value="${esc(s.text)}" style="flex:2 1 200px"/>
        <button type="button" class="rm" aria-label="sor törlése">×</button>
      </li>`).join("");
    return `
      <div class="field">
        <label>Lépések (videó-szinkron: mp → szöveg)</label>
        <ul class="dyn-list" id="step-dyn">${rows}</ul>
        <button type="button" class="btn sm add-row" id="step-add">＋ lépés sor</button>
      </div>`;
  }

  function readDyn(list, pick) {
    return Array.from(list.querySelectorAll("li"))
      .map((li) => pick(li))
      .filter((o) => Object.values(o).some((v) => String(v ?? "").trim() !== ""));
  }

  function render() {
    const r = S.getRecipe(state.activeRecipe);
    if (!r) { go("browse"); return; }
    editingId = r.id;
    const isNew = !!r._blank;
    // Same form serves "edit an existing recipe" and "fill in a new one".
    $("#view-edit .view-title").textContent = isNew ? "Új recept" : "Recept szerkesztése";
    $("#edit-back").textContent = isNew ? "← Mégse" : "← Vissza a recepthez";
    $("#edit-reset").hidden = isNew;
    $("#edit-save").textContent = isNew ? "Recept mentése" : "Mentés";
    const introHint = $("#view-edit > .hint");
    if (introHint) introHint.textContent = isNew
      ? "Add meg a recept adatait. A recept ezen a készüléken mentődik; ha mentés nélkül lépsz ki, nem jön létre."
      : "A javításaid ezen a készüléken mentődnek, az eredeti recept fölé rétegezve. A „Visszaállítás” visszaállítja az eredetit.";
    const patched = S.editFields(r.id);
    editingImages = ((Array.isArray(r.images) && r.images.length)
      ? r.images.map((im) => (typeof im === "string" ? im : (im.url || im.data_url))).filter(Boolean)
      : (r.image ? [r.image] : [])).slice();

    // a new recipe starts with one empty ingredient + step row to type into
    const rows = isNew && !(r.ingredients || []).length
      ? Object.assign({}, r, { ingredients: [{ name: "", qty: "" }], steps: [{ t: "", text: "" }] })
      : r;
    $("#edit-form").innerHTML = `
      <div class="field"><label for="ed-title">Cím${isNew ? " *" : ""}</label><input id="ed-title" name="title" value="${esc(r.title)}" ${isNew ? 'placeholder="pl. Csirkés tészta" required' : ""}/></div>
      <div class="grid2">${row("Szerző", "creator", r.creator)}${row("Konyha", "cuisine", r.cuisine)}</div>
      <div class="grid3">
        <div class="field"><label>Adag</label><input name="servings" type="number" value="${esc(r.servings)}"/></div>
        <div class="field"><label>Kalória / adag</label><input name="kcal" type="number" step="1" value="${esc((r.macrosPerServing||{}).kcal)}"/></div>
        <div class="field"><label>Fehérje (g)</label><input name="protein" type="number" step="0.1" value="${esc((r.macrosPerServing||{}).protein)}"/></div>
      </div>
      <div class="grid3">
        <div class="field"><label>Szénhidrát (g)</label><input name="carbs" type="number" step="0.1" value="${esc((r.macrosPerServing||{}).carbs)}"/></div>
        <div class="field"><label>Zsír (g)</label><input name="fat" type="number" step="0.1" value="${esc((r.macrosPerServing||{}).fat)}"/></div>
        <div class="field"><label>Összes idő (perc)</label><input name="totalMin" type="number" value="${esc(r.totalMin)}"/></div>
      </div>
      <div class="field"><label for="ed-description">Leírás</label><textarea id="ed-description" name="description" rows="3">${esc(r.description)}</textarea></div>
      <div class="field"><label for="ed-tags">Címkék (vesszővel elválasztva)</label><input id="ed-tags" name="tags" value="${esc((r.tags||[]).join(", "))}"/></div>
      ${buildPhotos(editingImages)}
      ${buildIngredients(rows)}
      ${buildSteps(rows)}
      ${isNew ? "" : `<p class="hint">A szerkesztett mezők: <b>${patched.length ? esc(patched.join(", ")) : "nincs szerkesztés még"}</b> — ezek a korrekciók ezen a készüléken maradnak, és a receptnél megjelennek.</p>`}
    `;
    if (isNew) setTimeout(() => { const t = $("#ed-title"); if (t) t.focus(); }, 0);

    function paintPhotos() {
      const grid = $("#rec-photos-grid");
      if (!grid) return;
      grid.innerHTML = (editingImages || []).map((src, idx) => `
        <div class="rec-photo-item" data-idx="${idx}">
          <img src="${esc(src)}" alt="Recept fotó ${idx + 1}" />
          <button type="button" class="rec-photo-del" title="Fotó törlése" aria-label="Fotó törlése">×</button>
          <span class="rec-photo-badge">${idx === 0 ? "Fő kép" : (idx + 1) + ". kép"}</span>
        </div>`).join("");
      wirePhotoEvents();
    }

    function wirePhotoEvents() {
      const grid = $("#rec-photos-grid");
      if (!grid) return;
      grid.querySelectorAll(".rec-photo-item").forEach((item) => {
        const idx = parseInt(item.dataset.idx, 10);
        const img = item.querySelector("img");
        if (img) {
          img.addEventListener("click", () => {
            const lb = window.Solin.openLightbox || (window.FoodCounter && FoodCounter.openLightbox);
            if (lb) lb(editingImages[idx], "Recept fotó");
          });
        }
        const delBtn = item.querySelector(".rec-photo-del");
        if (delBtn) {
          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            editingImages.splice(idx, 1);
            paintPhotos();
          });
        }
      });
    }

    const addPhotoBtn = $("#ed-add-photo");
    const photoInput = $("#ed-photos-input");
    if (addPhotoBtn && photoInput) {
      addPhotoBtn.addEventListener("click", () => photoInput.click());
      photoInput.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        toast("Fotó(k) tömörítése és hozzáadása…");
        for (const f of files) {
          try {
            if (window.SolinImg && SolinImg.compress) {
              const comp = await SolinImg.compress(f);
              if (comp && comp.dataUrl) editingImages.push(comp.dataUrl);
            } else {
              const reader = new FileReader();
              const durl = await new Promise((res, rej) => {
                reader.onload = () => res(reader.result);
                reader.onerror = rej;
                reader.readAsDataURL(f);
              });
              editingImages.push(durl);
            }
          } catch (err) {
            console.error("Photo load error:", err);
          }
        }
        photoInput.value = "";
        paintPhotos();
      });
    }
    wirePhotoEvents();

    // dynamic row adders
    $("#ing-add").addEventListener("click", () => {
      const li = document.createElement("li");
      li.innerHTML = `<input name="ing-name" placeholder="név" aria-label="hozzávaló neve"/><input name="ing-qty" placeholder="mennyiség" aria-label="mennyiség"/><input name="ing-note" placeholder="megjegyzés" aria-label="megjegyzés"/><button type="button" class="rm" aria-label="sor törlése">×</button>`;
      $("#ing-dyn").appendChild(li); wireRm(li);
      li.querySelector("input").focus();
    });
    $("#step-add").addEventListener("click", () => {
      const li = document.createElement("li");
      li.innerHTML = `<input name="st-t" placeholder="mp" inputmode="decimal" aria-label="videó időpont (mp)" style="max-width:90px"/><input name="st-text" placeholder="lépés leírása" aria-label="lépés" style="flex:2 1 200px"/><button type="button" class="rm" aria-label="sor törlése">×</button>`;
      $("#step-dyn").appendChild(li); wireRm(li);
      li.querySelector("[name=st-text]").focus();
    });
    const wireRm = (scope) => scope.querySelectorAll(".rm").forEach((b) =>
      b.addEventListener("click", () => b.closest("li").remove())
    );
    wireRm($("#edit-form"));
  }

  // Bind the static Save / Reset buttons ONCE and resolve the recipe at
  // click time. (Previously every render() added another listener that
  // closed over *that* render's recipe — after editing recipe A then B,
  // "Mentés" also wrote B's form values into A.)
  let _bound = false;
  function init() {
    if (_bound) return;
    _bound = true;
    $("#edit-save").addEventListener("click", () => {
      const r = S.getRecipe(state.activeRecipe);
      if (r) save(r);
    });
    $("#edit-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const r = S.getRecipe(state.activeRecipe);
      if (r) save(r);
    });
    $("#edit-reset").addEventListener("click", () => {
      const r = S.getRecipe(state.activeRecipe);
      if (!r) return;
      if (!S.hasEdits(r.id)) { toast("Nincs helyi módosítás ezen a recepten."); return; }
      if (confirm("Visszaállítod az eredeti receptre? A helyi korrekcióid törölődnek.")) {
        S.resetEdits(r.id); toast("Eredeti állapot visszaállítva"); go("recipe");
      }
    });
  }

  function save(r) {
    const f = $("#edit-form");
    const v = (n) => (f.querySelector(`[name="${n}"]`) || {}).value ?? "";
    const num = (n) => { const x = parseFloat(v(n)); return isNaN(x) ? null : x; };
    const macros = {};
    const mk = r.macrosPerServing || {};
    const kcal = num("kcal"); if (kcal != null && kcal !== mk.kcal) macros.kcal = kcal;
    const protein = num("protein"); if (protein != null && protein !== mk.protein) macros.protein = protein;
    const carbs = num("carbs"); if (carbs != null && carbs !== mk.carbs) macros.carbs = carbs;
    const fat = num("fat"); if (fat != null && fat !== mk.fat) macros.fat = fat;

    const patch = {};
    if (v("title").trim() && v("title") !== r.title) patch.title = v("title").trim();
    if (v("creator").trim() && v("creator") !== r.creator) patch.creator = v("creator").trim();
    if (v("cuisine").trim() && v("cuisine").trim().toLowerCase() !== (r.cuisine || "").toLowerCase()) {
      patch.cuisine = v("cuisine").trim().toLowerCase();
    }
    const servings = num("servings"); if (servings != null && servings !== r.servings) patch.servings = servings;
    const totalMin = num("totalMin"); if (totalMin != null && totalMin !== r.totalMin) patch.totalMin = totalMin;
    if (v("description") !== r.description) patch.description = v("description");
    const tags = v("tags").split(",").map((t) => t.trim()).filter(Boolean);
    if (JSON.stringify(tags) !== JSON.stringify(r.tags)) patch.tags = tags;

    const cleanIng = (arr) => (arr || []).map((o) => {
      const c = { name: String(o.name || "").trim(), qty: String(o.qty || "").trim(), note: String(o.note || "").trim() };
      if (!c.note) delete c.note;
      return c;
    });
    const newIngredientsC = cleanIng(readDyn($("#ing-dyn"), (li) => ({
      name: li.querySelector("[name=ing-name]").value,
      qty: li.querySelector("[name=ing-qty]").value,
      note: li.querySelector("[name=ing-note]").value
    }))).filter((o) => o.name);
    if (JSON.stringify(newIngredientsC) !== JSON.stringify(cleanIng(r.ingredients))) {
      if (newIngredientsC.length) patch.ingredients = newIngredientsC;
    }
    const cleanStep = (arr) => (arr || []).map((o) => ({
      t: Number(o.t ?? 0) || 0,
      text: String(o.text || "").trim()
    })).filter((o) => o.text);
    const newStepsC = cleanStep(readDyn($("#step-dyn"), (li) => ({
      t: li.querySelector("[name=st-t]").value ? parseFloat(li.querySelector("[name=st-t]").value) : 0,
      text: li.querySelector("[name=st-text]").value
    })));
    if (JSON.stringify(newStepsC) !== JSON.stringify(cleanStep(r.steps))) {
      if (newStepsC.length) patch.steps = newStepsC;
    }

    const currentImgs = ((Array.isArray(r.images) && r.images.length)
      ? r.images.map((im) => (typeof im === "string" ? im : (im.url || im.data_url))).filter(Boolean)
      : (r.image ? [r.image] : []));
    if (JSON.stringify(editingImages) !== JSON.stringify(currentImgs)) {
      patch.images = editingImages.slice();
      patch.image = editingImages.length ? editingImages[0] : null;
    }

    if (Object.keys(macros).length) patch.macrosPerServing = Object.assign({}, r.macrosPerServing || {}, macros);
    if (r._blank) {
      if (!v("title").trim()) {
        toast("Adj címet a receptnek");
        const t = f.querySelector("[name=title]"); if (t) t.focus();
        return;
      }
      if (Object.keys(patch).length) S.saveEdit(r.id, patch);
      S.finalizeCustomRecipe(r.id);
      toast("Recept létrehozva ✓");
      go("recipe");
      return;
    }
    if (!Object.keys(patch).length) { toast("Nincs változtatás elmenteni."); return; }

    S.saveEdit(r.id, patch);
    toast("Mentve ✓ — korrekciók élesben");
    go("recipe");
  }

  // Called by the router when the edit view is left. An untouched new
  // recipe draft is discarded so "Üres recept indítása" + back never
  // leaves an empty "(új recept)" behind. Returns true if it was dropped.
  let editingId = null;
  function leave() {
    editingImages = [];
    const id = editingId;
    editingId = null;
    const r = id && S.getRecipe(id);
    if (r && r._blank) { S.deleteCustomRecipe(id); return true; }
    return false;
  }

  return { init, render, leave };
})();
