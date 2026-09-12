/* ============================================================
   Solin v3 — edit.js
   Recipe editor: fields, macros, dynamic ingredient & step rows.
   Saves a patch to SolinStore and refreshes the detail view.
   ============================================================ */

window.Edit = (function () {
  const { $, $$, S, state, esc, toast, go } = window.Solin;

  function row(label, name, val) { return `<div class="field"><label>${label}</label><input name="${name}" value="${esc(val)}" /></div>`; }

  function buildIngredients(r) {
    const rows = (r.ingredients || []).map(ing => `
      <li>
        <input name="ing-name" placeholder="name" value="${esc(ing.name)}"/>
        <input name="ing-qty" placeholder="qty" value="${esc(ing.qty ?? "")}"/>
        <input name="ing-note" placeholder="note" value="${esc(ing.note ?? "")}"/>
        <button type="button" class="rm" aria-label="remove">×</button>
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
        <input name="st-t" placeholder="sec" value="${esc(s.t ?? "")}" style="max-width:90px"/>
        <input name="st-text" placeholder="step" value="${esc(s.text)}" style="flex:2 1 200px"/>
        <button type="button" class="rm" aria-label="remove">×</button>
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
    const patched = S.editFields(r.id);
    $("#edit-form").innerHTML = `
      ${row("Cím", "title", r.title)}
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
      <div class="field"><label>Leírás</label><textarea name="description" rows="3">${esc(r.description)}</textarea></div>
      <div class="field"><label>Ccimkék (vesszővel)</label><input name="tags" value="${esc((r.tags||[]).join(", "))}"/></div>
      ${buildIngredients(r)}
      ${buildSteps(r)}
      <p class="hint">A szerkesztett mezők: <b>${patched.length ? esc(patched.join(", ")) : "nincs szerkesztés még"}</b> — ezek a korrekciók maradnak meg ezen a készüléken és visszajátsszák a receptnél.</p>
    `;

    // dynamic row adders
    $("#ing-add").addEventListener("click", () => {
      const li = document.createElement("li");
      li.innerHTML = `<input name="ing-name" placeholder="name"/><input name="ing-qty" placeholder="qty"/><input name="ing-note" placeholder="note"/><button type="button" class="rm">×</button>`;
      $("#ing-dyn").appendChild(li); wireRm(li);
    });
    $("#step-add").addEventListener("click", () => {
      const li = document.createElement("li");
      li.innerHTML = `<input name="st-t" placeholder="sec" style="max-width:90px"/><input name="st-text" placeholder="step" style="flex:2 1 200px"/><button type="button" class="rm">×</button>`;
      $("#step-dyn").appendChild(li); wireRm(li);
    });
    const wireRm = (scope) => scope.querySelectorAll(".rm").forEach((b) =>
      b.addEventListener("click", () => b.closest("li").remove())
    );
    wireRm($("#edit-form"));

    $("#edit-save").addEventListener("click", () => save(r));
    $("#edit-reset").addEventListener("click", () => {
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

    if (Object.keys(macros).length) patch.macrosPerServing = Object.assign({}, r.macrosPerServing || {}, macros);
    if (!Object.keys(patch).length) { toast("Nincs változtatás elmenteni."); return; }

    S.saveEdit(r.id, patch);
    toast("Mentve ✓ — korrekciók élesben");
    go("recipe");
  }

  return { render };
})();
