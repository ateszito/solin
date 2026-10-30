"""Thread-safe flat JSON storage for Kamra (Pantry) ingredients."""
from __future__ import annotations

import json
import os
import threading
from typing import Dict, List, Optional, Any

from ..config import settings
from .seed_data import get_seed_kamra_items

MAX_STORE_BYTES = 10 * 1024 * 1024


def _default_kamra_store_path() -> str:
    base = (settings.data_dir or "media").rstrip("/")
    return os.path.join(base, "store", "kamra.json")


class KamraStore:
    """Thread-safe read-modify-write access to the Kamra items document."""

    def __init__(self, path: Optional[str] = None) -> None:
        self._path = path or _default_kamra_store_path()
        self._lock = threading.Lock()
        self._ensure_seeded()

    @property
    def path(self) -> str:
        return self._path

    def _ensure_seeded(self) -> None:
        with self._lock:
            if not os.path.exists(self._path):
                seeds = get_seed_kamra_items()
                doc = {item["id"]: item for item in seeds}
                self._write_unlocked(doc)

    def _read_unlocked(self) -> Dict[str, Dict[str, Any]]:
        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
        if not isinstance(doc, dict):
            return {}
        return doc

    def _write_unlocked(self, doc: Dict[str, Dict[str, Any]]) -> None:
        parent = os.path.dirname(self._path) or "."
        os.makedirs(parent, exist_ok=True)
        payload = json.dumps(doc, indent=2, ensure_ascii=False)
        if len(payload.encode("utf-8")) > MAX_STORE_BYTES:
            raise ValueError("Kamra store exceeds max byte size")
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(payload)
        os.replace(tmp, self._path)

    def list_all(self) -> List[Dict[str, Any]]:
        with self._lock:
            doc = self._read_unlocked()
            return sorted(list(doc.values()), key=lambda x: str(x.get("name") or "").lower())

    def get(self, item_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            doc = self._read_unlocked()
            return doc.get(item_id)

    def save(self, item: Dict[str, Any]) -> Dict[str, Any]:
        item_id = item["id"]
        with self._lock:
            doc = self._read_unlocked()
            doc[item_id] = item
            self._write_unlocked(doc)
            return item

    def delete(self, item_id: str) -> bool:
        with self._lock:
            doc = self._read_unlocked()
            if item_id in doc:
                del doc[item_id]
                self._write_unlocked(doc)
                return True
            return False
