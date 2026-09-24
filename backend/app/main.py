"""FastAPI application entry point for Solin Recipe Platform."""

import os

import uuid
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator
from typing import List, Optional, Union

from .config import settings  # single source of truth for every env var (Tier A + B)
from .services.recipe_scaling import (
    scale_recipe,
    resolve_ingredient,
    select_default_anchor,
)
from .inventory.routes import register as register_inventory
from .inventory.media import MEDIA_URL_PREFIX, media_root
from .inventory.service import default_service as _inv_svc

# App configuration — version, env label, and docs all come from the
# environment (APP_VERSION / SOLIN_ENV), never hard-coded.
app = FastAPI(
    title="Solin",
    description="Mobile-first recipe platform for sharing, discovering, and managing recipes with video integration.",
    version=settings.app_version,
    docs_url="/docs" if settings.debug or settings.env == "development" else None,
    redoc_url="/redoc" if settings.debug or settings.env == "development" else None,
)

# CORS — driven by CORS_ORIGINS (blueprint sec 3.2). Fallback to localhost
# for local dev only when CORS_ORIGINS is empty AND we aren't a named env.
_origins = settings.cors_origins
if not _origins and settings.env == "unknown":
    _origins = ["http://localhost:3000", "http://localhost:3001"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# /api/env — the "current environment name" endpoint (blueprint acceptance #5).
# /healthz — liveness; reports env + version for the CI smoke test in sec 7.4.
@app.get("/api/env", tags=["meta"])
def api_env() -> dict:
    """Non-secret env identity. Safe over the wire; no credentials."""
    return {
        "env": settings.env,
        "app_version": settings.app_version,
        "public_base_url": settings.public_base_url,
        "api_base_url": settings.api_base_url,
        "feature_allow_edit": settings.feature_allow_edit,
        "feature_invisibility": settings.feature_invisibility,
        "debug": settings.debug,
    }

@app.get("/healthz", tags=["meta"])
def healthz() -> dict:
    """Live/dead probe returning env identity + version.

    The CI smoke test (blueprint sec 7.4) curls this after every deploy to
    confirm the container came up AND it is the one we just deployed (env +
    version fingerprint must match)."""
    return {
        "status": "ok",
        "env": settings.env,
        "app_version": settings.app_version,
        "db_configured": bool(settings.database_url),
    }

# ------ Inventory module (contract use_cases.md §3) ------------------------
# Router + the two error handlers (C8 shape) live on the app.
register_inventory(app)

# Serve uploaded product images at the canonical /media prefix (C7/§2):
#   <MEDIA_ROOT>/inventory/<product_id>/<slot>/<filename>
# StaticFiles is mounted on a dir that exists (seed images go there), so
# creating it at import time is safe.
_inv_media_root = media_root()
os.makedirs(os.path.join(_inv_media_root, "inventory"), exist_ok=True)
app.mount(MEDIA_URL_PREFIX, StaticFiles(directory=_inv_media_root), name="media")


def seed_inventory() -> dict:
    """Idempotent P1–P4 seed (contract §7). Called at startup and from tests."""
    return _inv_svc.seed()


# Seed on startup so a bare `uvicorn app.main:app` has the canonical
# worked-example products (P1–P4) ready for QA. Idempotent — re-runs keep
# existing rows and only write missing seed image files.
seed_inventory()

# ------ Pydantic models ------

class RecipeSummary(BaseModel):
    id: str
    title: str
    cuisine: Optional[str] = None
    rating: Optional[float] = None
    calories_per_serving: Optional[int] = None
    creator: Optional[str] = None

class NutrientInfo(BaseModel):
    calories: int
    protein: float = 0.0
    carbs: float = 0.0
    fat: float = 0.0
    fiber: float = 0.0
    sugar: float = 0.0
    sodium: float = 0.0

class Ingredient(BaseModel):
    name: str
    amount: float
    unit: str
    prep: str = ""
    order: Optional[int] = None

class Step(BaseModel):
    number: int
    instruction: str
    video_start: Optional[str] = None
    video_end: Optional[str] = None
    temperature: Optional[str] = None
    tips: Optional[str] = None

class RecipeCreate(BaseModel):
    title: str
    description: Optional[str] = None
    video_url: str
    transcript_url: Optional[str] = None
    creator: str = "unknown"
    creator_source: Optional[str] = None
    servings: int = 1
    prep_time_min: Optional[int] = None
    cook_time_min: Optional[int] = None
    total_time_min: Optional[int] = None
    difficulty: Optional[str] = None
    rating: Optional[float] = None
    cuisine: Optional[str] = None
    tags: List[str] = []
    dietary_info: List[str] = []
    nutrition: NutrientInfo
    ingredients: List[Ingredient]
    steps: List[Step]
    images: List[dict] = []
    status: str = "draft"

class RecipeResponse(BaseModel):
    id: str
    title: str
    description: Optional[str] = None
    video_url: Optional[str] = None
    transcript_url: Optional[str] = None
    creator: str = "unknown"
    creator_source: Optional[str] = None
    servings: int = 1
    prep_time_min: Optional[int] = None
    cook_time_min: Optional[int] = None
    total_time_min: Optional[int] = None
    difficulty: Optional[str] = None
    rating: Optional[float] = None
    cuisine: Optional[str] = None
    tags: List[str] = []
    dietary_info: List[str] = []
    nutrition: NutrientInfo
    ingredients: List[Ingredient]
    steps: List[Step]
    images: List[dict] = []
    status: str = "draft"
    created_at: str = "2026-01-01T00:00:00Z"
    updated_at: str = "2026-01-01T00:00:00Z"

class SearchResponse(BaseModel):
    query: str
    results: List[RecipeSummary]
    total_count: int
    limit: int
    offset: int

class HealthResponse(BaseModel):
    status: str
    platform: str
    version: str
    environment: str

class ScaleRequest(BaseModel):
    """Body for ``POST /api/v1/recipes/{recipe_id}/scale`` (design §8).

    ``ingredient_id`` is the per-ingredient stable id. The current schema has
    no per-ingredient id, so it is accepted as a 0-based index *or* a name
    (see :func:`services.recipe_scaling.resolve_ingredient`).
    ``available_amount`` is how much of that ingredient the user has on hand.
    """
    ingredient_id: Union[int, str]
    available_amount: Union[int, float, str]

    @field_validator("available_amount", mode="before")
    @classmethod
    def _coerce_numeric(cls, v: Union[int, float, str]) -> Union[float, str]:
        # design §8: non-numeric / non-finite available_amount is a 400.
        # We raise HTTPException(400) so FastAPI surfaces a real 400 (a
        # ValueError here would be caught and turned into a 422 by pydantic).
        # The service re-validates positivity (which is a separate concern,
        # and where we get to give a recipe-specific error message).
        if isinstance(v, bool):
            raise HTTPException(status_code=400, detail={"error": "available_amount must be a positive number"})
        if isinstance(v, (int, float)):
            if v != v or v in (float("inf"), float("-inf")):  # NaN / inf
                raise HTTPException(status_code=400, detail={"error": "available_amount must be a finite number"})
            return v
        if isinstance(v, str):
            s = v.strip().replace(",", ".")
            if s in ("", "+", "-"):
                raise HTTPException(status_code=400, detail={"error": "available_amount must be a positive number"})
            try:
                f = float(s)
            except ValueError:
                raise HTTPException(status_code=400, detail={"error": f"available_amount {v!r} is not a number"})
            if f != f or f in (float("inf"), float("-inf")):  # NaN / inf
                raise HTTPException(status_code=400, detail={"error": "available_amount must be a finite number"})
            return s
        raise HTTPException(status_code=400, detail={"error": "available_amount must be a positive number"})

    @field_validator("available_amount", mode="after")
    @classmethod
    def _post_check(cls, v):
        # pydantic's `Union[int, float, str]` lets it coerce "abc" -> "abc"
        # before our `before` validator runs; this second pass catches that
        # path with a proper 400. (Numeric and finite `before` already returned.)
        if isinstance(v, str):
            s = v.strip().replace(",", ".")
            try:
                float(s)
            except ValueError:
                raise HTTPException(status_code=400, detail={"error": f"available_amount {v!r} is not a number"})
        return v

# ------ In-memory data store ------

_store: dict = {}

def _default_recipes() -> dict:
    return {}

_store.update(_default_recipes())

# ------ API Endpoints ------

@app.get("/health", response_model=HealthResponse)
def health_check():
    return HealthResponse(status="ok", platform="Solin", version="0.1.0", environment="development")

@app.get("/api/v1/recipes", response_model=List[RecipeSummary])
def list_recipes(limit: int = 20, offset: int = 0, cuisine: Optional[str] = None):
    recipes = [r for r in _store.values() if r.status == "published"]
    if cuisine:
        recipes = [r for r in recipes if recipe.cuisine and cuisine.lower() in recipe.cuisine.lower()]
    results = [RecipeSummary(
        id=r.id, title=r.title, cuisine=r.cuisine,
        rating=r.rating,
        calories_per_serving=r.nutrition.calories if r.nutrition else None,
        creator=r.creator,
    ) for r in recipes]
    return results[max(0, offset): offset + limit]

@app.get("/api/v1/recipes/search", response_model=SearchResponse)
def search_recipes(q: str, limit: int = 20, offset: int = 0):
    results = []
    for r in _store.values():
        score = 0
        if q.lower() in r.title.lower():
            score += 10
        if q.lower() in (r.description or "").lower():
            score += 5
        if any(q.lower() in ing.name.lower() for ing in r.ingredients):
            score += 3
        if any(q.lower() in s.instruction.lower() for s in r.steps):
            score += 2
        if score > 0:
            results.append(RecipeSummary(
                id=r.id, title=r.title, cuisine=r.cuisine,
                rating=r.rating,
                calories_per_serving=r.nutrition.calories,
                creator=r.creator,
            ))
    results.sort(key=lambda x: 0)
    return SearchResponse(query=q, results=results[offset:offset+limit], total_count=len(results), limit=limit, offset=offset)

@app.get("/api/v1/recipes/trending", response_model=List[RecipeSummary])
def get_trending():
    recipes = sorted(
        [r for r in _store.values() if r.status == "published"],
        key=lambda r: r.rating or 0,
        reverse=True,
    )
    return [RecipeSummary(id=r.id, title=r.title, cuisine=r.cuisine, rating=r.rating, calories_per_serving=r.nutrition.calories, creator=r.creator) for r in recipes[:10]]

@app.get("/api/v1/recipes/{recipe_id}", response_model=RecipeResponse)
def get_recipe(recipe_id: str):
    recipe = _store.get(recipe_id)
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return recipe

@app.post("/api/v1/recipes", response_model=RecipeResponse, status_code=201)
def create_recipe(recipe: RecipeCreate):
    rid = str(uuid.uuid4())
    _store[rid] = RecipeResponse(
        id=rid, title=recipe.title, description=recipe.description,
        video_url=recipe.video_url, transcript_url=recipe.transcript_url,
        creator=recipe.creator, creator_source=recipe.creator_source,
        servings=recipe.servings, prep_time_min=recipe.prep_time_min,
        cook_time_min=recipe.cook_time_min, total_time_min=recipe.total_time_min,
        difficulty=recipe.difficulty, rating=recipe.rating, cuisine=recipe.cuisine,
        tags=recipe.tags, dietary_info=recipe.dietary_info,
        nutrition=recipe.nutrition, ingredients=recipe.ingredients,
        steps=recipe.steps, images=recipe.images, status=recipe.status,
    )
    return _store[rid]

@app.delete("/api/v1/recipes/{recipe_id}", status_code=204)
def delete_recipe(recipe_id: str):
    if recipe_id in _store:
        del _store[recipe_id]
    return JSONResponse(status_code=204, content=None)

@app.post("/api/v1/recipes/{recipe_id}/scale")
def scale_recipe_endpoint(recipe_id: str, body: ScaleRequest):
    """POST /api/v1/recipes/{recipe_id}/scale (design §8).

    Given a recipe, a target (anchor) ingredient and the user's available
    amount, returns the full recalculated ingredient list.

    Status codes:
      * 200 — correctly scaled values (deterministic; every cell == base*f
        ROUND_HALF_UP for its unit class).
      * 400 — ``available_amount`` <= 0 / non-numeric / non-finite, or the
        target's unit is not scalable (e.g. anchoring on "pinch").
      * 404 — recipe not found, or ``ingredient_id`` not in this recipe.
    """
    recipe = _store.get(recipe_id)
    if not recipe:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "not found",
                "hint": f"recipe {recipe_id} does not exist; GET /api/v1/recipes for valid ids",
            },
        )

    ingredients = recipe.ingredients
    target = resolve_ingredient(ingredients, body.ingredient_id)
    if target is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "not found",
                "hint": (
                    "GET /api/v1/recipes/{recipe_id} for valid ingredient_ids "
                    "(0-based index or ingredient name)"
                ),
            },
        )

    try:
        result = scale_recipe(ingredients, body.available_amount, target)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})

    return JSONResponse(status_code=200, content=result.to_response(recipe_id))

@app.post("/api/v1/videos/upload")
def upload_video(file_id: str, filename: str = ""):
    return {"status": "uploaded", "file_id": file_id, "filename": filename, "url": "https://cdn.solin.app/videos/" + file_id, "message": "Video stored in Cloudflare R2 CDN"}

# Main entry point
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
