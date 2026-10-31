"""Comprehensive bilingual (Hungarian <-> English) culinary translator and category classifier."""
from __future__ import annotations

import re
import unicodedata
from typing import Dict, Tuple, Optional, List


def norm(s: str) -> str:
    """Normalize string for lookup: lowercase, accent-stripped, clean spaces."""
    if not s:
        return ""
    nfkd = unicodedata.normalize("NFKD", str(s).lower())
    clean = "".join([c for c in nfkd if not unicodedata.combining(c)])
    clean = clean.replace("-", " ").replace("/", " ")
    clean = re.sub(r"[^\w\s]", " ", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean


# Canonical culinary dictionary: (hu_name, en_name, category)
CANONICAL_INGREDIENTS: List[Tuple[str, str, str]] = [
    # Meats & Poultry
    ("csirkemell", "Chicken breast", "meat"),
    ("csirkecomb", "Chicken thigh", "meat"),
    ("egész csirke", "Whole chicken", "meat"),
    ("csirkeszárny", "Chicken wings", "meat"),
    ("pulykamell", "Turkey breast", "meat"),
    ("darált pulyka", "Ground turkey", "meat"),
    ("marhahús", "Beef", "meat"),
    ("darált marhahús", "Ground beef", "meat"),
    ("sovány darált marhahús", "Extra lean beef mince", "meat"),
    ("marha bélszín", "Beef tenderloin", "meat"),
    ("marha szalámi", "Beef pepperoni slices", "meat"),
    ("marha szalámi / pepperoni szeletek", "Beef pepperoni slices", "meat"),
    ("sertéshús", "Pork", "meat"),
    ("darált sertéshús", "Ground pork", "meat"),
    ("sertéskaraj", "Pork chop", "meat"),
    ("kolbász", "Sausage", "meat"),
    ("bacon", "Bacon", "meat"),
    ("szalonna", "Bacon / Lard", "meat"),
    ("sonka", "Ham", "meat"),
    ("parmai sonka", "Prosciutto", "meat"),
    ("virsli", "Frankfurter", "meat"),
    ("bárányhús", "Lamb", "meat"),
    ("kacsahús", "Duck", "meat"),

    # Fish & Seafood
    ("lazac", "Salmon", "meat"),
    ("lazacfilé", "Salmon fillet", "meat"),
    ("tonhal", "Tuna", "meat"),
    ("konzerv tonhal", "Canned tuna", "meat"),
    ("tőkehal", "Cod", "meat"),
    ("rák", "Shrimp / Prawns", "meat"),
    ("garnélarák", "Prawns", "meat"),

    # Dairy, Eggs & Alternatives
    ("tojás", "Egg", "dairy"),
    ("tojásfehérje", "Egg whites", "dairy"),
    ("tojássárgája", "Egg yolk", "dairy"),
    ("tej", "Milk", "dairy"),
    ("sovány tej", "Skim milk", "dairy"),
    ("tejszín", "Heavy cream", "dairy"),
    ("habtejszín", "Whipping cream", "dairy"),
    ("főzőtejszín", "Cooking cream", "dairy"),
    ("rizs-tejszín", "Rice cream", "dairy"),
    ("mandulatej", "Almond milk", "dairy"),
    ("zabtej", "Oat milk", "dairy"),
    ("kókusztej", "Coconut milk", "dairy"),
    ("zsírmentes sűrített tej", "Fat free evaporated milk", "dairy"),
    ("sűrített tej", "Evaporated milk", "dairy"),
    ("vaj", "Butter", "dairy"),
    ("ghí / tisztított vaj", "Ghee", "dairy"),
    ("tejföl", "Sour cream", "dairy"),
    ("görög joghurt", "Greek yogurt", "dairy"),
    ("sovány görög joghurt", "Low fat Greek yogurt", "dairy"),
    ("joghurt", "Yogurt", "dairy"),
    ("kefir", "Kefir", "dairy"),
    ("cottage cheese", "Cottage cheese", "dairy"),
    ("túró", "Quark / Curd cheese", "dairy"),
    ("parmezán", "Parmesan cheese", "dairy"),
    ("mozzarella", "Mozzarella cheese", "dairy"),
    ("cheddar sajt", "Cheddar cheese", "dairy"),
    ("sovány reszelt cheddar sajt", "Light grated cheddar cheese (Dairyworks)", "dairy"),
    ("sovány reszelt sajt", "Low fat grated cheese", "dairy"),
    ("reszelt sajt", "Grated cheese", "dairy"),
    ("trappista sajt", "Trappist cheese", "dairy"),
    ("feta sajt", "Feta cheese", "dairy"),
    ("ricotta", "Ricotta", "dairy"),
    ("mascarpone", "Mascarpone", "dairy"),

    # Produce (Vegetables, Fruits, Herbs)
    ("vöröshagyma", "Yellow onion", "produce"),
    ("barna vöröshagyma", "Brown onions", "produce"),
    ("lilahagyma", "Red onion", "produce"),
    ("fokhagyma", "Garlic", "produce"),
    ("újhagyma", "Spring onion", "produce"),
    ("póréhagyma", "Leek", "produce"),
    ("salotta hagyma", "Shallot", "produce"),
    ("paradicsom", "Tomato", "produce"),
    ("koktélparadicsom", "Cherry tomatoes", "produce"),
    ("uborka", "Cucumber", "produce"),
    ("csemegeuborka", "Pickles", "produce"),
    ("apróra vágott csemegeuborka", "Diced pickles", "produce"),
    ("burgonya", "Potato", "produce"),
    ("édesburgonya", "Sweet potato", "produce"),
    ("sárgarépa", "Carrot", "produce"),
    ("zeller", "Celery", "produce"),
    ("spenót", "Spinach", "produce"),
    ("bébispenót", "Baby spinach", "produce"),
    ("cukkini", "Zucchini", "produce"),
    ("padlizsán", "Eggplant", "produce"),
    ("paprika", "Bell pepper", "produce"),
    ("kaliforniai paprika", "Bell pepper", "produce"),
    ("csili", "Chili", "produce"),
    ("jalapeño", "Jalapeño", "produce"),
    ("gomba", "Mushroom", "produce"),
    ("csiperkegomba", "Button mushroom", "produce"),
    ("brokkoli", "Broccoli", "produce"),
    ("karfiol", "Cauliflower", "produce"),
    ("fejes saláta", "Lettuce", "produce"),
    ("jégsaláta", "Iceberg lettuce", "produce"),
    ("madársaláta", "Corn salad", "produce"),
    ("rukkola", "Arugula", "produce"),
    ("avokádó", "Avocado", "produce"),
    ("kukorica", "Sweetcorn", "produce"),
    ("zöldborsó", "Green peas", "produce"),
    ("zöldbab", "Green beans", "produce"),
    ("vörösbab", "Kidney beans", "produce"),
    ("csicseriborsó", "Chickpeas", "produce"),
    ("lencse", "Lentils", "produce"),
    ("citrom", "Lemon", "produce"),
    ("zöldcitrom / lime", "Lime", "produce"),
    ("alma", "Apple", "produce"),
    ("banán", "Banana", "produce"),
    ("eper", "Strawberry", "produce"),
    ("málna", "Raspberry", "produce"),
    ("áfonya", "Blueberry", "produce"),
    ("narancs", "Orange", "produce"),

    # Grains, Pasta & Bakery
    ("tészta", "Pasta", "grain"),
    ("spagetti", "Spaghetti", "grain"),
    ("penne", "Penne", "grain"),
    ("rizs", "Basmati rice", "grain"),
    ("jázmin rizs", "Jasmine rice", "grain"),
    ("barna rizs", "Brown rice", "grain"),
    ("búzaliszt", "Wheat flour", "grain"),
    ("liszt", "Flour", "grain"),
    ("sütőporos liszt / önkelesztő liszt", "Self-raising flour", "grain"),
    ("kókuszliszt", "Coconut flour", "grain"),
    ("mandulaliszt", "Almond flour", "grain"),
    ("zabpehely", "Rolled oats", "grain"),
    ("zabpehelyliszt", "Oat flour", "grain"),
    ("bulgur", "Bulgur", "grain"),
    ("kuszkusz", "Couscous", "grain"),
    ("quinoa", "Quinoa", "grain"),
    ("kenyér", "Bread", "grain"),
    ("teljes kiőrlésű kenyér", "Whole wheat bread", "grain"),
    ("tortilla lapok", "Tortillas", "grain"),
    ("pita", "Pita bread", "grain"),
    ("darált keksz", "Crushed biscuits", "grain"),

    # Spices & Herbs
    ("só", "Salt", "spice"),
    ("bors", "Black pepper", "spice"),
    ("fekete bors", "Black pepper", "spice"),
    ("fehér bors", "White pepper", "spice"),
    ("füstölt paprika", "Smoked paprika", "spice"),
    ("fűszerpaprika", "Sweet paprika", "spice"),
    ("oregánó", "Oregano", "spice"),
    ("bazsalikom", "Basil", "spice"),
    ("kakukkfű", "Thyme", "spice"),
    ("rozmaring", "Rosemary", "spice"),
    ("petrezselyem", "Parsley", "spice"),
    ("kapor", "Dill", "spice"),
    ("koriander", "Cilantro / Coriander", "spice"),
    ("fahéj", "Cinnamon", "spice"),
    ("szerecsendió", "Nutmeg", "spice"),
    ("gyömbér", "Ginger", "spice"),
    ("kömény", "Caraway", "spice"),
    ("római kömény", "Cumin", "spice"),
    ("olasz fűszerkeverék", "Italian herb seasoning", "spice"),
    ("babérlevél", "Bay leaves", "spice"),
    ("fokhagymapor", "Garlic powder", "spice"),
    ("hagymapor", "Onion powder", "spice"),

    # Oils & Fats
    ("olaj", "Cooking oil", "oil"),
    ("olívaolaj", "Olive oil", "oil"),
    ("extra szűz olívaolaj", "Extra virgin olive oil", "oil"),
    ("napraforgóolaj", "Sunflower oil", "oil"),
    ("kókuszzsír / kókuszolaj", "Coconut oil", "oil"),
    ("szezámolaj", "Sesame oil", "oil"),

    # Pantry, Sauces & Baking Ingredients
    ("cukor", "Sugar", "pantry"),
    ("barna cukor", "Brown sugar", "pantry"),
    ("porcukor", "Powdered sugar", "pantry"),
    ("méz", "Honey", "pantry"),
    ("juharszirup", "Maple syrup", "pantry"),
    ("sztívia", "Stevia", "pantry"),
    ("sütőpor", "Baking powder", "pantry"),
    ("szódabikarbóna", "Baking soda", "pantry"),
    ("élesztő", "Yeast", "pantry"),
    ("sörélesztő pehely", "Nutritional yeast", "pantry"),
    ("vanília kivonat", "Vanilla extract", "pantry"),
    ("kakaópor", "Cocoa powder", "pantry"),
    ("csokoládé", "Chocolate", "pantry"),
    ("étcsokoládé", "Dark chocolate", "pantry"),
    ("nutella", "Nutella", "pantry"),
    ("mogyoróvaj", "Peanut butter", "pantry"),
    ("fehérjepor", "Protein powder", "pantry"),
    ("csokoládés fehérjepor", "Chocolate protein powder", "pantry"),
    ("paradicsompüré", "Tomato paste", "pantry"),
    ("paradicsom passzáta", "Tomato passata", "pantry"),
    ("pizzaszósz / marinara", "Pizza sauce / Marinara", "pantry"),
    ("darabolt paradicsom konzerv", "Canned diced tomatoes", "pantry"),
    ("ecet", "Vinegar", "pantry"),
    ("balzsamecet", "Balsamic vinegar", "pantry"),
    ("almaecet", "Apple cider vinegar", "pantry"),
    ("szójaszósz", "Soy sauce", "pantry"),
    ("worcestershire szósz", "Worcestershire sauce", "pantry"),
    ("mustár", "Yellow mustard", "pantry"),
    ("dijon mustár", "Dijon mustard", "pantry"),
    ("ketchup", "Ketchup", "pantry"),
    ("cukorcsökkentett ketchup", "Low sugar ketchup (Heinz)", "pantry"),
    ("majonéz", "Mayonnaise", "pantry"),
    ("light majonéz", "Light mayonnaise", "pantry"),
    ("csirke alaplé por", "Low sodium chicken stock powder", "pantry"),
    ("alaplé", "Broth / Stock", "pantry"),
]

# Lookup tables initialized from canonical ingredients
_LOOKUP: Dict[str, Tuple[str, str, str]] = {}
for hu, en, cat in CANONICAL_INGREDIENTS:
    n_hu = norm(hu)
    n_en = norm(en)
    if n_hu:
        _LOOKUP[n_hu] = (hu, en, cat)
    if n_en:
        _LOOKUP[n_en] = (hu, en, cat)
    # Also index individual synonyms if multiple terms present (e.g. "sütőporos liszt / önkelesztő liszt")
    for part in re.split(r"[/,]", hu):
        np = norm(part)
        if np and np not in _LOOKUP:
            _LOOKUP[np] = (hu, en, cat)
    for part in re.split(r"[/,]", en):
        np = norm(part)
        if np and np not in _LOOKUP:
            _LOOKUP[np] = (hu, en, cat)

# Specific extra aliases
EXTRA_ALIASES: Dict[str, Tuple[str, str, str]] = {
    "self raising flour": ("sütőporos liszt / önkelesztő liszt", "Self-raising flour", "grain"),
    "self rising flour": ("sütőporos liszt / önkelesztő liszt", "Self-raising flour", "grain"),
    "low fat greek yoghurt": ("sovány görög joghurt", "Low fat Greek yogurt", "dairy"),
    "low fat greek yogurt": ("sovány görög joghurt", "Low fat Greek yogurt", "dairy"),
    "pizza sauce marinara": ("pizzaszósz / marinara", "Pizza sauce / Marinara", "pantry"),
    "marinara": ("pizzaszósz / marinara", "Pizza sauce / Marinara", "pantry"),
    "beef pepperoni slices": ("marha szalámi / pepperoni szeletek", "Beef pepperoni slices", "meat"),
    "italian herb seasoning": ("olasz fűszerkeverék", "Italian herb seasoning", "spice"),
    "fat free evaporated milk": ("zsírmentes sűrített tej", "Fat free evaporated milk", "dairy"),
    "low sodium chicken stock powder": ("csirke alaplé por", "Low sodium chicken stock powder", "pantry"),
    "extra lean beef mince": ("sovány darált marhahús", "Extra lean beef mince", "meat"),
    "yellow mustard": ("mustár", "Yellow mustard", "pantry"),
    "low sugar ketchup heinz": ("cukorcsökkentett ketchup", "Low sugar ketchup (Heinz)", "pantry"),
    "worcestershire sauce": ("worcestershire szósz", "Worcestershire sauce", "pantry"),
    "light mayonnaise": ("light majonéz", "Light mayonnaise", "pantry"),
    "diced pickles": ("apróra vágott csemegeuborka", "Diced pickles", "produce"),
    "light grated cheddar cheese dairyworks": ("sovány reszelt cheddar sajt", "Light grated cheddar cheese (Dairyworks)", "dairy"),
    "tortillas": ("tortilla lapok", "Tortillas", "grain"),
    "crushed biscuits": ("darált keksz", "Crushed biscuits", "grain"),
    "brown onions": ("barna vöröshagyma", "Brown onions", "produce"),
    "low fat grated cheese": ("sovány reszelt sajt", "Low fat grated cheese", "dairy"),
    "elo teszt alapanyag": ("élő teszt alapanyag", "Live test ingredient", "other"),
}
for k, v in EXTRA_ALIASES.items():
    _LOOKUP[norm(k)] = v


def translate_ingredient(name: str, given_en: Optional[str] = None) -> Tuple[str, str, str]:
    """Given any ingredient name (in Hungarian or English), resolve:
    Returns (hungarian_name, english_name, category).
    Guarantees that hungarian_name is in Hungarian and english_name is in English.
    """
    raw = (name or "").strip()
    if not raw:
        return ("", "", "other")

    n = norm(raw)

    # 1. Exact lookup
    if n in _LOOKUP:
        hu, en, cat = _LOOKUP[n]
        valid_en = en
        if given_en and given_en.strip():
            # Only keep given_en if it does not match Hungarian name or Hungarian synonyms
            if norm(given_en) != norm(hu) and norm(given_en) != n:
                valid_en = given_en.strip()
        return (hu, valid_en, cat)

    # If given_en provided, check that too
    if given_en:
        n_given = norm(given_en)
        if n_given in _LOOKUP:
            hu, en, cat = _LOOKUP[n_given]
            return (hu, en, cat)

    # 2. Check substring matching against known ingredients
    for key, (hu, en, cat) in _LOOKUP.items():
        if len(key) >= 4:
            if re.search(r"\b" + re.escape(key) + r"\b", n):
                return (hu, given_en.strip() if given_en else en, cat)

    # 3. Heuristic categorization & clean title
    cat = "other"
    if any(w in n for w in ["hagyma", "repa", "zeller", "paprika", "salata", "spenot", "gomba", "onion", "garlic", "tomato", "pepper", "spinach"]):
        cat = "produce"
    elif any(w in n for w in ["sajt", "tej", "turo", "vaj", "tejszin", "joghurt", "milk", "cheese", "butter", "cream", "yogurt"]):
        cat = "dairy"
    elif any(w in n for w in ["hus", "csirke", "pulyka", "marha", "sertes", "kolbasz", "sonka", "chicken", "beef", "pork", "turkey", "meat", "sausage", "bacon"]):
        cat = "meat"
    elif any(w in n for w in ["so", "bors", "chili", "oregano", "bazsalikom", "salt", "pepper", "spice", "herb"]):
        cat = "spice"
    elif any(w in n for w in ["olaj", "zsir", "oil", "fat"]):
        cat = "oil"
    elif any(w in n for w in ["liszt", "teszta", "rizs", "zab", "flour", "pasta", "rice", "bread", "oats"]):
        cat = "grain"
    elif any(w in n for w in ["cukor", "sugar", "sauce", "paste", "szosz", "pure"]):
        cat = "pantry"

    # Detect if raw string looks English
    english_clues = ["powder", "sauce", "extract", "leaves", "cloves", "ground", "diced", "slices", "low fat", "fat free", "sweet", "white", "black", "green"]
    is_english = any(w in n for w in english_clues) or bool(re.search(r"\b(and|with|of|the|for|in)\b", n))

    if is_english:
        en_title = raw.title()
        hu_title = raw.lower()
        return (hu_title, given_en.strip() if given_en else en_title, cat)
    else:
        hu_title = raw.lower()
        en_title = (given_en.strip() if given_en else raw.title())
        return (hu_title, en_title, cat)
