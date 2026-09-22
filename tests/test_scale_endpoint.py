"""Integration tests for ``POST /api/v1/recipes/{recipe_id}/scale``.

Uses ``fastapi.testclient.TestClient`` (in-process ASGI — same request/response
contract as a real uvicorn server, no network required). Covers:
  * 200 — canonical 850 g / 480 g tables (design §5)
  * 400 — ``available_amount`` = 0, negative, non-numeric strings
  * 404 — recipe not found, ingredient not in the recipe
  * existing recipe endpoints still work (GET list / search / trending / detail /
    create / delete)
"""
import pytest

from fastapi.testclient import TestClient

from app.main import app, _store, RecipeResponse
from app.services.recipe_scaling import select_default_anchor  # noqa: F401

client = TestClient(app)


# ---------------------------------------------------------------------------
# Fixture: a fresh canonical recipe in the in-memory store
# ---------------------------------------------------------------------------

@pytest.fixture
def canonical_recipe_id():
    import uuid
    from app.main import NutrientInfo, Ingredient, Step, RecipeResponse
    rid = str(uuid.uuid4())
    _store[rid] = RecipeResponse(
        id=rid,
        title="Focirkeemlős csirkesor, babgombos",
        cuisine="Hungarian",
        rating=4.5,
        nutrition=NutrientInfo(calories=550, protein=42, carbs=38, fat=22),
        ingredients=[
            Ingredient(name="csirkeemlo", amount=650, unit="g"),
            Ingredient(name="voroshagyma", amount=200, unit="g"),
            Ingredient(name="kolbasz", amount=50, unit="g"),
            Ingredient(name="tejszin", amount=160, unit="g"),
            Ingredient(name="parmezan", amount=40, unit="g"),
            Ingredient(name="teszta", amount=240, unit="g"),
            Ingredient(name="spinot", amount=80, unit="g"),
            Ingredient(name="fokhagyma", amount=3, unit="gerezd"),
            Ingredient(name="paradicsompure", amount=3, unit="tbsp"),
            Ingredient(name="fustolt-paprika", amount=1, unit="tsp"),
            Ingredient(name="bors", amount=0.5, unit="tsp"),
            Ingredient(name="so", amount=2, unit="to taste"),
            Ingredient(name="csili", amount=1, unit="pcs"),
        ],
        steps=[Step(number=1, instruction="...")],
        status="published",
    )
    yield rid
    _store.pop(rid, None)


# ---------------------------------------------------------------------------
# 200 — canonical 850 g (design §5.1)
# ---------------------------------------------------------------------------

def _amounts(resp):
    return {i["name"]: i["amount"] for i in resp["ingredients"]}


def test_scale_200_upscale_850(canonical_recipe_id):
    r = client.post(f"/api/v1/recipes/{canonical_recipe_id}/scale",
                    json={"ingredient_id": "csirkeemlo", "available_amount": 850})
    assert r.status_code == 200, r.text
    body = r.json()
    by = {i["name"]: i for i in body["ingredients"]}
    assert body["anchor"]["name"] == "csirkeemlo"
    # Canonical §5.1 values
    assert by["csirkeemlo"]["amount"] == 850
    assert by["voroshagyma"]["amount"] == 261.54
    assert by["kolbasz"]["amount"] == 65.38
    assert by["tejszin"]["amount"] == 209.23
    assert by["parmezan"]["amount"] == 52.31
    assert by["teszta"]["amount"] == 313.85
    assert by["spinot"]["amount"] == 104.62
    assert by["fokhagyma"]["amount"] == 4
    assert by["paradicsompure"]["amount"] == 3.9
    assert by["fustolt-paprika"]["amount"] == 1.3
    assert by["bors"]["amount"] == 0.7
    # manual flags
    assert by["so"]["manual"] is True
    assert by["csili"]["manual"] is True
    assert by["so"]["amount"] == 2
    assert by["csili"]["amount"] == 1
    # factor is exposed
    assert abs(float(body["scale_factor_num"]) - (850/650)) < 1e-9
    assert body["recipe_id"] == canonical_recipe_id


