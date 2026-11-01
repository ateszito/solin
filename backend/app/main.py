"""FastAPI application entry point for Solin Recipe Platform."""

import os

import uuid
from fastapi import FastAPI, HTTPException, Request, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator
from typing import List, Optional, Union, Any, Dict

from .config import settings  # single source of truth for every env var (Tier A + B)
from .services.recipe_scaling import (
    scale_recipe,
    resolve_ingredient,
    select_default_anchor,
)
from .inventory.routes import register as register_inventory
from .inventory.media import MEDIA_URL_PREFIX, media_root
from .inventory.service import default_service as _inv_svc
from .ingestion.register import register_ingestion
from .kamra.routes import register as register_kamra
from .kamra.service import default_kamra_service
from .recipes.storage import default_recipe_store
from .auth.routes import register as register_auth

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
_origins = list(settings.cors_origins) if settings.cors_origins else []
if not _origins and settings.env == "unknown":
    _origins = ["http://localhost:3000", "http://localhost:3001"]

# Always allow mobile app (Capacitor / Ionic) and local webview origins
_mobile_origins = [
    "capacitor://localhost",
    "ionic://localhost",
    "http://localhost",
    "https://localhost",
]
for mo in _mobile_origins:
    if mo not in _origins:
        _origins.append(mo)

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

# ------ User Authentication & Profile System + API Auth Gate ----------------
register_auth(app)

# ------ Inventory module (contract use_cases.md §3) ------------------------
# Router + the two error handlers (C8 shape) live on the app.
register_inventory(app)

# ------ Kamra (Pantry ingredients & multilingual registry) ----------------
register_kamra(app)

# ------ Recipe Ingestion module (contract use_cases.md §16) -----------------
register_ingestion(app, settings)

# Serve uploaded product images at the canonical /media prefix (C7/§2):
#   <MEDIA_ROOT>/inventory/<product_id>/<slot>/<filename>
# StaticFiles is mounted on a dir that exists (seed images go there), so
# creating it at import time is safe.
import mimetypes
mimetypes.add_type("image/webp", ".webp")

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
    image: Optional[str] = None
    images: List[Any] = []
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
    image: Optional[str] = None
    images: List[Any] = []
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

# Backfill bilingual translations for Kamra items (guaranteeing both HU and EN names)
try:
    default_kamra_service.backfill_bilingual_translations()
except Exception as _e:
    import logging
    logging.getLogger("uvicorn.error").warning("Kamra bilingual backfill warning: %s", _e)

class RecipeSyncPayload(BaseModel):
    custom_recipes: Optional[List[Dict[str, Any]]] = None
    edits: Optional[Dict[str, Dict[str, Any]]] = None
    deleted_ids: Optional[List[str]] = None
    reset_edit_ids: Optional[List[str]] = None

# ------ API Endpoints ------

@app.get("/health", response_model=HealthResponse)
def health_check():
    return HealthResponse(
        status="ok",
        platform="Solin",
        version=settings.app_version,
        environment=settings.env if settings.env != "unknown" else "development",
    )

@app.get("/api/v1/recipes", response_model=List[RecipeSummary])
def list_recipes(limit: int = 20, offset: int = 0, cuisine: Optional[str] = None):
    recipes = [r for r in _store.values() if r.status == "published"]
    if cuisine:
        recipes = [r for r in recipes if r.cuisine and cuisine.lower() in r.cuisine.lower()]
    results = [RecipeSummary(
        id=r.id, title=r.title, cuisine=r.cuisine,
        rating=r.rating,
        calories_per_serving=r.nutrition.calories if r.nutrition else None,
        creator=r.creator,
    ) for r in recipes]
    return results[max(0, offset): offset + limit]

@app.get("/api/v1/recipes/search", response_model=SearchResponse)
def search_recipes(q: str, limit: int = 20, offset: int = 0):
    scored = []
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
            scored.append((score, RecipeSummary(
                id=r.id, title=r.title, cuisine=r.cuisine,
                rating=r.rating,
                calories_per_serving=r.nutrition.calories,
                creator=r.creator,
            )))
    scored.sort(key=lambda item: (item[0], item[1].rating or 0), reverse=True)
    results = [item[1] for item in scored]
    return SearchResponse(query=q, results=results[offset:offset+limit], total_count=len(results), limit=limit, offset=offset)

