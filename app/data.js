/* ============================================================
   Solin v3 — data.js
   Seed data: the 2 starter TikTok recipes (iamvargacsaba).
   Video files are served relative to this app/ folder.
   ============================================================ */

window.SOLIN_DATA = {
  version: 3,
  creator: {
    name: "iamvargacsaba",
    source: "https://vm.tiktok.com/ZN88s6bGY"
  },

  /* Suggested substitutes — pre-seeded into the inventory.
     Each entry: base ingredient -> list of acceptable alternatives. */
  suggestedSubs: {
    "tejszín": ["rizs-tejszín", "kókusztejszín", "alacsony zsírtartalmú tejszín"],
    "parmezán": ["gruyère", "emmental", "trappista sajt"],
    "csirkeemlő": ["csirkemell", "pulykamell"],
    "tészta": ["rizs", "gluténmentes tészta", "zab tészta"],
    "spenót": ["baby szaláta", "kelbimbó"],
    "kolbász": ["pecsenye kolbász", "füstölt sonka"],
    "paradicsompüré": ["koncentrátum 1:3-ba hígítva"]
  },

  recipes: [
    {
      id: "r1",
      title: "Javítom magam — Chicken & Sausage Pasta",
      title_hu: "Javítom magam, ez 10/10!!",
      description: "High-protein chicken & sausage pasta. A kiírt tápérték egy adagra értendő — az egészet 5 adagra osztottam. 9,9 pont a kuktától.",
      creator: "iamvargacsaba",
      source: "https://vm.tiktok.com/ZN88s6bGY",
      video: "VideoContent/video1.mp4",
      rating: 9.9,
      cuisine: "hungarian",
      difficulty: "easy",
      tags: ["highprotein", "dinner", "pasta", "chicken", "quick"],
      dietary: ["high-protein"],
      servings: 5,
      servingsNote: "az egészet 5 adagra osztottam — az adagonkénti makrók így értendők",
      prepMin: 10,
      cookMin: 20,
      totalMin: 30,
      macrosPerServing: { kcal: 850, protein: 45.2, carbs: 48.0, fat: 28.5 },
      ingredients: [
        { name: "vöröshagyma", qty: "200 g", note: "apróra vágva" },
        { name: "kolbász", qty: "50 g", note: "apróra vágva" },
        { name: "csirkeemlő", qty: "650 g" },
        { name: "só", qty: "jódag", note: "ízlés szerint" },
        { name: "csili", qty: "kb. 1 db", note: "ízlés szerint" },
        { name: "füstölt paprika", qty: "1 tk" },
        { name: "bors", qty: "½ tk" },
        { name: "fokhagyma", qty: "1-2 gerezd", note: "darálva" },
        { name: "paradicsompüré", qty: "3 evőkanál" },
        { name: "tejszín", qty: "160 g", note: "vagy rizs-tejszín" },
        { name: "víz", qty: "kb. 3 evőkanál", note: "opcionális, a szaft sűrűségéhez" },
        { name: "tészta", qty: "240 g", note: "már FŐTT — nem nyersen kerül bele" },
        { name: "spenót", qty: "80 g", note: "opcionális, de fontos" },
        { name: "parmezán", qty: "40 g", note: "a végén rászórva" }
      ],
      steps: [
        { t: 6,  text: "200 g vöröshagyma apróra, bele a serpenyőbe; hozzá 50 g apróra vágott kolbász." },
        { t: 11, text: "Amikor a kolbász kiengedte a zsírját, mehet bele a 650 g felkockázott csirkemell." },
        { t: 20, text: "Fűszerezés: jó adag só, csili, füstölt paprika, bors, fokhagyma." },
        { t: 31, text: "Hozzáadjuk: 3 evőkanál paradicsompüré." },
        { t: 35, text: "Mehet hozzá 160 g tejszín — vagy rizs-tejszín, amit akarsz." },
        { t: 39, text: "Kevés vizet is adok a szaft sűrűségéhez, és belekerül a 240 g MÁR FŐTT tészta. (Nyersen ne!)" },
        { t: 46, text: "Opcionális, de szerintem fontos: 80 g spenót rádobva, amíg összeesik." },
        { t: 49, text: "A végére rászórunk 40 g parmezánt. Kész — jó étvágyat, 9,9 pont!" }
      ]
    },
    {
      id: "r2",
      title: "Diétás Bolognai 🍝",
      title_hu: "Diétás Bolognai 🍝",
      description: "Diétás bolognai ragu light darált pulykával, répával, zellerrel és passzátával. 9,2 pontos, magas fehérjetartalmú recept 4 adagra.",
      creator: "iamvargacsaba",
      source: "https://vm.tiktok.com/ZN88s6bGY",
      video: "VideoContent/video2.mp4",
      rating: 9.2,
      cuisine: "olasz",
      difficulty: "easy",
      tags: ["highprotein", "diéta", "pasta", "bolognai", "pulyka", "quick"],
      dietary: ["high-protein"],
      servings: 4,
      servingsNote: "négy adagra osztod az egészet — adagonként 50 g fehérje és 488 kcal",
      prepMin: 10,
      cookMin: 25,
      totalMin: 35,
      macrosPerServing: { kcal: 488, protein: 50.0, carbs: 52.0, fat: 9.0 },
      ingredients: [
        { name: "olaj", qty: "3 g", note: "sütéshez" },
        { name: "vöröshagyma", qty: "1 fej (kb. 150 g)", note: "apróra vágva" },
        { name: "sárgarépa", qty: "200 g", note: "apróra vágva vagy reszelve" },
        { name: "zeller", qty: "200 g", note: "apróra vágva vagy reszelve" },
        { name: "light darált pulyka", qty: "500 g" },
        { name: "paradicsom passzáta", qty: "700 g" },
        { name: "só", qty: "ízlés szerint" },
        { name: "bors", qty: "ízlés szerint" },
        { name: "fokhagyma", qty: "ízlés szerint" },
        { name: "tészta", qty: "4 adag", note: "már kifőzve" },
        { name: "light reszelt mozzarella", qty: "60 g", note: "15 g adagonként a tetejére" }
      ],
      steps: [
        { t: 7,  text: "Nagyjából 3 g olajat hevítünk a serpenyőben, és a hagymát üvegesre pirítjuk." },
        { t: 15, text: "Hozzáadjuk a 200 g felaprított sárgarépát és a 200 g zellert." },
        { t: 24, text: "Mehet bele az 500 g light darált pulyka, és az egészet jól lepirítjuk." },
        { t: 31, text: "Hozzáöntünk 700 g paradicsom passzátát." },
        { t: 35, text: "Fűszerezünk ízlés szerint: só, bors és fokhagyma." },
        { t: 52, text: "Hagyjuk rotyogni és besűrűsödni a ragut." },
        { t: 57, text: "Összeforgatjuk a kifőtt tésztával, és négy egyenlő adagra osztjuk." },
        { t: 60, text: "Tálaláskor adagonként 15 g light reszelt mozzarellát szórunk a tetejére. 9,2 pont — jó étvágyat!" }
      ]
    }
  ]
};

/* Quick-add presets for the "what I have" section (Hungarian, as the user cooks) */
window.SOLIN_PRESETS = [
  "vöröshagyma","kolbász","csirkeemlő","csirkemell","paradicsompüré","tejszín",
  "rizs-tejszín","tészta","főtt tészta","spenót","parmezán","fokhagyma","só",
  "sárgarépa","zeller","light darált pulyka","paradicsom passzáta","light reszelt mozzarella","olaj","bors"
];
