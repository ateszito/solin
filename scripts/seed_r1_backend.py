"""Seed r1 (the frontend seed recipe) into a fresh backend and serve it on :8087.

Purpose (SCALE-BRIDGE-001 proof ONLY): give the single-origin browser harness a
backend that knows recipe id "r1" (csirkeemlő = 650 g) so the Scale panel's
API-first call resolves to a real 200 on the same origin — proving bridge fix
#1 (no more 501) end-to-end. This process is disposable; it is NOT a deploy.
"""
import os
import sys

# Ensure the repo root is on sys.path so `backend.app.main` resolves.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import uvicorn
from backend.app.main import app as fastapi_app
from backend.app.main import _store
from backend.app.main import RecipeResponse, NutrientInfo, Ingredient, Step
from backend.app.config import settings  # noqa: F401  (boots config at import)

_store["r1"] = RecipeResponse(
    id="r1",
    title="QA r1 (seed shape)",
    description=None,
    video_url="http://x/v.mp4",
    transcript_url=None,
    creator="qa",
    creator_source=None,
    servings=5,
    prep_time_min=None,
    cook_time_min=None,
    total_time_min=None,
    difficulty=None,
    rating=None,
    cuisine=None,
    tags=[],
    dietary_info=[],
    nutrition=NutrientInfo(calories=850, protein=0.0, carbs=0.0, fat=0.0, fiber=0.0, sugar=0.0, sodium=0.0),
    ingredients=[
        Ingredient(name="vöröshagyma", amount=200.0, unit="g"),
        Ingredient(name="kolbász", amount=50.0, unit="g"),
        Ingredient(name="csirkeemlő", amount=650.0, unit="g"),
        Ingredient(name="só", amount=1.0, unit="jódag"),
        Ingredient(name="csili", amount=1.0, unit="db"),
        Ingredient(name="füstölt paprika", amount=1.0, unit="tk"),
        Ingredient(name="bors", amount=0.5, unit="tk"),
        Ingredient(name="fokhagyma", amount=1.5, unit="gerezd"),
        Ingredient(name="paradicsompüré", amount=3.0, unit="evőkanál"),
        Ingredient(name="tejszín", amount=160.0, unit="g"),
        Ingredient(name="tészta", amount=240.0, unit="g"),
    ],
    steps=[Step(number=1, instruction="x")],
    images=[],
    status="published",
    created_at="2026-01-01T00:00:00Z",
    updated_at="2026-01-01T00:00:00Z",
)
print("[seed_r1] r1 seeded into _store  (csirkeemlő 650g)")
uvicorn.run(fastapi_app, host="127.0.0.1", port=8087, log_level="warning")