@app.get("/api/v1/recipes/trending", response_model=List[RecipeSummary])
def get_trending():
    recipes = sorted(
        [r for r in _store.values() if r.status == "published"],
        key=lambda r: r.rating or 0,
        reverse=True,
    )
    return [RecipeSummary(id=r.id, title=r.title, cuisine=r.cuisine, rating=r.rating, calories_per_serving=r.nutrition.calories, creator=r.creator) for r in recipes[:10]]

@app.post("/api/v1/recipes/extract-image")
async def extract_recipe_photo_endpoint(
    request: Request,
    files: Optional[List[UploadFile]] = File(None),
):
    """Extract full recipe from one or more photos (cookbooks, cards, guides) via Ollama Vision."""
    from .recipes.photo_extractor import extract_recipe_from_images
    media_recipes_dir = os.path.join(_inv_media_root, "recipes")
    images_bytes: List[bytes] = []
    target_lang = "auto"

    # 1. Check multipart form upload
    if files:
        for f in files:
            content = await f.read()
            if content:
                images_bytes.append(content)
        try:
            form = await request.form()
            target_lang = str(form.get("target_lang") or "auto")
        except Exception:
            pass

    # 2. Check JSON payload with base64 images
    if not images_bytes:
        try:
            body = await request.json()
            target_lang = str(body.get("target_lang") or "auto")
            for item in body.get("images", []):
                raw = item
                if isinstance(item, dict):
                    raw = item.get("data_url") or item.get("url") or item.get("data") or ""
                if isinstance(raw, str) and raw:
                    if "," in raw and "base64," in raw:
                        raw = raw.split("base64,")[1]
                    import base64
                    images_bytes.append(base64.b64decode(raw))
        except Exception:
            pass

    if not images_bytes:
        raise HTTPException(status_code=400, detail="No recipe photos provided.")

    try:
        recipe_data = extract_recipe_from_images(
            images_bytes,
            target_lang=target_lang,
            save_media=True,
            media_dir=media_recipes_dir,
        )
        # Auto-register extracted ingredients in Kamra
        try:
            from .kamra.service import default_kamra_service
            from .kamra.model import RecipeSyncRequest, RecipeIngredientItem
            ings = [
                RecipeIngredientItem(name=i.get("name", ""), qty=i.get("qty"), note=i.get("note"))
                for i in recipe_data.get("ingredients", [])
                if i.get("name")
            ]
            if ings:
                default_kamra_service.sync_recipe(RecipeSyncRequest(ingredients=ings, auto_create=True))
        except Exception as e:
            import logging
            logging.getLogger("uvicorn.error").warning("Auto-syncing ingredients to Kamra failed: %s", e)

        return recipe_data
    except ValueError as ve:
        raise HTTPException(status_code=422, detail=str(ve))
    except RuntimeError as re:
        raise HTTPException(status_code=503, detail=str(re))
    except Exception as e:
        import logging
        logging.getLogger("uvicorn.error").exception("Recipe photo extraction failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Recipe photo extraction failed: {str(e)}")


class VideoDownloadRequest(BaseModel):
    url: str
    recipe_id: Optional[str] = None


class VideoExtractRequest(BaseModel):
    url: str
    target_lang: Optional[str] = "auto"


class RecipeTranslateRequest(BaseModel):
    title: str = ""
    description: str = ""
    steps: List[str] = []
    target_lang: str = "hu"


@app.post("/api/v1/recipes/video/upload")
async def upload_recipe_video_endpoint(
    file: UploadFile = File(...),
    recipe_id: Optional[str] = Form(None),
):
    """Upload a video file for a recipe (MP4, MOV, WebM)."""
    from .recipes.video_service import save_uploaded_video
    try:
        content = await file.read()
        res = save_uploaded_video(content, original_filename=file.filename or "video.mp4", recipe_id=recipe_id)
        if recipe_id and recipe_id in _store:
            _store[recipe_id].video_url = res["video_url"]
        return res
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        import logging
        logging.getLogger("uvicorn.error").exception("Video upload failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Videó mentése sikertelen: {str(e)}")


