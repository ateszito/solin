/* ============================================================
   Solin v3 — i18n.js
   Lightweight internationalization (HU / EN) for navigation,
   actions, section headings, and bilingual display.
   ============================================================ */

window.SolinI18n = (function () {
  const LANG_KEY = "solin.lang";
  let currentLang = localStorage.getItem(LANG_KEY) || "hu";
  const listeners = [];

  const strings = {
    hu: {
      recipes: "Receptek",
      what_to_cook: "Mit főzzek?",
      kamra: "Kamra",
      foodcounter: "Product Inventory",
      add_recipe: "+ Recept",
      search_placeholder: "Keresés: recept, hozzávaló, címke…",
      ingredients: "🥕 Hozzávalók",
      steps: "👨‍🍳 Elkészítés",
      scaling: "⚖️ Adagolás & skálázás",
      transcript: "📝 Videó leirat",
      transcript_desc: "A videó elhangzott szövege és időzítései:",
      video_sync: "videó-szinkron",
      clear_checks: "Pipák törlése",
      checks_cleared: "Pipák törölve",
      undo: "Visszavonás",
      save: "Mentés",
      saved_live: "Mentve ✓ — korrekciók élesben",
      recipe_created: "Recept létrehozva ✓",
      cancel: "Mégse",
      reset_original: "Visszaállítás eredetire",
      back_to_recipes: "← Vissza a receptekhez",
      back_to_recipe: "← Vissza a recepthez",
      edit_recipe: "Recept szerkesztése",
      edit_open: "Szerkesztés",
      servings: "adag",
      min: "perc",
      diff_easy: "Könnyű",
      diff_medium: "Közepes",
      diff_hard: "Haladó",
      empty_search: "Nincs találat.",
      new_recipe: "Új recept",
      orig_lang_hu: "🇭🇺 Eredeti nyelv: Magyar",
      orig_lang_en: "🇬🇧 Eredeti nyelv: Angol",
      done: "kész",
      marked: "kijelölve",
      jump_to_video: "Ugrás a videóban",
      step_progress_hint: "A lépésre koppintva megjelölheted késznek. A videós gombbal odaugorhatsz a lépéshez.",
      pantry_desc: "Központi alapanyag-nyilvántartás kétnyelvű (HU / EN) támogatással, ismert helyettesítőkkel és a valós bolti termékek csatolásával.",
      pantry_add_title: "Alapanyag hozzáadása a Kamrához",
      pantry_hu_name: "Magyar név (pl. csirkemell)",
      pantry_en_name: "Angol név (pl. Chicken breast)",
      pantry_search: "Keresés magyar vagy angol név alapján…",
      pantry_items_title: "A kamrád alapanyagai",
      pantry_sub_title: "Helyettesítő hozzáadása",
      pantry_linked_prod: "Csatolt bolti termék:",
      pantry_link_btn: "＋ Termék csatolása",
    },
    en: {
      recipes: "Recipes",
      what_to_cook: "What to cook?",
      kamra: "Pantry",
      foodcounter: "Product Inventory",
      add_recipe: "+ Recipe",
      search_placeholder: "Search: recipe, ingredient, tag…",
      ingredients: "🥕 Ingredients",
      steps: "👨‍🍳 Instructions",
      scaling: "⚖️ Portions & Scaling",
      transcript: "📝 Video Transcript",
      transcript_desc: "Spoken transcript and video timestamps:",
      video_sync: "video sync",
      clear_checks: "Clear checks",
      checks_cleared: "Checks cleared",
      undo: "Undo",
      save: "Save",
      saved_live: "Saved ✓ — live changes applied",
      recipe_created: "Recipe created ✓",
      cancel: "Cancel",
      reset_original: "Reset to original",
      back_to_recipes: "← Back to recipes",
      back_to_recipe: "← Back to recipe",
      edit_recipe: "Edit recipe",
      edit_open: "Edit",
      servings: "servings",
      min: "min",
      diff_easy: "Easy",
      diff_medium: "Medium",
      diff_hard: "Hard",
      empty_search: "No recipes found.",
      new_recipe: "New recipe",
      orig_lang_hu: "🇭🇺 Original: Hungarian",
      orig_lang_en: "🇬🇧 Original: English",
      done: "done",
      marked: "selected",
      jump_to_video: "Jump in video",
      step_progress_hint: "Tap a step to mark it done. Tap the video button to jump and scroll to that step.",
      pantry_desc: "Centralized pantry registry with bilingual (HU / EN) support, substitutions, and store product links.",
      pantry_add_title: "Add ingredient to Pantry",
      pantry_hu_name: "Hungarian name (e.g. csirkemell)",
      pantry_en_name: "English name (e.g. Chicken breast)",
      pantry_search: "Search by Hungarian or English name…",
      pantry_items_title: "Pantry ingredients",
      pantry_sub_title: "Add substitute",
      pantry_linked_prod: "Linked store products:",
      pantry_link_btn: "＋ Link product",
    }
  };

  function getLang() {
    return currentLang;
  }

  function setLang(lang) {
    if (lang !== "hu" && lang !== "en") lang = "hu";
    currentLang = lang;
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch (e) {}
    document.documentElement.lang = lang;
    updateStaticDOM();
    listeners.forEach((fn) => {
      try { fn(currentLang); } catch (e) { console.error("i18n listener error:", e); }
    });
  }

  function toggleLang() {
    setLang(currentLang === "hu" ? "en" : "hu");
    return currentLang;
  }

  function t(key, fallback) {
    const dict = strings[currentLang] || strings.hu;
    return dict[key] || fallback || key;
  }

  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  function updateStaticDOM() {
    const btn = document.getElementById("lang-switch");
    if (btn) {
      btn.textContent = currentLang === "hu" ? "🇭🇺 HU" : "🇬🇧 EN";
      btn.title = currentLang === "hu" ? "Váltás angolra / Switch to English" : "Váltás magyarra / Switch to Hungarian";
    }

    // Update elements with data-i18n
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const k = el.getAttribute("data-i18n");
      const trans = t(k);
      if (trans) el.textContent = trans;
    });

    // Update placeholders with data-i18n-ph
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      const k = el.getAttribute("data-i18n-ph");
      const trans = t(k);
      if (trans) el.placeholder = trans;
    });

    // Update bottom nav labels
    const navItems = {
      browse: t("recipes"),
      match: t("what_to_cook"),
      inventory: t("kamra"),
      foodcounter: t("foodcounter")
    };
    document.querySelectorAll(".bottom-nav button[data-nav]").forEach((btn) => {
      const navKey = btn.dataset.nav;
      const span = btn.querySelector("span");
      if (span && navItems[navKey]) span.textContent = navItems[navKey];
    });

    // Update header add recipe button
    const addBtn = document.getElementById("add-open");
    if (addBtn) addBtn.textContent = t("add_recipe");

    // Update search input placeholder
    const searchInp = document.getElementById("search");
    if (searchInp) searchInp.placeholder = t("search_placeholder");
  }

  // Initial setup on load
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => updateStaticDOM());
    } else {
      setTimeout(updateStaticDOM, 0);
    }
  }

  return {
    getLang,
    setLang,
    toggleLang,
    t,
    onChange,
    updateStaticDOM
  };
})();
