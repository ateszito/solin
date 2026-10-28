"""One error dialect (§16/§16.8): reuse InventoryError's HTTP shape.

Subclassing InventoryError means the exception handler already registered
by register_inventory (routes.py: add_exception_handler(InventoryError,
_inventory_error)) formats ingestion errors identically — flat C8 body,
never the {"detail": ...} default. That satisfies "keep the two existing
exception shapes and make the new domain speak the same one dialect"
without duplicating handler code.
"""

from __future__ import annotations

from ..inventory.validation import InventoryError


class IngestionError(InventoryError):
    """Ingestion-domain error; wire shape identical to InventoryError."""

    def __init__(self, status: int, code: str, message: str, **details) -> None:
        # InventoryError(code, status_code, message, **details) — same order,
        # so the registered handler formats us byte-identically.
        super().__init__(code, status, message, **details)


# Suffix neutralisation (§16.4, A3): characters outside
# [A-Za-z0-9_.-] are stripped, max 64 chars kept, never a session id.
import re as _re

_UNSAFE = _re.compile(r"[^A-Za-z0-9_.-]+")


def neutralise(raw: str) -> str:
    return _UNSAFE.sub("", raw or "")[:64]


__all__ = ["IngestionError", "neutralise"]
