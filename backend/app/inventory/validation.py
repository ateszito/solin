"""Validation helpers for the inventory service layer (contract §1, §6).

Why a separate module: the validators are pure functions over plain dicts,
so the service can raise :class:`InventoryError` (→ 400/422) with the
*normative* error shape ``{code, message, details, fields}`` while the HTTP
layer stays a thin adapter. Nothing here touches the store or the
filesystem — unit-testable in isolation.

Error mapping (contract §6):
* ``VALIDATION_ERROR``            — field-level failure; ``fields`` lists keys
* ``MACRO_BLOCK_INCOMPLETE``      — C4 macro key missing / non-numeric
* ``UNPROCESSABLE``               — type-shape mismatch (str where number)
* ``PAYLOAD_TOO_LARGE``           — image over MAX_IMAGE_BYTES
* ``UNSUPPORTED_MEDIA_TYPE``      — content-type not in ALLOWED_IMAGE_TYPES
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

# ---- canonical constants (normative, contract §0 / §1 / §3) -------------

#: C4 — the ONLY macro fields, canonical order. Every key is required
#: inside a MacroBlock; ``0`` is valid, *missing* is MACRO_BLOCK_INCOMPLETE.
MACRO_KEYS: Tuple[str, ...] = (
    "calories", "protein", "fat", "carbs", "fiber", "sugar", "sodium",
)

#: A product's base unit must be one of these (contract §1.1).
BASE_UNITS = ("g", "ml", "pcs")

#: C3 — the full legal unit enum (matches recipe.schema.json).
UNITS = ("g", "kg", "mg", "ml", "l", "cup", "tbsp", "tsp",
         "pcs", "slice", "cloves", "pinch", "dash")

#: §3.7 — the three accepted image content-types.
ALLOWED_IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")

#: §3.7 — max upload bytes. QA's oversized-file test expects 413 above this.
MAX_IMAGE_BYTES = 10 * 1024 * 1024

#: The two image slots (product photo + label photo), in canonical order.
IMAGE_SLOTS = ("product_photo", "label_photo")


class InventoryError(Exception):
    """Service-layer error carrying the normative §6 error shape.

    The HTTP layer maps ``status_code``→HTTP and returns ``to_body()`` as
    the response body, so the *exact* ``{code, message, details, fields}``
    structure reaches the client untouched.
    """

    def __init__(self, code: str, status_code: int, message: str,
                 details: Optional[Any] = None,
                 fields: Optional[List[str]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.message = message
        self.details = details
        self.fields = fields or []

    def to_body(self) -> Dict[str, Any]:
        body: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            body["details"] = self.details
        if self.fields:
            body["fields"] = self.fields
        return body


# ---- low-level type predicates ------------------------------------------

def _is_number(v: Any) -> bool:
    """True for real JSON numbers — ints/floats, but NOT bool (bool is an
    int subclass in Python and would otherwise sneak past numeric checks)."""
    if isinstance(v, bool):
        return False
    if not isinstance(v, (int, float)):
        return False
    # Reject NaN / inf: they are not valid JSON numbers and the contract's
    # "number > 0" / ">= 0" comparisons are meaningless for them.
    return math.isfinite(v)


def _is_iso_currency(v: Any) -> bool:
    return (isinstance(v, str) and len(v) == 3
            and v.isalpha() and v.isupper())


def _clean_str(v: Any, max_len: int, field: str, fields: List[str],
               code: str = "VALIDATION_ERROR") -> str:
    if not isinstance(v, str):
        raise InventoryError(code, 422, f"{field} must be a string", fields=fields)
    s = v.strip()
    if len(s) > max_len:
        raise InventoryError(
            code, 400, f"{field} exceeds max length {max_len}", fields=[field])
    return s


# ---- field validators ----------------------------------------------------

def validate_macro_block(block: Any, field: str = "macros_per_100") -> Dict[str, float]:
    """Validate and normalise one MacroBlock (C4).

    Returns a fresh dict of ``{key: float}`` in canonical order. Missing or
    non-numeric keys are ``MACRO_BLOCK_INCOMPLETE`` (400) per §1.1/§6; a
    bool in place of a number is ``UNPROCESSABLE`` (422).
    """
    fields: List[str] = []
    if not isinstance(block, dict):
        raise InventoryError(
            "UNPROCESSABLE", 422, f"{field} must be an object with all C4 keys",
            fields=[field])
    out: Dict[str, float] = {}
    for key in MACRO_KEYS:
        v = block.get(key)
        if v is None:
            raise InventoryError(
                "MACRO_BLOCK_INCOMPLETE", 400,
                f"{field}.{key} is required (all C4 macro fields are mandatory)",
                fields=[f"{field}.{key}"])
        if isinstance(v, bool) or not _is_number(v):
            # Contract §1.1: any C4 key *missing or non-numeric* →
            # MACRO_BLOCK_INCOMPLETE (400). bool is a non-number here.
            fields.append(f"{field}.{key}")
            raise InventoryError(
                "MACRO_BLOCK_INCOMPLETE", 400,
                f"{field}.{key} is missing or not a number", fields=fields)
        if v < 0:
            raise InventoryError(
                "VALIDATION_ERROR", 400, f"{field}.{key} must be >= 0",
                fields=[f"{field}.{key}"])
        out[key] = float(v)
    return out


def _require_positive(v: Any, field: str, fields: List[str]) -> float:
    """Number strictly > 0 → float; else the normative error (§6 split):

    * missing (None) or numeric-but-<= 0 → 400 ``VALIDATION_ERROR`` (field-level)
    * any other type (str, list, bool, …) → 422 ``UNPROCESSABLE`` (type-shape)
    """
    if v is None:
        raise InventoryError("VALIDATION_ERROR", 400,
                             f"{field} is required and must be a number > 0",
                             fields=[field])
    if isinstance(v, bool) or not _is_number(v):
        raise InventoryError("UNPROCESSABLE", 422,
                             f"{field} must be a number (got {type(v).__name__})",
                             fields=[field])
    if v <= 0:
        raise InventoryError("VALIDATION_ERROR", 400,
                             f"{field} must be > 0", fields=[field])
    return float(v)


def validate_price_entry(entry: Any, index: int) -> Dict[str, Any]:
    """Validate one element of ``product.prices[]`` (§1.2).

    Unknown keys are dropped (forward-compatible); ``id`` is preserved only
    if present (PUT full-replacement keeps client-supplied stable ids);
    ``currency`` is normalised to ISO-4217 UPPER. Returns a clean dict.
    """
    prefix = f"prices[{index}]"
    fields: List[str] = []
    if not isinstance(entry, dict):
        raise InventoryError("UNPROCESSABLE", 422,
                             f"{prefix} must be an object", fields=[prefix])

    amount = _require_positive(entry.get("amount"), f"{prefix}.amount", fields)

    currency = entry.get("currency")
    if not (isinstance(currency, str) and currency.strip()):
        raise InventoryError(
            "VALIDATION_ERROR", 400,
            f"{prefix}.currency must be a 3-letter ISO-4217 code (e.g. USD, EUR, HUF)",
            fields=[f"{prefix}.currency"])
    currency = currency.strip().upper()  # stored UPPER (contract §1.2)
    if not _is_iso_currency(currency):
        raise InventoryError(
            "VALIDATION_ERROR", 400,
            f"{prefix}.currency must be a 3-letter ISO-4217 code (e.g. USD, EUR, HUF)",
            fields=[f"{prefix}.currency"])

    pack_size = _require_positive(entry.get("pack_size"), f"{prefix}.pack_size", fields)

    source = entry.get("source")
    if source is not None:
        source = _clean_str(source, 120, f"{prefix}.source", fields)

    captured_at = entry.get("captured_at")
    if captured_at is not None:
        captured_at = _clean_str(captured_at, 64, f"{prefix}.captured_at", fields)

    out: Dict[str, Any] = {
        "amount": float(amount),
        "currency": currency,
        "pack_size": float(pack_size),
        "source": source,
        "captured_at": captured_at,
    }
    # Preserve a client-supplied stable id (PUT full-replacement contract §3.4).
    if entry.get("id") is not None:
        out["id"] = str(entry["id"])
    return out


def validate_image_body(value: Any, slot: str) -> Dict[str, Any]:
    """Validate an ``ImageSlot`` body supplied in a PUT body (§3.4/§1.1).

    The contract requires the slot to reference a file that was *already*
    uploaded via ``POST /inventory/{id}/images/{slot}`` (the URL is the proof
    of existence). We validate the shape, never trust a filesystem path, and
    keep the stored metadata intact.
    """
    fields: List[str] = []
    if not isinstance(value, dict):
        raise InventoryError("UNPROCESSABLE", 422,
                             f"images.{slot} must be an ImageSlot object or null",
                             fields=[f"images.{slot}"])

    url = value.get("url")
    if not (isinstance(url, str) and url.strip()):
        raise InventoryError("VALIDATION_ERROR", 400,
                             f"images.{slot}.url must be a non-empty URL string",
                             fields=[f"images.{slot}.url"])
    if url.startswith("/") is False and not url.startswith(
            ("http://", "https://")):
        # Contract C7: URL must be app-root-relative or absolute; a bare
        # filesystem path (no leading slash, no scheme) is a bug.
        raise InventoryError(
            "VALIDATION_ERROR", 400,
            f"images.{slot}.url must be an app-root-relative or absolute URL",
            fields=[f"images.{slot}.url"])

    filename = value.get("filename")
    mime = value.get("mime_type")
    byte_size = value.get("byte_size")
    out: Dict[str, Any] = {"url": url.strip()}
    if filename is not None:
        out["filename"] = _clean_str(filename, 255, f"images.{slot}.filename", fields)
    if mime is not None:
        if mime not in ALLOWED_IMAGE_TYPES:
            raise InventoryError(
                "UNSUPPORTED_MEDIA_TYPE", 415,
                f"images.{slot}.mime_type {mime!r} not in {list(ALLOWED_IMAGE_TYPES)}",
                fields=[f"images.{slot}.mime_type"])
        out["mime_type"] = mime
    if byte_size is not None:
        if isinstance(byte_size, bool) or not _is_number(byte_size) or byte_size <= 0:
            raise InventoryError("VALIDATION_ERROR", 400,
                                 f"images.{slot}.byte_size must be an integer > 0",
                                 fields=[f"images.{slot}.byte_size"])
        out["byte_size"] = int(byte_size)
    if value.get("uploaded_at") is not None:
        out["uploaded_at"] = _clean_str(
            value["uploaded_at"], 64, f"images.{slot}.uploaded_at", fields)
    if value.get("original_name") is not None:
        out["original_name"] = _clean_str(
            value["original_name"], 255, f"images.{slot}.original_name", fields)
    return out


def validate_slot_name(slot: str) -> str:
    if slot not in IMAGE_SLOTS:
        raise InventoryError(
            "VALIDATION_ERROR", 400,
            f"image slot must be one of {list(IMAGE_SLOTS)}", fields=["slot"])
    return slot