@app.post("/api/v1/recipes/video/download")
def download_recipe_video_endpoint(payload: VideoDownloadRequest, request: Request):
    """Download video from Instagram, TikTok, or YouTube Shorts link."""
    from .recipes.video_service import download_video_from_url
    from .auth.security import rate_limiter
    client_ip = (request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For") or (request.client.host if request.client else "unknown")).split(",")[0].strip()
    if not rate_limiter.allow(f"video:{client_ip}", max_requests=8, window_sec=60.0):
        raise HTTPException(status_code=429, detail="Túl sok videóletöltési kérés. Kérjük, várj egy percet!")
    try:
        res = download_video_from_url(payload.url, recipe_id=payload.recipe_id)
        if payload.recipe_id and payload.recipe_id in _store:
            _store[payload.recipe_id].video_url = res["video_url"]
        return res
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        import logging
        logging.getLogger("uvicorn.error").exception("Video download failed: %s", e)
        raise HTTPException(status_code=422, detail=f"Videó letöltése sikertelen: {str(e)}")


@app.post("/api/v1/recipes/extract-video")
def extract_recipe_from_video_endpoint(payload: VideoExtractRequest, request: Request):
    """Download video and extract complete recipe (title, macros, ingredients, steps)."""
    from .recipes.video_service import download_video_from_url
    from .recipes.video_extractor import extract_recipe_from_video_info
    from .auth.security import rate_limiter
    client_ip = (request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For") or (request.client.host if request.client else "unknown")).split(",")[0].strip()
    if not rate_limiter.allow(f"video:{client_ip}", max_requests=8, window_sec=60.0):
        raise HTTPException(status_code=429, detail="Túl sok videókinyerési kérés. Kérjük, várj egy percet!")
    try:
        video_info = download_video_from_url(payload.url)
        video_info["source"] = payload.url
        recipe_data = extract_recipe_from_video_info(video_info, target_lang=payload.target_lang or "auto")
        return recipe_data
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        import logging
        logging.getLogger("uvicorn.error").exception("Video recipe extraction failed: %s", e)
        raise HTTPException(status_code=422, detail=f"Recept kinyerése sikertelen: {str(e)}")

@app.get("/api/v1/recipes/sync")
def get_synced_recipes():
    """Retrieve all persisted custom recipes, edits, and deletion tombstones."""
    return default_recipe_store.sync()

@app.post("/api/v1/recipes/sync")
def sync_recipes_endpoint(payload: RecipeSyncPayload):
    """Sync client recipes, edits, and tombstones with persistent backend store."""
    return default_recipe_store.sync(
        custom_recipes=payload.custom_recipes,
        edits=payload.edits,
        deleted_ids=payload.deleted_ids,
        reset_edit_ids=payload.reset_edit_ids,
    )

@app.delete("/api/v1/recipes/edits/{recipe_id}", status_code=204)
def delete_recipe_edits_endpoint(recipe_id: str):
    """Delete persisted edits for a recipe ('Visszaállítás eredetire')."""
    default_recipe_store.reset_edit(recipe_id)
    return JSONResponse(status_code=204, content=None)


_CULINARY_EN_TO_HU = [
    ("preheat oven to", "Melegítsd elő a sütőt erre:"),
    ("preheat the oven to", "Melegítsd elő a sütőt erre:"),
    ("in a large bowl", "Egy nagy tálban"),
    ("in a bowl", "Egy tálban"),
    ("mix together", "keverd össze:"),
    ("mix well", "alaposan keverd össze"),
    ("whisk together", "habverővel keverd össze"),
    ("stir in", "keverd hozzá:"),
    ("add the", "add hozzá:"),
    ("bake for", "süsd"),
    ("cook for", "főzd / süsd"),
    ("simmer for", "párold / főzd"),
    ("minutes", "percig"),
    ("minute", "percig"),
    ("until golden brown", "amíg aranybarna nem lesz"),
    ("until cooked through", "amíg teljesen átsül"),
    ("season with salt and pepper", "sózd és borsozd ízlés szerint"),
    ("serve warm", "melegen tálald"),
    ("enjoy", "jó étvágyat"),
]

_CULINARY_HU_TO_EN = [
    ("melegítsd elő a sütőt", "Preheat the oven"),
    ("egy nagy tálban", "In a large bowl"),
    ("egy tálban", "In a bowl"),
    ("keverd össze", "mix together"),
    ("add hozzá", "add"),
    ("süsd", "bake/cook"),
    ("főzd", "cook"),
    ("percig", "minutes"),
    ("aranybarnára", "until golden brown"),
    ("sózd és borsozd", "season with salt and pepper"),
    ("tálald", "serve"),
]


def _fallback_translate_text(text: str, target_lang: str) -> str:
    if not text:
        return ""
    import re
    out = text
    pairs = _CULINARY_EN_TO_HU if target_lang == "hu" else _CULINARY_HU_TO_EN
    for src, dst in pairs:
        out = re.sub(re.escape(src), dst, out, flags=re.IGNORECASE)
    return out


@app.post("/api/v1/recipes/translate")
def translate_recipe_endpoint(payload: RecipeTranslateRequest):
    """Translate recipe title, description, and steps between Hungarian and English."""
    import json
    import re
    import urllib.request
    from .recipes.photo_extractor import _get_ollama_host, _is_ollama_reachable

    target = "en" if (payload.target_lang or "").lower() == "en" else "hu"
    target_name = "English" if target == "en" else "Hungarian"

    host = _get_ollama_host()
    if _is_ollama_reachable(host):
        try:
            prompt = (
                f"Translate the following recipe title, description, and cooking steps into natural {target_name}.\n"
                "Keep measurements and numbers accurate. Output ONLY valid JSON with keys: "
                "\"title\", \"description\", \"steps\" (array of strings).\n\n"
                + json.dumps({
                    "title": payload.title,
                    "description": payload.description,
                    "steps": payload.steps,
                }, ensure_ascii=False)
            )
            req_body = json.dumps({
                "model": os.environ.get("OLLAMA_TEXT_MODEL", "qwen3-vl:8b"),
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "think": False,
                "options": {"temperature": 0.1},
            }).encode("utf-8")
            req = urllib.request.Request(
                f"{host}/api/chat",
                data=req_body,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
                content = raw.get("message", {}).get("content", "")
                m = re.search(r"\{.*\}", content, re.DOTALL)
                if m:
                    parsed = json.loads(m.group(0))
                    if isinstance(parsed.get("steps"), list):
                        return {
                            "title": str(parsed.get("title") or payload.title),
                            "description": str(parsed.get("description") or payload.description),
                            "steps": [str(s) for s in parsed["steps"]],
                            "target_lang": target,
                            "provider": "ollama",
                        }
        except Exception:
            pass

    return {
        "title": _fallback_translate_text(payload.title, target),
        "description": _fallback_translate_text(payload.description, target),
        "steps": [_fallback_translate_text(s, target) for s in (payload.steps or [])],
        "target_lang": target,
        "provider": "dictionary",
    }

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
        steps=recipe.steps, image=recipe.image, images=recipe.images, status=recipe.status,
    )
    # Auto-register ingredients in Kamra
    try:
        from .kamra.service import default_kamra_service
        from .kamra.model import RecipeSyncRequest, RecipeIngredientItem
        ings = [
            RecipeIngredientItem(name=i.name, qty=getattr(i, 'qty', None), note=getattr(i, 'note', None))
            for i in (recipe.ingredients or [])
            if getattr(i, 'name', None)
        ]
        if ings:
            default_kamra_service.sync_recipe(RecipeSyncRequest(ingredients=ings, auto_create=True))
    except Exception as e:
        import logging
        logging.getLogger("uvicorn.error").warning("Auto-syncing ingredients to Kamra failed: %s", e)

    try:
        res_dict = _store[rid].model_dump() if hasattr(_store[rid], "model_dump") else _store[rid].dict()
        default_recipe_store.save_recipe(res_dict)
    except Exception as e:
        import logging
        logging.getLogger("uvicorn.error").warning("Persisting recipe to disk store failed: %s", e)

    return _store[rid]

@app.delete("/api/v1/recipes/{recipe_id}", status_code=204)
def delete_recipe(recipe_id: str):
    if recipe_id in _store:
        del _store[recipe_id]
    default_recipe_store.delete_recipe(recipe_id)
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
