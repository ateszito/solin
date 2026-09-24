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

from .service import default_service as svc
from .validation import InventoryError

router = APIRouter(prefix="/inventory", tags=["inventory"])

# 10 MB hard stream cap on uploads (FastAPI's UploadFile spools to disk past
# this anyway; we cap the *read* so a 50 MB upload 413s at the service
# boundary — the service does the normative 413, this just bounds memory).
MAX_UPLOAD_READ = 11 * 1024 * 1024


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


@router.post("/{product_id}/images/{slot}")
async def upload_image(product_id: str, slot: str,
                       file: UploadFile = File(...),
                       filename: Optional[str] = Form(None)) -> dict:
    """POST /inventory/{id}/images/{slot} — multipart upload (contract §3.7).

    * ``file``    — the image bytes (image/jpeg|png|webp, ≤10 MB)
    * ``filename``— optional original name (multipart filename is the default)
    Re-upload replaces the previous file (last-write-wins).
    """
    raw = await file.read(MAX_UPLOAD_READ)
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
