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
      description: "High-protein chicken & sausage pasta. A kiírt teperték egy adagra értendő — az egészet 5 adagra osztottam. 9,9 pont a kuktától.",
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
        { name: "víz", qty: "kb. 3 evőkanál", note: "opcionális, öntönységhez" },
        { name: "tészta", qty: "240 g", note: "már FŐTT — nem nyersen kerül bele" },
        { name: "spenót", qty: "80 g", note: "opcionális, de fontos" },
        { name: "parmezán", qty: "40 g", note: "rágratva végül" }
      ],
      steps: [
        { t: 6,  text: "200 g vöröshagyma apróra, bele a serpenyőbe; hozzá 50 g apróra vágott kolbász." },
        { t: 11, text: "Amikor a kolbász összeszóll, belevágjuk a 650 g csirkemell aprított darabokat." },
        { t: 20, text: "Fűszerezés: jódag só, csili, füstölt paprika, bors, fokhagyma." },
        { t: 31, text: "Hátradolgozva: 3 evőkanál paradicsompüré." },
        { t: 35, text: "Mehet hozzá 160 g tejszín — vagy rizs-tejszín, amit akarsz." },
        { t: 39, text: "Kicsi vizet is adok öntönységhez, és beleválik a 240 g MAR FŐTT tészta. (Nyersen ne!)" },
        { t: 46, text: "opcionális, de szerintem fontos: 80 g spenót rádobva, amíg összeesik." },
        { t: 49, text: "Végére rágratol 40 g parmezán. Kész — jó étvágyat, 9,9 pont!" }
      ]
    },
    {
      id: "r2",
      title: "Diétás Boljognyai",
      title_hu: "Diétás Boljognyai 🍝",
      description: "Diétás tészta recept: csirkemell, kolbász, tejszín, spenót, parmezán. High protein, nagy ízek, gyorsan elkészül.",
      creator: "iamvargacsaba",
      source: "https://vm.tiktok.com/ZN88s6bGY",
      video: "VideoContent/video2.mp4",
      rating: 9.9,
      cuisine: "hungarian",
      difficulty: "easy",
      tags: ["highprotein", "diéta", "pasta", "chicken", "quick"],
      dietary: ["high-protein"],
      servings: 5,
      servingsNote: "adagonkénti makrók (5 adag)",
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
        { name: "víz", qty: "kb. 3 evőkanál", note: "opcionális" },
        { name: "tészta", qty: "240 g", note: "már FŐTT" },
        { name: "spenót", qty: "80 g", note: "opcionális" },
        { name: "parmezán", qty: "40 g", note: "végül a tésztára" }
      ],
      steps: [
        { t: 6,  text: "Vöröshagyma apróra + 50 g apróra vágott kolbász a serpenyőbe." },
        { t: 11, text: "Majd a 650 g csirkemell, amíg a kolbász összeszóll." },
        { t: 20, text: "Fűszerek: só, csili, füstölt paprika, bors, fokhagyma." },
        { t: 31, text: "3 evőkanál paradicsompüré." },
        { t: 35, text: "160 g tejszín (vagy rizs-tejszín)." },
        { t: 39, text: "Kicsi víz + a 240 g már főtt tészta." },
        { t: 46, text: "80 g spenót — opcionális, de fontos." },
        { t: 49, text: "40 g parmezán rágratva. Kész!" }
      ]
    }
  ]
};

/* Quick-add presets for the "what I have" section (Hungarian, as the user cooks) */
window.SOLIN_PRESETS = [
  "vöröshagyma","kolbász","csirkeemlő","csirkemell","paradicsompüré","tejszín",
  "rizs-tejszín","tészta","főtt tészta","spenót","parmezán","fokhagyma","só"
];
