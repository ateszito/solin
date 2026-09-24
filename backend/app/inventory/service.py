"""CRUD service layer for the Solin inventory (contract §3, §6).

All business rules + validation live here; the HTTP router
(:mod:`app.inventory.routes`) is a thin adapter that maps
:class:`InventoryError` → the normative status code + body. Services are
therefore unit-testable with a temporary ``ProductStore`` and no server.

Semantics implemented (normative):
* POST  → full document creation; server mints id / timestamps / price ids.
* GET   → single + paginated list (case-insensitive name substring).
* PUT   → independent partial fields; ``prices`` is FULL replacement
          (contract §3.4); ``images`` slots accept an ImageSlot dict or null.
* DELETE → row removal + both image slot directories removed (contract §3.5).
* image upload → multipart bytes or base64 both flow here as ``(bytes,
  content_type, original_name)``; replace-last-write-wins.
* seed  → idempotent P1–P4 insert + genuine seed image files (contract §7).
"""

from __future__ import annotations

import os
import shutil
import uuid
from typing import Any, Dict, List, Optional, Tuple

from . import media as m
from .seed_data import (SEED_JPEG, SEED_PNG, seed_products)
from .store import ProductStore
from .validation import (
    ALLOWED_IMAGE_TYPES,
    BASE_UNITS,
    IMAGE_SLOTS,
    MAX_IMAGE_BYTES,
    InventoryError,
    validate_image_body,
    validate_macro_block,
    validate_price_entry,
    validate_slot_name,
)

# ---------------------------------------------------------------------------
# Product payload validation (POST body / PUT body shared field setters)
# ---------------------------------------------------------------------------


def _set_required_string(doc: dict, body: dict, key: str, max_len: int) -> None:
    """Top-level required string (name / base_unit / serving_label optional)."""
    if key in body and body[key] is not None:
        v = body[key]
        if not isinstance(v, str):
            raise InventoryError("UNPROCESSABLE", 422,
                                 f"{key} must be a string", fields=[key])
        s = v.strip()
        if not (1 <= len(s) <= max_len):
            raise InventoryError("VALIDATION_ERROR", 400,
                                 f"{key} must be 1-{max_len} chars after trim",
                                 fields=[key])
        doc[key] = s


def _set_brand(doc: dict, body: dict) -> None:
    if "brand" not in body:
        return
    v = body["brand"]
    if v is None:
        doc["brand"] = None
        return
    if not isinstance(v, str):
        raise InventoryError("UNPROCESSABLE", 422,
                             "brand must be a string or null", fields=["brand"])
    s = v.strip()
    if len(s) > 120:
        raise InventoryError("VALIDATION_ERROR", 400,
                             "brand exceeds max length 120", fields=["brand"])
    doc["brand"] = s


def _set_base_unit(doc: dict, body: dict) -> None:
    if "base_unit" not in body:
        return
    v = body["base_unit"]
    if v not in BASE_UNITS:
        raise InventoryError("VALIDATION_ERROR", 400,
                             f"base_unit must be one of {list(BASE_UNITS)}",
                             fields=["base_unit"])
    doc["base_unit"] = v


def _set_serving(doc: dict, body: dict) -> None:
    if "serving_size" in body and body["serving_size"] is not None:
        v = body["serving_size"]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0:
            raise InventoryError("VALIDATION_ERROR", 400,
                                 "serving_size must be a number > 0",
                                 fields=["serving_size"])
        doc["serving_size"] = float(v)
    elif "serving_size" in body:
        doc["serving_size"] = None
    if "serving_label" in body:
        v = body["serving_label"]
        if v is None:
            doc["serving_label"] = None
        elif not isinstance(v, str) or not (1 <= len(v.strip()) <= 60):
            raise InventoryError("VALIDATION_ERROR", 400,
                                 "serving_label must be 1-60 chars",
                                 fields=["serving_label"])
        else:
            doc["serving_label"] = v.strip()


