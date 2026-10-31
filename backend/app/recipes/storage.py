"""Thread-safe persistent JSON store for user custom recipes, edits, and sync tombstones."""
from __future__ import annotations

import datetime
import json
import os
import threading
from typing import Dict, List, Optional, Any

from ..config import settings


def _default_recipe_store_path() -> str:
    base = (settings.data_dir or "media").rstrip("/")
    return os.path.join(base, "store", "recipes.json")


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


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
                self._write_unlocked({"recipes": {}, "edits": {}, "deleted_recipes": {}})

    def _read_unlocked(self) -> Dict[str, Any]:
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                doc = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {"recipes": {}, "edits": {}, "deleted_recipes": {}}
        if not isinstance(doc, dict):
            return {"recipes": {}, "edits": {}, "deleted_recipes": {}}
        if "recipes" not in doc or not isinstance(doc["recipes"], dict):
            doc["recipes"] = {}
        if "edits" not in doc or not isinstance(doc["edits"], dict):
            doc["edits"] = {}
        if "deleted_recipes" not in doc or not isinstance(doc["deleted_recipes"], dict):
            doc["deleted_recipes"] = {}
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
            recipe["updated_at"] = recipe.get("updated_at") or _now_iso()
            doc["recipes"][rid] = recipe
            if rid in doc["deleted_recipes"]:
                del doc["deleted_recipes"][rid]
            self._write_unlocked(doc)
            self._sync_kamra_unlocked([recipe])
            return recipe

    def delete_recipe(self, rid: str) -> bool:
        with self._lock:
            doc = self._read_unlocked()
            existed = rid in doc["recipes"] or rid in doc["edits"]
            if rid in doc["recipes"]:
                del doc["recipes"][rid]
            if rid in doc["edits"]:
                del doc["edits"][rid]
            doc["deleted_recipes"][rid] = _now_iso()
            self._write_unlocked(doc)
            return existed

    def reset_edit(self, rid: str) -> bool:
        with self._lock:
            doc = self._read_unlocked()
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
        deleted_ids: Optional[List[str]] = None,
        reset_edit_ids: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            doc = self._read_unlocked()
            changed = False
            changed_recipes: List[Dict[str, Any]] = []

            # 1. Apply deletion tombstones from client
            if deleted_ids:
                for did in deleted_ids:
                    did_str = str(did or "").strip()
                    if not did_str:
                        continue
                    if did_str in doc["recipes"]:
                        del doc["recipes"][did_str]
                        changed = True
                    if did_str in doc["edits"]:
                        del doc["edits"][did_str]
                        changed = True
                    if did_str not in doc["deleted_recipes"]:
                        doc["deleted_recipes"][did_str] = _now_iso()
                        changed = True

            # 2. Apply edit resets ("Visszaállítás eredetire") from client
            if reset_edit_ids:
                for eid in reset_edit_ids:
                    eid_str = str(eid or "").strip()
                    if eid_str and eid_str in doc["edits"]:
                        del doc["edits"][eid_str]
                        changed = True

            # 3. Merge custom recipes (never resurrect tombstoned IDs unless explicitly restored)
            if custom_recipes:
                for r in custom_recipes:
                    rid = str(r.get("id") or "")
                    if not rid:
                        continue
                    if rid in doc["deleted_recipes"] and not r.get("restored"):
                        continue
                    if r.get("restored") and rid in doc["deleted_recipes"]:
                        del doc["deleted_recipes"][rid]
                    existing = doc["recipes"].get(rid)
                    if not existing:
                        doc["recipes"][rid] = r
                        changed_recipes.append(r)
                        changed = True
                    elif r != existing:
                        # Last-write-wins by updated_at if present
                        r_ts = str(r.get("updated_at") or "")
                        ex_ts = str(existing.get("updated_at") or "")
                        if not ex_ts or r_ts >= ex_ts:
                            doc["recipes"][rid] = r
                            changed_recipes.append(r)
                            changed = True

            # 4. Merge edits (skip recipes whose edits were just reset)
            reset_set = set(str(x).strip() for x in (reset_edit_ids or []) if x)
            if edits and isinstance(edits, dict):
                for rid, patch in edits.items():
                    if not rid or rid in reset_set or rid in doc["deleted_recipes"] or not isinstance(patch, dict):
                        continue
                    cur = doc["edits"].get(rid, {})
                    p_ts = str(patch.get("_updated_at") or "")
                    c_ts = str(cur.get("_updated_at") or "")
                    if not cur or not c_ts or p_ts >= c_ts:
                        merged = dict(cur)
                        merged.update(patch)
                        if merged != cur:
                            doc["edits"][rid] = merged
                            changed = True

            if changed:
                self._write_unlocked(doc)

            # Incremental Kamra sync: only sync newly added or changed recipes
            if changed_recipes:
                self._sync_kamra_unlocked(changed_recipes)

            return {
                "custom_recipes": list(doc["recipes"].values()),
                "edits": doc["edits"],
                "deleted_ids": list(doc["deleted_recipes"].keys()),
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
