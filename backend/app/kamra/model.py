"""Pydantic schemas for the Kamra ingredient registry."""
from __future__ import annotations

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field


class KamraItem(BaseModel):
    id: str = Field(..., description="Unique slug or identifier, e.g. 'csirkemell'")
    name: str = Field(..., description="Hungarian primary name")
    name_en: str = Field(..., description="English name")
    category: str = Field(default="other", description="Category: meat, dairy, produce, spice, grain, pantry, oil, other")
    synonyms: List[str] = Field(default_factory=list, description="Common aliases and recipe spelling variants")
    subs: List[str] = Field(default_factory=list, description="Names of acceptable substitute ingredients")
    product_ids: List[str] = Field(default_factory=list, description="Linked inventory store product IDs (e.g. ['p1'])")
    default_unit: Optional[str] = Field(default="g", description="Default measurement unit")
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class KamraItemCreate(BaseModel):
    name: str = Field(..., min_length=1, description="Hungarian name (or recognized ingredient name)")
    name_en: Optional[str] = Field(default=None, description="English translation")
    category: Optional[str] = Field(default="other")
    synonyms: Optional[List[str]] = Field(default_factory=list)
    subs: Optional[List[str]] = Field(default_factory=list)
    product_ids: Optional[List[str]] = Field(default_factory=list)
    default_unit: Optional[str] = Field(default="g")


class KamraItemUpdate(BaseModel):
    name: Optional[str] = None
    name_en: Optional[str] = None
    category: Optional[str] = None
    synonyms: Optional[List[str]] = None
    subs: Optional[List[str]] = None
    product_ids: Optional[List[str]] = None
    default_unit: Optional[str] = None


class RecipeIngredientItem(BaseModel):
    name: str
    qty: Optional[str] = None
    note: Optional[str] = None


class RecipeSyncRequest(BaseModel):
    ingredients: List[RecipeIngredientItem] = Field(..., description="List of ingredients in the recipe to sync")
    auto_create: bool = Field(default=True, description="Whether to auto-register missing ingredients in Kamra")


class RecipeSyncResultItem(BaseModel):
    original_name: str
    kamra_id: str
    name: str
    name_en: str
    category: str
    subs: List[str]
    product_ids: List[str]
    is_new: bool = False


class RecipeSyncResponse(BaseModel):
    synced: List[RecipeSyncResultItem]
    created_count: int
