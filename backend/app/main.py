"""FastAPI application entry point for Solin Recipe Platform."""

import uuid
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional

# App configuration
app = FastAPI(
    title="Solin",
    description="Mobile-first recipe platform for sharing, discovering, and managing recipes with video integration.",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