def test_scale_200_downscale_480(canonical_recipe_id):
    r = client.post(f"/api/v1/recipes/{canonical_recipe_id}/scale",
                    json={"ingredient_id": 0, "available_amount": "480"})
    assert r.status_code == 200, r.text
    by = {i["name"]: i for i in r.json()["ingredients"]}
    # Canonical §5.2 values (incl. the two corrected cells)
    assert by["voroshagyma"]["amount"] == 147.69
    assert by["kolbasz"]["amount"] == 36.92       # was 65.38 in the errant run
    assert by["parmezan"]["amount"] == 29.54      # was 50.75 in the errant run
    assert by["fokhagyma"]["amount"] == 2
    assert by["bors"]["amount"] == 0.4
    assert by["so"]["manual"] is True


def test_scale_200_by_ingredient_index(canonical_recipe_id):
    # 0-based index (integer) is also accepted
    r = client.post(f"/api/v1/recipes/{canonical_recipe_id}/scale",
                    json={"ingredient_id": 0, "available_amount": 650})
    assert r.status_code == 200
    by = {i["name"]: i for i in r.json()["ingredients"]}
    assert by["csirkeemlo"]["amount"] == 650  # f=1, no-op


# ---------------------------------------------------------------------------
# 400 — bad available_amount
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", [0, -5, "abc", "six hundred", "", None])
def test_scale_400_bad_available(canonical_recipe_id, value):
    r = client.post(f"/api/v1/recipes/{canonical_recipe_id}/scale",
                    json={"ingredient_id": 0, "available_amount": value})
    assert r.status_code == 400, f"got {r.status_code}: {r.text}"
    assert "error" in r.json()["detail"]


def test_scale_400_anchor_non_scalable(canonical_recipe_id):
    # anchoring on "to taste" cannot define a scale factor -> 400
    r = client.post(f"/api/v1/recipes/{canonical_recipe_id}/scale",
                    json={"ingredient_id": "so", "available_amount": 2})
    assert r.status_code == 400, r.text
    assert "anchor" in r.json()["detail"]["error"].lower() or \
           "not scalable" in r.json()["detail"]["error"].lower()


# ---------------------------------------------------------------------------
# 404 — bad id
# ---------------------------------------------------------------------------

def test_scale_404_unknown_recipe():
    r = client.post("/api/v1/recipes/does-not-exist/scale",
                    json={"ingredient_id": 0, "available_amount": 100})
    assert r.status_code == 404
    assert r.json()["detail"]["error"] == "not found"


def test_scale_404_unknown_ingredient(canonical_recipe_id):
    r = client.post(f"/api/v1/recipes/{canonical_recipe_id}/scale",
                    json={"ingredient_id": "nonexistent-thing", "available_amount": 100})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Existing recipe endpoints still work
# ---------------------------------------------------------------------------

def test_recipe_list_trending_search_detail_canonical(canonical_recipe_id):
    # list (published only — canonical recipe is published)
    r = client.get("/api/v1/recipes")
    assert r.status_code == 200
    titles = [x["title"] for x in r.json()]
    assert "Focirkeemlős csirkesor, babgombos" in titles

    # trending
    r = client.get("/api/v1/recipes/trending")
    assert r.status_code == 200
    titles = [x["title"] for x in r.json()]
    assert "Focirkeemlős csirkesor, babgombos" in titles

    # search by name in ingredients
    r = client.get("/api/v1/recipes/search", params={"q": "parmezan"})
    assert r.status_code == 200
    assert r.json()["total_count"] >= 1

    # detail
    r = client.get(f"/api/v1/recipes/{canonical_recipe_id}")
    assert r.status_code == 200
    assert len(r.json()["ingredients"]) == 13

    # the store hasn't been mutated by the scale calls
    detail_ingredients = r.json()["ingredients"]
    anchor_ing = [i for i in detail_ingredients if i["name"] == "csirkeemlo"][0]
    assert anchor_ing["amount"] == 650


def test_create_and_delete_recipe_cycle():
    payload = {
        "title": "test recipe",
        "video_url": "https://example.com/v.mp4",
        "nutrition": {"calories": 100},
        "ingredients": [
            {"name": "a", "amount": 10, "unit": "g"},
            {"name": "b", "amount": 5, "unit": "ml"},
        ],
        "steps": [{"number": 1, "instruction": "mix"}],
        "status": "published",
    }
    r = client.post("/api/v1/recipes", json=payload)
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert client.get(f"/api/v1/recipes/{rid}").status_code == 200
    assert client.delete(f"/api/v1/recipes/{rid}").status_code == 204
    assert client.get(f"/api/v1/recipes/{rid}").status_code == 404
