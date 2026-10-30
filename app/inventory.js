/* ============================================================
   Solin v3 — inventory.js
   Centralized bilingual Kamra (Pantry) registry + substitutes
   and real store product mapping. Persists to backend API & SolinStore.
   ============================================================ */

window.Inventory = (function () {
  const { $, $$, S, esc, toast } = window.Solin;
  let inventoryChangedCallback = null;
  function onInventoryChanged(cb) { inventoryChangedCallback = cb; }

  let _allProducts = [];
  let _productsMap = {};
  let _searchQuery = "";

  function apiBase() {
    const b = window.SolinCfg && window.SolinCfg.apiBase;
    return (typeof b === "function" ? b() : b) || "";
  }

  async function loadStoreProducts() {
    try {
      const url = (apiBase() + "/api/v1/inventory?limit=100").replace(/\/+$/, "");
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json();
        _allProducts = (body && Array.isArray(body.items)) ? body.items : [];
        _productsMap = {};
        _allProducts.forEach(p => { _productsMap[p.id] = p; });
      }
    } catch (e) {
      console.warn("Could not load inventory products for Kamra mapping:", e);
    }
  }

  function getCategoryLabel(cat) {
    switch (cat) {
      case "meat": return "🥩 Hús";
      case "dairy": return "🥛 Tejtermék";
      case "produce": return "🧅 Zöldség/Gyümölcs";
      case "grain": return "🌾 Gabona";
      case "spice": return "🌿 Fűszer";
      case "oil": return "🫒 Olaj";
      case "pantry": return "🥫 Kamra";
      default: return "📦 Egyéb";
    }
  }

  function refreshSubSelect() {
    const sel = $("#sub-for");
    if (!sel) return;
    const inv = S.getInventory();
    sel.innerHTML = inv.map((i) =>
      `<option value="${esc(i.id || i.name)}">${esc(i.name)}${i.name_en ? ` (${esc(i.name_en)})` : ""}</option>`
    ).join("");
  }

  function render() {
    const inv = S.getInventory();
    refreshSubSelect();

    const countEl = $("#inv-count");
    if (countEl) countEl.textContent = inv.length + " alapanyag";

    let displayList = inv;
    if (_searchQuery.trim()) {
      const q = S.norm(_searchQuery);
      displayList = inv.filter(i => {
        if (S.norm(i.name).includes(q)) return true;
        if (i.name_en && S.norm(i.name_en).includes(q)) return true;
        if (Array.isArray(i.synonyms) && i.synonyms.some(s => S.norm(s).includes(q))) return true;
        return false;
      });
    }

    const listEl = $("#inv-list");
    if (!listEl) return;

    listEl.innerHTML = displayList.length ? displayList.map((i) => {
      const subs = (i.subs || []).map((s) => {
        const sName = typeof s === "string" ? s : (s.name || s.name_en || "");
        return `<span class="inv-alt" style="display:inline-flex;align-items:center;gap:4px;">
          ↳ ${esc(sName)}
          <button type="button" class="sub-rm-btn" data-base-id="${esc(i.id || i.name)}" data-sub="${esc(sName)}" title="Helyettesítő eltávolítása" style="border:none;background:none;color:#991B1B;cursor:pointer;font-size:12px;padding:0 2px;">×</button>
        </span>`;
      }).join(" ");

      const linkedProds = (i.product_ids || []).map((pid) => {
        const prod = _productsMap[pid] || { name: pid };
        const priceStr = (prod.prices && prod.prices[0]) ? ` (${prod.prices[0].amount} ${prod.prices[0].currency})` : "";
        return `<span class="pill" style="background:#e0f2fe;color:#0369a1;display:inline-flex;align-items:center;gap:4px;font-size:11.5px;padding:2px 8px;">
          🏷️ ${esc(prod.name)}${esc(priceStr)}
          <button type="button" class="prod-unlink-btn" data-base-id="${esc(i.id || i.name)}" data-pid="${esc(pid)}" title="Kapcsolat törlése" style="border:none;background:none;color:#0369a1;cursor:pointer;font-size:12px;font-weight:bold;padding:0 2px;">×</button>
        </span>`;
      }).join(" ");

      return `<li style="display:flex; flex-direction:column; align-items:stretch; gap:6px; padding:12px 0; border-bottom:1px solid var(--line);">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span class="inv-name" style="font-size:15px; font-weight:700;">${esc(i.name)}</span>
            ${i.name_en ? `<span class="pill" style="font-size:11.5px; background:#f1f5f9; color:#475569;">🇬🇧 ${esc(i.name_en)}</span>` : ""}
            <span class="pill" style="font-size:11px; background:#f8fafc; color:#64748b; border:1px solid #e2e8f0;">${getCategoryLabel(i.category)}</span>
          </div>
          <button class="rm" data-rm="${esc(i.id || i.name)}" aria-label="${esc(i.name)} törlése" title="Törlés" style="align-self:flex-start;">×</button>
        </div>

        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:12px;">
          ${subs ? `<div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">${subs}</div>` : `<span class="hint" style="font-size:11px;margin:0;">Nincs még helyettesítő.</span>`}
        </div>

        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:4px;">
          <span style="font-size:11.5px; font-weight:600; color:var(--text-2);">Csatolt bolti termék:</span>
          ${linkedProds}
          <button type="button" class="btn sm link-prod-btn" data-base-id="${esc(i.id || i.name)}" style="font-size:11px; padding:2px 8px; height:auto; line-height:1.4;">＋ Termék csatolása</button>
        </div>
      </li>`;
    }).join("") : `<li class="hint">Nincs megjeleníthető alapanyag.</li>`;
  }

  let _bound = false;
  async function init() {
    if (_bound) return;
    _bound = true;

    // Load store products and sync Kamra from backend
    await loadStoreProducts();
    await S.syncKamraFromApi();
    render();

    $("#inv-add").addEventListener("click", addBase);
    $("#sub-add").addEventListener("click", addSub);

    const searchInput = $("#inv-search");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        _searchQuery = e.target.value;
        render();
      });
    }

    ["#inv-name", "#inv-name-en"].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addBase(); } });
    });

    const subName = $("#sub-name");
    if (subName) {
      subName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSub(); } });
    }

    const listEl = $("#inv-list");
    if (listEl) {
      listEl.addEventListener("click", (e) => {
        const rmBtn = e.target.closest("[data-rm]");
        if (rmBtn) {
          removeBase(rmBtn.dataset.rm);
          return;
        }

        const subRmBtn = e.target.closest(".sub-rm-btn");
        if (subRmBtn) {
          removeSub(subRmBtn.dataset.baseId, subRmBtn.dataset.sub);
          return;
        }

        const unlinkBtn = e.target.closest(".prod-unlink-btn");
        if (unlinkBtn) {
          unlinkProduct(unlinkBtn.dataset.baseId, unlinkBtn.dataset.pid);
          return;
        }

        const linkBtn = e.target.closest(".link-prod-btn");
        if (linkBtn) {
          openLinkProductModal(linkBtn.dataset.baseId);
          return;
        }
      });
    }
  }

  async function addBase() {
    const name = ($("#inv-name").value || "").trim();
    if (!name) { toast("Írd be az alapanyag nevét"); return; }
    const nameEn = ($("#inv-name-en").value || "").trim();
    const category = ($("#inv-category").value || "other");

    // Call backend API
    try {
      const url = (apiBase() + "/api/v1/kamra").replace(/\/+$/, "");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, name_en: nameEn || null, category })
      });
      if (res.ok) {
        const created = await res.json();
        const inv = S.getInventory();
        inv.push(created);
        S.setInventory(inv);
        toast("Hozzáadva a Kamrához: " + created.name);
      } else {
        throw new Error("HTTP " + res.status);
      }
    } catch (err) {
      // Local fallback
      const inv = S.getInventory();
      const existing = inv.find((i) => S.similar(i.name, name));
      if (existing) {
        if (nameEn) existing.name_en = nameEn;
        if (category !== "other") existing.category = category;
        toast("Frissítve: " + existing.name);
      } else {
        inv.push({ id: S.norm(name).replace(/\s+/g, "_"), name, name_en: nameEn, category, subs: [], product_ids: [] });
        toast("Hozzáadva (helyben): " + name);
      }
      S.setInventory(inv);
    }

    $("#inv-name").value = "";
    $("#inv-name-en").value = "";
    $("#inv-category").value = "other";
    if (inventoryChangedCallback) inventoryChangedCallback();
    render();
  }

  async function addSub() {
    const baseId = $("#sub-for").value;
    const sub = ($("#sub-name").value || "").trim();
    if (!baseId || !sub) { toast("Válassz alapanyagot + helyettesítőt"); return; }

    const inv = S.getInventory();
    const target = inv.find((i) => (i.id === baseId || S.similar(i.name, baseId)));
    if (!target) { toast("Az alapanyag nem található"); return; }

    target.subs = target.subs || [];
    if (!target.subs.some((s) => S.similar(typeof s === "string" ? s : (s.name || ""), sub))) {
      target.subs.push(sub);
    }

    // Sync to backend if possible
    if (target.id) {
      try {
        const url = (apiBase() + "/api/v1/kamra/" + encodeURIComponent(target.id)).replace(/\/+$/, "");
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subs: target.subs })
        });
      } catch (e) {}
    }

    S.setInventory(inv);
    $("#sub-name").value = "";
    toast(`Helyettesítő hozzáadva: ${target.name} → ${sub}`);
    if (inventoryChangedCallback) inventoryChangedCallback();
    render();
  }

  async function removeSub(baseId, subToRemove) {
    const inv = S.getInventory();
    const target = inv.find((i) => (i.id === baseId || S.similar(i.name, baseId)));
    if (!target) return;

    target.subs = (target.subs || []).filter(s => {
      const sName = typeof s === "string" ? s : (s.name || s.name_en || "");
      return S.norm(sName) !== S.norm(subToRemove);
    });

    if (target.id) {
      try {
        const url = (apiBase() + "/api/v1/kamra/" + encodeURIComponent(target.id)).replace(/\/+$/, "");
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subs: target.subs })
        });
      } catch (e) {}
    }

    S.setInventory(inv);
    toast(`Helyettesítő törölve: ${subToRemove}`);
    if (inventoryChangedCallback) inventoryChangedCallback();
    render();
  }

  async function removeBase(itemIdentifier) {
    const before = S.getInventory();
    const target = before.find((i) => (i.id === itemIdentifier || S.norm(i.name) === S.norm(itemIdentifier)));
    const inv = before.filter((i) => i !== target);

    if (target && target.id) {
      try {
        const url = (apiBase() + "/api/v1/kamra/" + encodeURIComponent(target.id)).replace(/\/+$/, "");
        await fetch(url, { method: "DELETE" });
      } catch (e) {}
    }

    S.setInventory(inv);
    if (inventoryChangedCallback) inventoryChangedCallback();
    render();
    toast("Törölve a Kamrából: " + (target ? target.name : itemIdentifier));
  }

  async function unlinkProduct(baseId, pid) {
    const inv = S.getInventory();
    const target = inv.find((i) => (i.id === baseId || S.similar(i.name, baseId)));
    if (!target) return;

    target.product_ids = (target.product_ids || []).filter(p => p !== pid);
    if (target.id) {
      try {
        const url = (apiBase() + "/api/v1/kamra/" + encodeURIComponent(target.id)).replace(/\/+$/, "");
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_ids: target.product_ids })
        });
      } catch (e) {}
    }

    S.setInventory(inv);
    toast("Bolti termék leválasztva.");
    if (inventoryChangedCallback) inventoryChangedCallback();
    render();
  }

  function openLinkProductModal(baseId) {
    const inv = S.getInventory();
    const target = inv.find((i) => (i.id === baseId || S.similar(i.name, baseId)));
    if (!target) return;

    let overlay = document.querySelector("#kamra-link-overlay");
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = "kamra-link-overlay";
    overlay.className = "solin-lightbox-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;";

    const prodsOptions = _allProducts.map(p => {
      const priceStr = (p.prices && p.prices[0]) ? ` — ${p.prices[0].amount} ${p.prices[0].currency}` : "";
      const isLinked = (target.product_ids || []).includes(p.id);
      return `<li style="display:flex;justify-content:space-between;align-items:center;padding:10px 8px;border-bottom:1px solid #f1f5f9;">
        <div>
          <b>${esc(p.name)}</b> <small style="color:#64748b;">${esc(p.brand || "")}${esc(priceStr)}</small>
        </div>
        ${isLinked
          ? `<span class="pill" style="background:#e0f2fe;color:#0369a1;font-size:11px;">Már csatolva ✓</span>`
          : `<button type="button" class="btn sm primary select-prod-btn" data-pid="${esc(p.id)}" style="font-size:12px;padding:4px 10px;">Csatolás</button>`}
      </li>`;
    }).join("");

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:440px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 25px -5px rgba(0,0,0,0.2);">
        <div style="padding:16px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;font-size:16px;">Bolti termék csatolása ehhez: <span style="color:var(--primary);">${esc(target.name)}</span></h3>
          <button type="button" id="close-link-modal" style="border:none;background:none;font-size:22px;cursor:pointer;line-height:1;color:#64748b;">×</button>
        </div>
        <div style="padding:12px 16px;overflow-y:auto;flex:1;">
          <p class="hint" style="margin-top:0;">Válassz egyet a valós bolti termékeid közül, amit ehhez az alapanyaghoz használsz:</p>
          <ul style="list-style:none;padding:0;margin:0;">
            ${prodsOptions || '<li class="hint">Még nincs rögzített bolti terméked az inventory-ban.</li>'}
          </ul>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector("#close-link-modal").onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.querySelectorAll(".select-prod-btn").forEach(btn => {
      btn.onclick = async () => {
        const pid = btn.dataset.pid;
        target.product_ids = target.product_ids || [];
        if (!target.product_ids.includes(pid)) {
          target.product_ids.push(pid);
        }

        if (target.id) {
          try {
            const url = (apiBase() + "/api/v1/kamra/" + encodeURIComponent(target.id)).replace(/\/+$/, "");
            await fetch(url, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ product_ids: target.product_ids })
            });
          } catch (e) {}
        }

        S.setInventory(inv);
        overlay.remove();
        toast(`Termék csatolva ehhez: ${target.name} ✓`);
        if (inventoryChangedCallback) inventoryChangedCallback();
        render();
      };
    });
  }

  return { init, render, onInventoryChanged };
})();
