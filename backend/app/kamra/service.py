"""Business logic for Kamra ingredient matching, translation, and product linking."""
from __future__ import annotations

import datetime
import json
import logging
import re
import unicodedata
from typing import Dict, List, Optional, Any, Tuple

from .model import KamraItem, KamraItemCreate, KamraItemUpdate, RecipeSyncRequest, RecipeSyncResponse, RecipeSyncResultItem
from .store import KamraStore
from .translator import translate_ingredient, norm

logger = logging.getLogger("uvicorn.error")


def norm(s: str) -> str:
    """Normalize string for fuzzy comparison: lowercase, accent-stripped, clean spaces."""
    if not s:
        return ""
    # Strip accents
    nfkd = unicodedata.normalize("NFKD", str(s).lower())
    clean = "".join([c for c in nfkd if not unicodedata.combining(c)])
    # Convert hyphens to space, remove other punctuation
    clean = clean.replace("-", " ")
    clean = re.sub(r"[^\w\s]", " ", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean


def slugify(s: str) -> str:
    """Generate a clean slug identifier from name."""
    clean = norm(s)
    slug = re.sub(r"[\s-]+", "_", clean)
    return slug[:50] or "item"


# Common culinary English <-> Hungarian dictionary fallback
COMMON_TRANSLATIONS: Dict[str, Tuple[str, str]] = {
    "egg": ("tojás", "dairy"),
    "eggs": ("tojás", "dairy"),
    "tojas": ("Egg", "dairy"),
    "butter": ("vaj", "dairy"),
    "vaj": ("Butter", "dairy"),
    "milk": ("tej", "dairy"),
    "tej": ("Milk", "dairy"),
    "sour cream": ("tejföl", "dairy"),
    "tejfol": ("Sour cream", "dairy"),
    "flour": ("liszt", "grain"),
    "liszt": ("Flour", "grain"),
    "sugar": ("cukor", "pantry"),
    "cukor": ("Sugar", "pantry"),
    "honey": ("méz", "pantry"),
    "mez": ("Honey", "pantry"),
    "beef": ("marhahús", "meat"),
    "marha": ("Beef", "meat"),
    "pork": ("sertéshús", "meat"),
    "sertes": ("Pork", "meat"),
    "fish": ("hal", "meat"),
    "hal": ("Fish", "meat"),
    "salmon": ("lazac", "meat"),
    "lazac": ("Salmon", "meat"),
    "tuna": ("tonhal", "meat"),
    "tonhal": ("Tuna", "meat"),
    "bacon": ("bacon", "meat"),
    "ham": ("sonka", "meat"),
    "sonka": ("Ham", "meat"),
    "cheese": ("sajt", "dairy"),
    "sajt": ("Cheese", "dairy"),
    "bread": ("kenyér", "grain"),
    "kenyer": ("Bread", "grain"),
    "cucumber": ("uborka", "produce"),
    "uborka": ("Cucumber", "produce"),
    "tomato": ("paradicsom", "produce"),
    "paradicsom": ("Tomato", "produce"),
    "lettuce": ("fejes saláta", "produce"),
    "salata": ("Lettuce", "produce"),
    "mushroom": ("gomba", "produce"),
    "gomba": ("Mushroom", "produce"),
    "lemon": ("citrom", "produce"),
    "citrom": ("Lemon", "produce"),
    "lime": ("zöldcitrom", "produce"),
    "apple": ("alma", "produce"),
    "alma": ("Apple", "produce"),
    "banana": ("banán", "produce"),
    "banan": ("Banana", "produce"),
    "oregano": ("oregánó", "spice"),
    "oregano": ("Oregano", "spice"),
    "basil": ("bazsalikom", "spice"),
    "bazsalikom": ("Basil", "spice"),
    "thyme": ("kakukkfű", "spice"),
    "kakukkfu": ("Thyme", "spice"),
    "rosemary": ("rozmaring", "spice"),
    "rozmaring": ("Rosemary", "spice"),
    "cinnamon": ("fahéj", "spice"),
    "fahej": ("Cinnamon", "spice"),
    "vanilla": ("vanília", "spice"),
    "vanilia": ("Vanilla", "spice"),
    "olive oil": ("olívaolaj", "oil"),
    "olivaolaj": ("Olive oil", "oil"),
}


class KamraService:
    def __init__(self, store: Optional[KamraStore] = None) -> None:
        self.store = store or KamraStore()

    def list_items(self, query: Optional[str] = None, category: Optional[str] = None) -> List[Dict[str, Any]]:
        items = self.store.list_all()
        if category:
            items = [i for i in items if (i.get("category") or "").lower() == category.lower()]
        if query:
            nq = norm(query)
            filtered = []
            for item in items:
                # Check id, name, name_en, synonyms
                if (
                    nq in norm(item.get("name", ""))
                    or nq in norm(item.get("name_en", ""))
                    or any(nq in norm(s) for s in item.get("synonyms", []))
                ):
                    filtered.append(item)
            return filtered
        return items

    def get_item(self, item_id: str) -> Optional[Dict[str, Any]]:
        return self.store.get(item_id)

    def find_match(self, raw_name: str) -> Optional[Dict[str, Any]]:
        """Find an existing Kamra ingredient matching raw_name by name, name_en, synonyms, or translated form."""
        n_target = norm(raw_name)
        if not n_target:
            return None

        all_items = self.store.list_all()
        # 1. Exact normalized match on name or name_en
        for item in all_items:
            if norm(item.get("name", "")) == n_target or norm(item.get("name_en", "")) == n_target:
                return item

        # 2. Exact match in synonyms
        for item in all_items:
            for syn in item.get("synonyms", []):
                if norm(syn) == n_target:
                    return item

        # 3. Check via bilingual translator
        hu_t, en_t, _ = translate_ingredient(raw_name)
        n_hu = norm(hu_t)
        n_en = norm(en_t)
        for item in all_items:
            if n_hu and (norm(item.get("name", "")) == n_hu or norm(item.get("name_en", "")) == n_hu):
                return item
            if n_en and (norm(item.get("name", "")) == n_en or norm(item.get("name_en", "")) == n_en):
                return item
            for syn in item.get("synonyms", []):
                ns = norm(syn)
                if (n_hu and ns == n_hu) or (n_en and ns == n_en):
                    return item

        # 4. Word-boundary containment match
        for item in all_items:
            n_name = norm(item.get("name", ""))
            if len(n_name) >= 3 and re.search(r"\b" + re.escape(n_name) + r"\b", n_target):
                return item
            n_en_item = norm(item.get("name_en", ""))
            if len(n_en_item) >= 3 and re.search(r"\b" + re.escape(n_en_item) + r"\b", n_target):
                return item
            for syn in item.get("synonyms", []):
                n_syn = norm(syn)
                if len(n_syn) >= 3 and re.search(r"\b" + re.escape(n_syn) + r"\b", n_target):
                    return item

        return None

    def auto_translate_and_categorize(self, name: str, given_en: Optional[str] = None) -> Tuple[str, str, str]:
        """Infer Hungarian name, English translation and culinary category for an ingredient."""
        return translate_ingredient(name, given_en)

    def create_item(self, payload: KamraItemCreate) -> Dict[str, Any]:
        hu_name, en_name, inferred_cat = translate_ingredient(payload.name, payload.name_en)
        item_id = slugify(hu_name)
        existing = self.store.get(item_id)
        if existing:
            idx = 2
            while self.store.get(f"{item_id}_{idx}"):
                idx += 1
            item_id = f"{item_id}_{idx}"

        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        category = payload.category if (payload.category and payload.category != "other") else inferred_cat

        syns = [hu_name.lower()]
        if payload.name.lower() not in syns:
            syns.append(payload.name.lower())
        if en_name.lower() not in syns:
            syns.append(en_name.lower())
        for s in (payload.synonyms or []):
            if s.lower() not in syns:
                syns.append(s.lower())

        item = {
            "id": item_id,
            "name": hu_name.strip().lower(),
            "name_en": en_name.strip(),
            "category": category,
            "synonyms": syns,
            "subs": payload.subs or [],
            "product_ids": payload.product_ids or [],
            "default_unit": payload.default_unit or "g",
            "created_at": now,
            "updated_at": now,
        }
        return self.store.save(item)

    def backfill_bilingual_translations(self) -> int:
        """Scan all Kamra items and backfill missing or duplicate Hungarian/English names."""
        all_items = self.store.list_all()
        updated_count = 0
        for item in all_items:
            cur_hu = item.get("name", "")
            cur_en = item.get("name_en", "")
            hu_trans, en_trans, cat_trans = translate_ingredient(cur_hu, cur_en)

            changed = False
            # If name is english (matches en translation or equals name_en), update to proper Hungarian
            if (norm(cur_hu) == norm(en_trans) or cur_hu.lower() == cur_en.lower()) and hu_trans.lower() != cur_hu.lower():
                item["name"] = hu_trans.lower()
                item["name_en"] = en_trans
                changed = True
            elif not cur_en or cur_en.lower() == cur_hu.lower():
                item["name_en"] = en_trans
                changed = True

            if item.get("category") == "other" and cat_trans != "other":
                item["category"] = cat_trans
                changed = True

            # Ensure synonyms include both
            syns = [s for s in item.get("synonyms", [])]
            for candidate in [cur_hu, cur_en, hu_trans, en_trans]:
                if candidate and candidate.lower() not in [s.lower() for s in syns]:
                    syns.append(candidate.lower())
                    changed = True
            item["synonyms"] = syns

            if changed:
                item["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                self.store.save(item)
                updated_count += 1

        return updated_count

    def update_item(self, item_id: str, payload: KamraItemUpdate) -> Optional[Dict[str, Any]]:
        existing = self.store.get(item_id)
        if not existing:
            return None

        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        data = existing.copy()
        if payload.name is not None:
            data["name"] = payload.name.strip().lower()
        if payload.name_en is not None:
            data["name_en"] = payload.name_en.strip()
        if payload.category is not None:
            data["category"] = payload.category
        if payload.synonyms is not None:
            data["synonyms"] = list(dict.fromkeys(payload.synonyms))
        if payload.subs is not None:
            data["subs"] = payload.subs
        if payload.product_ids is not None:
            data["product_ids"] = list(dict.fromkeys(payload.product_ids))
        if payload.default_unit is not None:
            data["default_unit"] = payload.default_unit
        data["updated_at"] = now

        return self.store.save(data)

    def delete_item(self, item_id: str) -> bool:
        return self.store.delete(item_id)

    def sync_recipe(self, req: RecipeSyncRequest) -> RecipeSyncResponse:
        """Sync a recipe's ingredients with Kamra. Existing are linked; missing are registered."""
        results: List[RecipeSyncResultItem] = []
        created_count = 0

        for ing in req.ingredients:
            raw_name = (ing.name or "").strip()
            if not raw_name:
                continue

            match = self.find_match(raw_name)
            if match:
                # If existing entry has duplicate hu/en names, backfill proper translation
                hu_trans, en_trans, cat_trans = translate_ingredient(match.get("name", ""), match.get("name_en"))
                changed = False
                if match.get("name") == match.get("name_en") and hu_trans.lower() != match.get("name", "").lower():
                    match["name"] = hu_trans.lower()
                    match["name_en"] = en_trans
                    changed = True
                elif not match.get("name_en") and en_trans:
                    match["name_en"] = en_trans
                    changed = True

                syns = match.get("synonyms") or []
                if raw_name.lower() not in [s.lower() for s in syns] and raw_name.lower() != match.get("name"):
                    syns.append(raw_name.lower())
                    match["synonyms"] = syns
                    changed = True

                if changed:
                    self.store.save(match)

                results.append(
                    RecipeSyncResultItem(
                        original_name=raw_name,
                        kamra_id=match["id"],
                        name=match["name"],
                        name_en=match.get("name_en", ""),
                        category=match.get("category", "other"),
                        subs=match.get("subs", []),
                        product_ids=match.get("product_ids", []),
                        is_new=False,
                    )
                )
            elif req.auto_create:
                # Create new entry in Kamra
                new_item = self.create_item(
                    KamraItemCreate(
                        name=raw_name,
                        synonyms=[raw_name],
                    )
                )
                created_count += 1
                results.append(
                    RecipeSyncResultItem(
                        original_name=raw_name,
                        kamra_id=new_item["id"],
                        name=new_item["name"],
                        name_en=new_item.get("name_en", ""),
                        category=new_item.get("category", "other"),
                        subs=new_item.get("subs", []),
                        product_ids=new_item.get("product_ids", []),
                        is_new=True,
                    )
                )

        return RecipeSyncResponse(synced=results, created_count=created_count)


default_kamra_service = KamraService()