def _set_macros(doc: dict, body: dict, required: bool) -> None:
    if "macros_per_100" not in body:
        return
    block = body["macros_per_100"]
    if block is None:
        doc["macros_per_100"] = None if not required else _none_error()
        return
    doc["macros_per_100"] = validate_macro_block(block, "macros_per_100")


def _none_error() -> None:
    raise InventoryError(
        "VALIDATION_ERROR", 400,
        "macros_per_100 is required — a product without macros is unaggregable",
        fields=["macros_per_100"])


def _set_prices(doc: dict, body: dict, now: str, next_id) -> None:
    """``prices`` = full replacement (contract §3.4). Absent → keep as-is."""
    if "prices" not in body:
        return
    raw = body["prices"]
    if raw is None:
        doc["prices"] = []
        return
    if not isinstance(raw, list):
        raise InventoryError("UNPROCESSABLE", 422,
                             "prices must be a list of PriceEntry objects",
                             fields=["prices"])
    prices: List[Dict[str, Any]] = []
    for i, entry in enumerate(raw):
        clean = validate_price_entry(entry, i)
        if not clean.get("id"):
            clean["id"] = next_id()  # server-minted stable pr{n}
        if not clean.get("captured_at"):
            clean["captured_at"] = now  # server stamps when omitted
        prices.append(clean)
    doc["prices"] = prices


