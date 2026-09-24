"""Media path/URL helpers for inventory images (contract §2 / C7).

Single source of truth for:
* where image FILES live on disk  → ``<MEDIA_ROOT>/inventory/<id>/<slot>/``
* what their public URL is        → ``/media/inventory/<id>/<slot>/<filename>``

The URL prefix ``/media`` is canonical (already used by the seed docs in
``seed_data.py``); :mod:`app.main` mounts a StaticFiles handler there.
"""

from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timezone

from ..config import settings

#: Canonical app-root-relative prefix for all media URLs (C7).
MEDIA_URL_PREFIX = "/media"


def media_root() -> str:
    """Absolute-ish on-disk media root (operator override via
    ``SOLIN_MEDIA_ROOT``; default ``media/`` next to the launch cwd)."""
    return (settings.media_root or "media").rstrip("/")


def slot_dir(product_id: str, slot: str) -> str:
    """Directory for one slot's files (contract §2)."""
    return os.path.join(media_root(), "inventory", product_id, slot)


def slot_url(product_id: str, slot: str, filename: str) -> str:
    """Public URL for a stored file (C7: app-root-relative, never a fs path)."""
    return f"{MEDIA_URL_PREFIX}/inventory/{product_id}/{slot}/{filename}"


def now_stamp() -> str:
    """ISO-8601 UTC ``YYYY-MM-DDTHH:MM:SSZ`` (C5)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_stamp_filename() -> str:
    """Filename timestamp prefix ``YYYYMMDDTHHMMSSZ`` (contract §2)."""
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def slugify(original_name: str) -> str:
    """Deterministic slug for the stored leaf name: ``YYYYMMDDTHHMMSSZ__<slug>``.

    Slug = alphanumeric + dashes of the original file stem (lowercased);
    falls back to a short sha1 hex when nothing usable survives.
    """
    stem = os.path.splitext(os.path.basename(str(original_name or "")))[0]
    slug = re.sub(r"[^a-z0-9-]+", "-", stem.lower()).strip("-")
    if len(slug) > 40:
        slug = slug[:40].rstrip("-")
    if not slug:
        digest = hashlib.sha1(str(original_name or "file").encode("utf-8")).hexdigest()
        slug = digest[:10]
    return f"{now_stamp_filename()}__{slug}"


#: mime → stored-file extension (the three §3.7 allowed types).
EXT_BY_MIME = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}
