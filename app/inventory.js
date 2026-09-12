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
        <button class="rm" data-rm="${esc(i.name)}" aria-label="töröl">×</button>
      </li>`;
    }).join("") : `<li class="hint">Még üres — add hozzá valamit felül.</li>`;

    $("#inv-add").addEventListener("click", addBase);
    $("#sub-add").addEventListener("click", addSub);
    $("#inv-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addBase(); } });
    $("#sub-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSub(); } });
    $("#inv-list").querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => removeBase(b.dataset.rm))
    );
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
    if (target.subs.every((s) => !S.similar(s, sub))) target.subs.push(sub);
    S.setInventory(inv);
    $("#sub-name").value = "";
    toast(`Alternatíva hozzáadva: ${base} → ${sub}`);
    if (inventoryChangedCallback) inventoryChangedCallback();
    render();
  }

  function removeBase(name) {
    const inv = S.getInventory().filter((i) => !S.similar(i.name, name));
    S.setInventory(inv);
    toast("Törölve: " + name);
    if (inventoryChangedCallback) inventoryChangedCallback();
    render();
  }

  return { render, onInventoryChanged };
})();