def _set_images(doc: dict, body: dict, product_id: str) -> None:
    """``images`` in a PUT: each slot → ImageSlot dict (file already uploaded
    via the §3.7 route) or literal null (clear slot). Unmentioned slots keep
    their stored metadata (read-modify-write, contract §3.4)."""
    if "images" not in body:
        return
    raw = body["images"]
    if raw is None:
        doc["images"] = {slot: None for slot in IMAGE_SLOTS}
        return
    if not isinstance(raw, dict):
        raise InventoryError("UNPROCESSABLE", 422,
                             "images must be an object keyed by slot",
                             fields=["images"])
    current = doc.get("images") or {}
    out: Dict[str, Any] = {}
    for slot in IMAGE_SLOTS:
        if slot not in raw:
            out[slot] = current.get(slot)
            continue
        value = raw[slot]
        if value is None:
            out[slot] = None
            continue
        out[slot] = validate_image_body(value, slot)
    doc["images"] = out


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class InventoryService:
    """Stateless service over :class:`ProductStore`.

    ``media_write`` is injectable for tests (default writes real files);
    it receives ``(dir_path, filename, bytes, mime)`` and returns None.
    """

    def __init__(self, store: Optional[ProductStore] = None,
                 media_write=None) -> None:
        self.store = store or ProductStore()
        self._media_write = media_write or _write_media_file

    # ---- create (contract §3.1) -----------------------------------------

    def create(self, body: dict) -> dict:
        """POST /inventory → 201 + full stored product.

        Required: name, base_unit, macros_per_100 (complete C4 block).
        Optional: brand, serving_size/label, prices (≥0 entries).
        Images start as both-null slots (uploads go via the §3.7 route).
        """
        if not isinstance(body, dict):
            raise InventoryError("UNPROCESSABLE", 422,
                                 "request body must be a JSON object",
                                 fields=["body"])
        now = m.now_stamp()
        doc: Dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "name": None,
            "brand": None,
            "base_unit": None,
            "serving_size": None,
            "serving_label": None,
            "macros_per_100": None,
            "prices": [],
            "images": {slot: None for slot in IMAGE_SLOTS},
            "created_at": now,
            "updated_at": now,
        }
        _set_required_string(doc, body, "name", 255)
        if doc["name"] is None:
            raise InventoryError("VALIDATION_ERROR", 400,
                                 "name is required (1-255 chars)",
                                 fields=["name"])
        _set_brand(doc, body)
        _set_base_unit(doc, body)
        if doc["base_unit"] is None:
            raise InventoryError("VALIDATION_ERROR", 400,
                                 f"base_unit is required (one of {list(BASE_UNITS)})",
                                 fields=["base_unit"])
        _set_serving(doc, body)
        _set_macros(doc, body, required=True)
        if doc["macros_per_100"] is None:
            raise InventoryError(
                "VALIDATION_ERROR", 400,
                "macros_per_100 is required — a product without macros is unaggregable",
                fields=["macros_per_100"])
        _set_prices(doc, body, now, self.store.next_price_id)
        self.store.upsert(doc)
        return self.store.get(doc["id"])

    # ---- read (contract §3.2 / §3.3) -------------------------------------

    def get(self, product_id: str) -> dict:
        doc = self.store.get(product_id)
        if doc is None:
            raise InventoryError("NOT_FOUND", 404,
                                 f"product {product_id} not found",
                                 details={"product_id": product_id})
        return doc

    def list(self, limit: int = 50, offset: int = 0, search: str = "") -> dict:
        limit = max(1, min(int(limit or 50), 500))
        offset = max(0, int(offset or 0))
        page, total = self.store.list(limit=limit, offset=offset, search=search)
        return {"items": page, "total": total}

    # ---- update (contract §3.4) -------------------------------------------

    def update(self, product_id: str, body: dict) -> dict:
        """PUT /inventory/{id} — independent partial fields.

        Prices: full-list replacement. Images: per-slot set/clear.
        Unmentioned fields are preserved (read-modify-write).
        """
        stored = self.store.get(product_id)
        if stored is None:
            raise InventoryError("NOT_FOUND", 404,
                                 f"product {product_id} not found",
                                 details={"product_id": product_id})
        if not isinstance(body, dict):
            raise InventoryError("UNPROCESSABLE", 422,
                                 "request body must be a JSON object",
                                 fields=["body"])
        allowed = {"name", "brand", "base_unit", "serving_size",
                   "serving_label", "macros_per_100", "prices", "images"}
        unknown = [k for k in body if k not in allowed]
        if unknown:
            raise InventoryError("VALIDATION_ERROR", 400,
                                 f"unknown fields in PUT body: {unknown}",
                                 fields=unknown)
        doc = dict(stored)  # shallow copy; nested structures replaced below
        now = m.now_stamp()
        if "name" in body:
            _set_required_string(doc, body, "name", 255)
            if not doc.get("name"):
                raise InventoryError("VALIDATION_ERROR", 400,
                                     "name must be 1-255 chars after trim",
                                     fields=["name"])
        _set_brand(doc, body)
        _set_base_unit(doc, body)
        _set_serving(doc, body)
        _set_macros(doc, body, required=False)
        # Contract §3.4 validation rule: product MUST have a macro block after
        # the update (a product without macros is unaggregable).
        if doc.get("macros_per_100") is None:
            raise InventoryError(
                "VALIDATION_ERROR", 400,
                "product has no macro block and the update did not set one",
                fields=["macros_per_100"])
        _set_prices(doc, body, now, self.store.next_price_id)
        _set_images(doc, body, product_id)
        doc["updated_at"] = now
        self.store.upsert(doc)
        return self.store.get(product_id)

    # ---- delete (contract §3.5) ---------------------------------------------

    def delete(self, product_id: str) -> bool:
        """DELETE /inventory/{id}.

        Removes the row AND both image slot directories under
        ``<MEDIA_ROOT>/inventory/{id}/``. Unknown id → 404 NOT_FOUND.
        """
        if not self.store.get(product_id):
            raise InventoryError("NOT_FOUND", 404,
                                 f"product {product_id} not found",
                                 details={"product_id": product_id})
        self.store.delete(product_id)
        # Sweep the whole per-product media dir (both slots + any strays).
        product_media_dir = os.path.join(m.media_root(), "inventory", product_id)
        if os.path.isdir(product_media_dir):
            shutil.rmtree(product_media_dir, ignore_errors=True)
        return True

    # ---- image upload (contract §3.7) -------------------------------------

    def upload_image(self, product_id: str, slot: str, data: bytes,
                     content_type: str,
                     original_name: Optional[str] = None) -> dict:
        """POST /inventory/{id}/images/{slot}.

        * 415 UNSUPPORTED_MEDIA_TYPE — content-type not in §3.7 list.
        * 413 PAYLOAD_TOO_LARGE      — body over MAX_IMAGE_BYTES (10 MB).
        * Re-upload to the same slot REPLACES the previous file (delete old
          file, write new one, overwrite slot metadata — last-write-wins).
        Returns the ImageSlot object (contract §1.1 shape).
        """
        if not self.store.get(product_id):
            raise InventoryError("NOT_FOUND", 404,
                                 f"product {product_id} not found",
                                 details={"product_id": product_id})
        slot = validate_slot_name(slot)
        ctype = (content_type or "").split(";")[0].strip().lower()
        if ctype not in ALLOWED_IMAGE_TYPES:
            raise InventoryError(
                "UNSUPPORTED_MEDIA_TYPE", 415,
                f"content-type {ctype!r} not in {list(ALLOWED_IMAGE_TYPES)}",
                fields=["file"])
        if not data:
            raise InventoryError("VALIDATION_ERROR", 400,
                                 "file body is empty", fields=["file"])
        if len(data) > MAX_IMAGE_BYTES:
            raise InventoryError(
                "PAYLOAD_TOO_LARGE", 413,
                f"file is {len(data)} bytes; max is {MAX_IMAGE_BYTES}",
                fields=["file"])

        dirname = m.slot_dir(product_id, slot)
        filename = m.slugify(original_name or "upload") + "." + m.EXT_BY_MIME[ctype]
        self._media_write(dirname, filename, data, ctype)

        # Replace the previous file in this slot (last-write-wins, §3.7).
        doc = self.store.get(product_id)
        if doc is None:  # pragma: no cover — race with concurrent DELETE
            raise InventoryError("NOT_FOUND", 404,
                                 f"product {product_id} not found",
                                 details={"product_id": product_id})
        prev = (doc.get("images") or {}).get(slot)
        if prev and prev.get("filename") != filename:
            old_path = os.path.join(dirname, prev["filename"])
            if os.path.exists(old_path):
                os.remove(old_path)

        now = m.now_stamp()
        images = dict(doc.get("images") or {})
        images[slot] = {
            "url": m.slot_url(product_id, slot, filename),
            "filename": filename,
            "mime_type": ctype,
            "byte_size": len(data),
            "original_name": original_name or None,
            "uploaded_at": now,
        }
        doc["images"] = images
        doc["updated_at"] = now
        self.store.upsert(doc)
        return images[slot]

    # ---- seed (contract §7) --------------------------------------------------

    def seed(self) -> Dict[str, str]:
        """Idempotent P1–P4 seed (contract §7) + seed image files for P1/P2.

        Re-runs are safe: products are kept if present, seed images are only
        written when missing. Returns the store's {seed_id: action} report.
        """
        doc_images = {
            "p1": {
                "product_photo": (SEED_JPEG, "chicken-breast.jpg"),
                "label_photo": (SEED_PNG, "chicken-label.png"),
            },
            "p2": {
                "product_photo": (SEED_JPEG, "rice.jpg"),
                "label_photo": (SEED_PNG, "rice-label.png"),
            },
        }
        report = self.store.seed(seed_products())
        for pid, slots in doc_images.items():
            stored = self.store.get(pid)
            if stored is None:
                continue
            for slot, (fmt, original) in slots.items():
                dirname = m.slot_dir(pid, slot)
                filename = stored["images"][slot]["filename"]
                path = os.path.join(dirname, filename)
                if not os.path.exists(path):
                    self._media_write(dirname, filename, fmt["bytes"], fmt["mime"])
        return report


# ---------------------------------------------------------------------------
# default media writer (filesystem)
# ---------------------------------------------------------------------------

def _write_media_file(dirname: str, filename: str, data: bytes, mime: str) -> None:
    """Write one image file durably (mkdir -p + fsync)."""
    os.makedirs(dirname, exist_ok=True)
    path = os.path.join(dirname, filename)
    with open(path, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())


#: Default service singleton used by the routes (tests build their own with
#: a temporary store, so this instance is only touched by the live app).
default_service = InventoryService()
