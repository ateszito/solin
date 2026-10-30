"""FastAPI router for Kamra (Pantry) ingredients."""
from __future__ import annotations

from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query, Response, status

from .model import KamraItem, KamraItemCreate, KamraItemUpdate, RecipeSyncRequest, RecipeSyncResponse
from .service import default_kamra_service as svc

router = APIRouter(prefix="/api/v1/kamra", tags=["kamra"])


def register(app) -> None:
    app.include_router(router)


@router.get("", response_model=List[KamraItem])
def list_kamra_items(
    search: Optional[str] = Query(default=None, description="Search by name, English name, or synonyms"),
    category: Optional[str] = Query(default=None, description="Filter by category"),
):
    """List all pantry ingredients with optional search and category filters."""
    items = svc.list_items(query=search, category=category)
    return items


@router.post("", response_model=KamraItem, status_code=status.HTTP_201_CREATED)
def create_kamra_item(payload: KamraItemCreate):
    """Register a new ingredient in Kamra with auto-categorization and translation fallback."""
    item = svc.create_item(payload)
    return item


@router.post("/sync-recipe", response_model=RecipeSyncResponse)
def sync_recipe_ingredients(payload: RecipeSyncRequest):
    """Sync ingredients from a recipe into Kamra. Links existing items or auto-creates new ones."""
    res = svc.sync_recipe(payload)
    return res


@router.get("/{item_id}", response_model=KamraItem)
def get_kamra_item(item_id: str):
    """Get single pantry ingredient by ID."""
    item = svc.get_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"Kamra item {item_id!r} not found")
    return item


@router.put("/{item_id}", response_model=KamraItem)
def update_kamra_item(item_id: str, payload: KamraItemUpdate):
    """Update a pantry ingredient (e.g. adjust English name, synonyms, substitutes, or product links)."""
    updated = svc.update_item(item_id, payload)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Kamra item {item_id!r} not found")
    return updated


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_kamra_item(item_id: str):
    """Delete a pantry ingredient from Kamra."""
    ok = svc.delete_item(item_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Kamra item {item_id!r} not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
