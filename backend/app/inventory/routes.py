"""FastAPI router for the Solin inventory (contract §3, normative).

Thin adapter: every response body/status comes from :class:`InventoryService`
via the canonical ``/inventory`` prefix (the app is mounted at the root, so
paths are ``/inventory...`` exactly as QA curls them).

Error handling is centralized in :func:`_error_handler` — service-layer
:class:`InventoryError` maps 1:1 to the §6 table (status + ``{code, message,
details?, fields?}`` body). FastAPI's own 422s (Pydantic-level, e.g. a
multipart field missing entirely) are normalized to the same body shape with
code ``UNPROCESSABLE`` so the client never sees two dialects.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, File, Form, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ..config import settings
from .service import default_service as svc
from .validation import InventoryError

router = APIRouter(prefix="/api/v1/inventory", tags=["inventory"])

# Hard stream cap on uploads (FastAPI's UploadFile spools to disk past
# this anyway; we cap the *read* so a grossly oversized upload 413s at the
# service boundary — the service does the normative 413, this just bounds
# memory). §15.2: now settings-driven, max bytes + 1 MiB of slack, so the
# SOLIN_IMG_MAX_UPLOAD_BYTES gate can never be starved by the transport.


def register(app) -> None:
    """Attach the router + the two error handlers onto the FastAPI app.

    Exception handlers live on the *app* (not the router) so the C8 shape is
    guaranteed regardless of which handler raises them.
    """
    app.add_exception_handler(InventoryError, _inventory_error)
    app.add_exception_handler(RequestValidationError, _pydantic_error)
    app.include_router(router)


async def _inventory_error(request: Request, exc: InventoryError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.to_body())


async def _pydantic_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Normalize FastAPI 422s to the contract C8 error shape (§6 UNPROCESSABLE)."""
    return JSONResponse(
        status_code=422,
        content={
            "code": "UNPROCESSABLE",
            "message": "request type-shape mismatch",
            "details": exc.errors(),
        },
    )


@router.post("", status_code=201)
async def create_product(body: dict) -> dict:
    """POST /inventory — create a product (contract §3.1). 201 + stored doc."""
    return svc.create(body)


@router.post("/macros/count")
async def count_macros(body: dict) -> dict:
    """POST /inventory/macros/count — real-macro aggregation (contract §3.6, §4).

    Body: ``{"items": [ingredient_reference, ...], "portions": <int, default 1>}``
    where each item follows the §1.3 shape ``{product_id, quantity, unit,
    name_override?, note?}``. ``portions`` is the optional request-time view
    parameter from ``design/PORTIONS.md`` (default 1, integral, 1..999).

    Response: the canonical §4.4 ``MacroResult`` plus the two additive
    portion-view keys (PORTIONS.md §3)::

        {
          "totals":         {7 macro keys},
          "portions":       <effective int echo, default 1>,
          "per_portion":    {7 macro keys, each r2(totals[f]/portions)},
          "per_ingredient": [...],
          "total_cost":     {"amount", "currency"} | null,   # never divided
          "per_portion_cost": {"amount", "currency"} | null, # = r2(total_cost/portions)
          "warnings":       [{"code", "product_id"}]
        }

    Invalid ``portions`` (0, negative, fractional, non-numeric, or > 999) →
    400 ``PORTIONS_INVALID`` with ``fields=["portions"]``, raised before any
    aggregation (PORTIONS.md §5 E3–E7).

    Unresolved ingredients are *reported*, not raised: 200 + a row with an
    all-zero macro block and ``PRODUCT_NOT_FOUND`` in ``warnings``.  The
    pure engine is :func:`app.inventory.macros.aggregate_macro_result`;
    this route is the HTTP convenience named by contract §3.6.
    """
    from .validation import InventoryError as _IE
    from .validation import validate_portions

    items = body.get("items")
    if not isinstance(items, list):
        raise _IE("VALIDATION_ERROR", 400, "items must be a list",
                  fields=["items"])
    if not items:
        raise _IE("VALIDATION_ERROR", 400,
                  "items must contain at least one ingredient reference",
                  fields=["items"])
    # Portions is a request-only body field with default 1: omitting it /
    # null → 1 (E1/E2); invalid → 400 PORTIONS_INVALID (validated inside).
    portions = validate_portions(body.get("portions"))
    return svc.macro_count(items, portions=portions)


@router.get("")
async def list_products(limit: int = 50, offset: int = 0,
                        search: Optional[str] = None) -> dict:
    """GET /inventory — paginated list (contract §3.2)."""
    return svc.list(limit=limit, offset=offset, search=search or "")


@router.get("/{product_id}")
async def get_product(product_id: str) -> dict:
    """GET /inventory/{id} — full product incl. resolvable image URLs (C7)."""
    return svc.get(product_id)


@router.put("/{product_id}")
async def update_product(product_id: str, body: dict) -> dict:
    """PUT /inventory/{id} — independent partial fields (contract §3.4)."""
    return svc.update(product_id, body)


@router.delete("/{product_id}", status_code=204)
async def delete_product(product_id: str) -> Response:
    """DELETE /inventory/{id} — row + media removal (contract §3.5). 204."""
    svc.delete(product_id)
    return Response(status_code=204)


@router.post("/extract-label")
async def extract_label(
    request: Request,
) -> dict:
    """POST /inventory/extract-label — extract nutritional macros and ingredients.

    Accepts either multipart form file ('file') or JSON body ({"image_base64": "..."}).
    Returns {
        "macros": {calories, protein, fat, carbs, fiber, sugar, sodium},
        "ingredients": "...",
        "ingredients_list": [...],
        "raw_text": "..."
    }
    """
    import base64
    from .extractor import extract_from_image

    data: bytes = b""
    target: str = "all"

    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" in content_type:
        form = await request.form()
        target = str(form.get("target") or "all")
        upload = form.get("file")
        if upload and hasattr(upload, "read"):
            data = await upload.read()
    else:
        try:
            body = await request.json()
            target = str(body.get("target") or "all")
            b64_str = body.get("image_base64") or body.get("image") or ""
            if "," in b64_str:
                b64_str = b64_str.split(",", 1)[1]
            if b64_str:
                data = base64.b64decode(b64_str)
        except Exception:
            pass

    if not data:
        raise InventoryError("VALIDATION_ERROR", 400, "Image file or image_base64 is required", fields=["file"])

    if len(data) > settings.img_max_upload_bytes:
        raise InventoryError("PAYLOAD_TOO_LARGE", 413, "Image exceeds maximum allowed size", fields=["file"])

    return extract_from_image(data, target=target)


@router.post("/{product_id}/images/{slot}")
async def upload_image(product_id: str, slot: str,
                       file: UploadFile = File(...),
                       filename: Optional[str] = Form(None)) -> dict:
    """POST /inventory/{id}/images/{slot} — multipart upload (contract §3.7).

    * ``file``    — the image bytes (image/jpeg|png|webp, ≤10 MB)
    * ``filename``— optional original name (multipart filename is the default)
    Re-upload replaces the previous file (last-write-wins).
    """
    raw = await file.read(settings.img_max_upload_bytes + 1024 * 1024)
    original = filename or file.filename or None
    content_type = file.content_type or "application/octet-stream"
    slot_obj = svc.upload_image(
        product_id,
        slot,
        data=raw,
        content_type=content_type,
        original_name=original,
    )
    return slot_obj
