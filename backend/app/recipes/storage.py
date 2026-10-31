"""Thread-safe persistent JSON store for user custom recipes and edits."""
from __future__ import annotations

import json
import os
import threading
from typing import Dict, List, Optional, Any

from ..config import settings


def _default_recipe_store_path() -> str:
    base = (settings.data_dir or "media").rstrip("/")
    return os.path.join(base, "store", "recipes.json")


class RecipeStore:
    def __init__(self, path: Optional[str] = None) -> None:
        self._path = path or _default_recipe_store_path()
        self._lock = threading.Lock()
        self._ensure_init()

    @property
    def path(self) -> str:
        return self._path

    def _ensure_init(self) -> None:
        with self._lock:
            if not os.path.exists(self._path):
                self._write_unlocked({"recipes": {}, "edits": {}})

    def _read_unlocked(self) -> Dict[str, Any]:
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                doc = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {"recipes": {}, "edits": {}}
        if not isinstance(doc, dict):
            return {"recipes": {}, "edits": {}}
        if "recipes" not in doc or not isinstance(doc["recipes"], dict):
            doc["recipes"] = {}
        if "edits" not in doc or not isinstance(doc["edits"], dict):
            doc["edits"] = {}
        return doc

    def _write_unlocked(self, doc: Dict[str, Any]) -> None:
        parent = os.path.dirname(self._path) or "."
        os.makedirs(parent, exist_ok=True)
        payload = json.dumps(doc, indent=2, ensure_ascii=False)
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp, self._path)

    def list_recipes(self) -> List[Dict[str, Any]]:
        with self._lock:
            doc = self._read_unlocked()
            return list(doc["recipes"].values())

    def get_recipe(self, rid: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            doc = self._read_unlocked()
            return doc["recipes"].get(rid)

    def save_recipe(self, recipe: Dict[str, Any]) -> Dict[str, Any]:
        rid = str(recipe.get("id") or "")
        if not rid:
            return recipe
        with self._lock:
            doc = self._read_unlocked()
            doc["recipes"][rid] = recipe
            self._write_unlocked(doc)
            self._sync_kamra_unlocked([recipe])
            return recipe

    def delete_recipe(self, rid: str) -> bool:
        with self._lock:
            doc = self._read_unlocked()
            if rid in doc["recipes"]:
                del doc["recipes"][rid]
                if rid in doc["edits"]:
                    del doc["edits"][rid]
                self._write_unlocked(doc)
                return True
            return False

    def get_edits(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            doc = self._read_unlocked()
            return doc["edits"]

    def sync(
        self,
        custom_recipes: Optional[List[Dict[str, Any]]] = None,
        edits: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            doc = self._read_unlocked()
            changed = False

            if custom_recipes:
                for r in custom_recipes:
                    rid = str(r.get("id") or "")
                    if not rid:
                        continue
                    existing = doc["recipes"].get(rid)
                    if not existing or r != existing:
                        doc["recipes"][rid] = r
                        changed = True

            if edits and isinstance(edits, dict):
                for rid, patch in edits.items():
                    if not rid or not isinstance(patch, dict):
                        continue
                    cur = doc["edits"].get(rid, {})
                    merged = dict(cur)
                    merged.update(patch)
                    if merged != cur:
                        doc["edits"][rid] = merged
                        changed = True

            if changed:
                self._write_unlocked(doc)

            self._sync_kamra_unlocked(list(doc["recipes"].values()))

            return {
                "custom_recipes": list(doc["recipes"].values()),
                "edits": doc["edits"],
            }

    def _sync_kamra_unlocked(self, recipes) -> None:
        try:
            from ..kamra.service import default_kamra_service
            from ..kamra.model import RecipeSyncRequest, RecipeIngredientItem

            all_ings = []
            for r in recipes:
                ings = r.get("ingredients") or []
                for ing in ings:
                    if isinstance(ing, dict) and ing.get("name"):
                        all_ings.append(
                            RecipeIngredientItem(
                                name=ing["name"],
                                qty=str(ing.get("qty") or ""),
                                note=str(ing.get("note") or ""),
                            )
                        )
                    elif isinstance(ing, str) and ing.strip():
                        all_ings.append(RecipeIngredientItem(name=ing.strip()))
            if all_ings:
                default_kamra_service.sync_recipe(RecipeSyncRequest(ingredients=all_ings, auto_create=True))
        except Exception as e:
            import logging
            logging.getLogger("uvicorn.error").warning("RecipeStore Kamra sync warning: %s", e)


default_recipe_store = RecipeStore()
