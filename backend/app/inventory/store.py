"""Flat-file JSON storage for the Solin inventory (contract §2).

The canonical store is a single JSON document at ``<DATA_DIR>/store/
products.json`` holding ``{"products": {<id>: <Product doc>}}`` plus a
monotonic price-entry counter used to derive stable, non-colliding
``pr{n}`` ids for rehydrated seed data.

Why a flat store (the contract allows "JSONB columns OR sibling tables")?
  * The MVP has no running Postgres; a single JSON file is atomic to read
    (single process) and trivially diffable in code review.
  * The API response shape is what the contract marks normative, and both
    storage layouts must produce identical JSON — a flat store guarantees
    that by construction.

All mutation goes through :class:`ProductStore` so the lock discipline is
in one place (last-write-wins on concurrent PUTs, contract §3.4).

Concurrency model: a single process-local ``threading.Lock``. FastAPI's
default sync route handlers run in a threadpool; the lock makes
read-modify-write atomic across them. Cross-process locking is a
non-goal for the MVP (single uvicorn worker per deploy per DEPLOY.md).
"""

from __future__ import annotations

import json
import os
import re
import threading
from typing import Dict, Iterator, List, Optional, Tuple

from ..config import settings

#: Max bytes we accept when (re)serialising — keeps a fat store from
#: silently ballooning the file (each price entry is ~150 bytes, so 10 MB
#: holds ~65k entries; far beyond any realistic dataset).
MAX_STORE_BYTES = 10 * 1024 * 1024

#: Numeric token — used to pull pr{n} ids out of existing docs so a re-seed
#: never collides with a previously generated price entry id.
_PRICE_ID_RE = re.compile(r"^pr(\d+)$")


def _default_store_path() -> str:
    """Normative store location: ``<DATA_DIR>/store/products.json``.

    ``DATA_DIR`` is the operator override (e.g. the docker volume); the
    default is the repo's ``media/`` dir. Tests point DATA_DIR at a tmpdir
    via env, so this stays a pure function of the environment.
    """
    base = (settings.data_dir or "media").rstrip("/")
    return os.path.join(base, "store", "products.json")


class ProductStore:
    """Thread-safe read-modify-write access to the product document.

    The store is deliberately *dumb*: no validation, no timestamps, no
    media handling — those are service-layer concerns so the service can be
    unit-tested by injecting a temporary store (see
    ``tests/test_inventory_unit.py``).
    """

    def __init__(self, path: Optional[str] = None) -> None:
        self._path = path or _default_store_path()
        self._lock = threading.Lock()

    # ---- low-level file IO -------------------------------------------

    @property
    def path(self) -> str:
        """Absolute-ish path of the backing file (for diagnostics/tests)."""
        return self._path

    def _read(self) -> Dict:
        """Read the document (locking the caller). Missing/corrupt file →
        an empty store: the service layer decides what "no data" means."""
        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
        except FileNotFoundError:
            return {"products": {}, "price_seq": 0}
        # Be defensive: a hand-edited file may miss keys — normalise.
        if not isinstance(doc.get("products"), dict):
            doc["products"] = {}
        if not isinstance(doc.get("price_seq"), int):
            doc["price_seq"] = 0
        return doc

    def _write(self, doc: Dict) -> None:
        """Serialise atomically (tmp file + rename) so a crash mid-write
        can never leave a truncated products.json behind."""
        parent = os.path.dirname(self._path) or "."
        os.makedirs(parent, exist_ok=True)
        payload = json.dumps(doc, indent=2, ensure_ascii=False)
        if len(payload.encode("utf-8")) > MAX_STORE_BYTES:
            # The service maps this to a 422 UNPROCESSABLE — the *store*
            # just has to say "no".
            raise ValueError("products store exceeds max byte size")
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self._path)

    # ---- product CRUD (service-facing) --------------------------------

    def load(self) -> Dict[str, dict]:
        """Snapshot of all products (id → doc), deep-copied so callers can
        mutate freely."""
        with self._lock:
            return {pid: dict(p) for pid, p in self._read()["products"].items()}

    def get(self, product_id: str) -> Optional[dict]:
        with self._lock:
            doc = self._read()["products"].get(product_id)
            return dict(doc) if doc is not None else None

    def list(self, limit: int = 50, offset: int = 0,
             search: str = "") -> Tuple[List[dict], int]:
        """Paginated list (contract §3.2). ``search`` is a case-insensitive
        substring match on ``name`` only (contract §9: no other filters).
        Order: ``created_at`` then id, stable across pages."""
        with self._lock:
            products = self._read()["products"]
        needle = (search or "").strip().lower()
        items = [
            dict(p) for p in products.values()
            if not needle or needle in str(p.get("name", "")).lower()
        ]
        items.sort(key=lambda p: (p.get("created_at", ""), p.get("id", "")))
        total = len(items)
        page = items[max(0, offset): max(0, offset) + max(0, limit)]
        return page, total

    def upsert(self, doc: dict) -> None:
        """Insert or replace one product doc (full document, not a diff)."""
        pid = doc.get("id")
        if not pid:
            raise ValueError("product doc is missing its id")
        with self._lock:
            data = self._read()
            data["products"][pid] = doc
            self._write(data)

    def delete(self, product_id: str) -> bool:
        """Remove the row. Returns True if a product was actually deleted."""
        with self._lock:
            data = self._read()
            if product_id in data["products"]:
                del data["products"][product_id]
                self._write(data)
                return True
            return False

    def iter_ids(self) -> Iterator[str]:
        with self._lock:
            products = self._read()["products"]
        yield from products

    # ---- seed ----------------------------------------------------------

    def seed(self, products: List[dict]) -> Dict[str, str]:
        """Idempotent seed (contract §7): for each entry, insert by its
        canonical seed id (e.g. ``p1``) if absent, else leave the stored
        record untouched (last-write-wins for real users).

        Returns ``{seed_id: action}`` where action is ``"inserted"`` or
        ``"kept"`` — the QA harness wants to tell the two apart.
        """
        report: Dict[str, str] = {}
        with self._lock:
            data = self._read()
            for doc in products:
                pid = str(doc.get("id", "")).strip()
                if not pid:
                    continue
                if pid in data["products"]:
                    report[pid] = "kept"
                    continue
                # Bump the price_seq watermark so pr{n} ids minted by the
                # service later in the process lifetime cannot collide.
                for price in doc.get("prices") or []:
                    m = _PRICE_ID_RE.match(str((price or {}).get("id", "")))
                    if m:
                        data["price_seq"] = max(data["price_seq"], int(m.group(1)))
                data["products"][pid] = {**doc}
                report[pid] = "inserted"
            self._write(data)
        return report

    def next_price_id(self) -> str:
        """Mint the next stable ``pr{n}`` id (monotonic across restarts)."""
        with self._lock:
            data = self._read()
            data["price_seq"] = int(data.get("price_seq", 0)) + 1
            self._write(data)
            return f"pr{data['price_seq']}"
