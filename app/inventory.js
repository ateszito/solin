/* ============================================================
   Solin v3 — inventory.js
   Ingredient inventory + substitutes. Persists to SolinStore.
   ============================================================ */

window.Inventory = (function () {
  const { $, $$, S, esc, toast } = window.Solin;
  let inventoryChangedCallback = null;
  function onInventoryChanged(cb) { inventoryChangedCallback = cb; }

  function refreshSubSelect() {
    const sel = $("#sub-for");
    const inv = S.getInventory();
    sel.innerHTML = inv.map((i) =>
      `<option value="${esc(i.name)}">${esc(i.name)}</option>`
    ).join("");
  }

  function render() {
    const inv = S.getInventory();
    refreshSubSelect();
    $("#inv-count").textContent = inv.length + " alapanyag";
    $("#inv-list").innerHTML = inv.length ? inv.map((i) => {
      const subs = (i.subs || []).map((s) => `<span class="inv-alt">↳ ${esc(s)}</span>`).join(" ");
      return `<li>
        <span class="inv-name">${esc(i.name)}${i.qty ? `<small>${esc(i.qty)} ${esc(i.unit || "")}</small>` : ""}</span>
        ${subs}
        <button class="rm" data-rm="${esc(i.name)}" aria-label="${esc(i.name)} törlése" title="Törlés">×</button>
      </li>`;
    }).join("") : `<li class="hint">Még üres — add hozzá valamit felül.</li>`;
  }

  // Bind static controls ONCE. (Previously render() re-attached these on
  // every tab visit, so one tap on "Hozzáadás" fired N handlers: the first
  // added the item, the rest toasted "Írd be az alapanyag nevét".)
  let _bound = false;
  function init() {
    if (_bound) return;
    _bound = true;
    $("#inv-add").addEventListener("click", addBase);
    $("#sub-add").addEventListener("click", addSub);
    ["#inv-name", "#inv-qty", "#inv-unit"].forEach((sel) =>
      $(sel).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addBase(); } })
    );
    $("#sub-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSub(); } });
    $("#inv-list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-rm]");
      if (b) removeBase(b.dataset.rm);
    });
  }

  function addBase() {
    const name = $("#inv-name").value.trim();
    if (!name) { toast("Írd be az alapanyag nevét"); return; }
    const inv = S.getInventory();
    const qty = $("#inv-qty").value.trim();
    const unit = $("#inv-unit").value.trim();
    const existing = inv.find((i) => S.similar(i.name, name));
    if (existing) {
      if (qty) existing.qty = qty;
      if (unit) existing.unit = unit;
      toast("Frissítve: " + existing.name);
    } else {
      inv.push({ name, qty, unit, subs: [] });
      toast("Hozzáadva: " + name);
    }
    S.setInventory(inv);
    ["inv-name", "inv-qty", "inv-unit"].forEach((id) => { $("#" + id).value = ""; });
    if (inventoryChangedCallback) inventoryChangedCallback();
    render();
  }

  function addSub() {
    const base = $("#sub-for").value;
    const sub  = $("#sub-name").value.trim();
    if (!base || !sub) { toast("Válassz alapanyagot + alternatívát"); return; }
    const inv = S.getInventory();
    const target = inv.find((i) => S.similar(i.name, base));
    if (!target) { toast("Az alapanyag nem a listádon"); return; }
    target.subs = target.subs || [];
    if (target.subs.every((s) => !S.similar(s, sub))) target.subs.push(sub);
    S.setInventory(inv);
    $("#sub-name").value = "";
    toast(`Alternatíva hozzáadva: ${base} → ${sub}`);
    if (inventoryChangedCallback) inventoryChangedCallback();
    render();
  }

  function removeBase(name) {
    const before = S.getInventory();
    // exact (normalized) match only — similar() would also delete e.g.
    // "csirkemell" when the user removes "csirke".
    const inv = before.filter((i) => S.norm(i.name) !== S.norm(name));
    S.setInventory(inv);
    if (inventoryChangedCallback) inventoryChangedCallback();
    render();
    toast("Törölve: " + name, null, {
      label: "Visszavonás",
      onClick: () => {
        S.setInventory(before);
        if (inventoryChangedCallback) inventoryChangedCallback();
        render();
      }
    });
  }

  return { init, render, onInventoryChanged };
})();
