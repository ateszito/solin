import os, sys, json
os.environ.setdefault("SOLIN_ENV", "unknown")  # allow boot without full env
sys.path.insert(0, "backend")

# 1) Does the app import as a package (PEP 420 namespace)?
import app.main as m
print("import OK: app.main")
print("  routes:", [r.path for r in m.app.routes if r.path.startswith("/api/v1/recipes")])

# 2) TestClient smoke: create a recipe, then scale it (850g).
from fastapi.testclient import TestClient
c = TestClient(m.app)

recipe = {
    "title": "Javítom magam", "video_url": "x", "creator": "c",
    "servings": 5, "difficulty": "easy",
    "nutrition": {"calories": 850},
    "status": "published",
    "ingredients": [
        {"name": "red onion", "amount": 200, "unit": "g"},
        {"name": "sausage", "amount": 50, "unit": "g"},
        {"name": "chicken breast", "amount": 650, "unit": "g"},
        {"name": "salt", "amount": 1, "unit": "pinch"},
        {"name": "chili", "amount": 1, "unit": "dash"},
        {"name": "smoked paprika", "amount": 1, "unit": "tsp"},
        {"name": "black pepper", "amount": 1, "unit": "pinch"},
        {"name": "garlic", "amount": 3, "unit": "cloves"},
        {"name": "tomato paste", "amount": 3, "unit": "tbsp"},
        {"name": "cream", "amount": 160, "unit": "g"},
        {"name": "pasta", "amount": 240, "unit": "g"},
        {"name": "spinach", "amount": 80, "unit": "g"},
        {"name": "parmesan", "amount": 40, "unit": "g"},
    ],
    "steps": [{"number": 1, "instruction": "cook"}],
}
r = c.post("/api/v1/recipes", json=recipe)
print("create:", r.status_code)
rid = r.json()["id"]

# anchor = chicken breast (index 2). available 850.
for avail in (850, 480):
    rr = c.post(f"/api/v1/recipes/{rid}/scale", json={"ingredient_id": 2, "available_amount": avail})
    print(f"scale avail={avail}: HTTP {rr.status_code}")
    body = rr.json()
    print("  factor:", body["scale_factor"])
    for ing in body["ingredients"]:
        flag = "manual" if ing["manual"] else "      "
        print(f"  {ing['name']:<18} {ing['amount']:>8} {ing['unit']:<6} {flag}")

# edge cases
print("\n--- edge cases ---")
for payload, label in [
    ({"ingredient_id": 999, "available_amount": 850}, "ingredient not in recipe (expect 404)"),
    ({"ingredient_id": 2, "available_amount": 0}, "zero (expect 400)"),
    ({"ingredient_id": 2, "available_amount": -10}, "negative (expect 400)"),
    ({"ingredient_id": 2, "available_amount": "abc"}, "non-numeric (expect 400)"),
    ({"ingredient_id": 3, "available_amount": 850}, "anchor on pinch (expect 400)"),
]:
    ee = c.post(f"/api/v1/recipes/{rid}/scale", json=payload)
    print(f"  {label}: HTTP {ee.status_code}  body={ee.json()}")
missing = c.post(f"/api/v1/recipes/does-not-exist/scale", json={"ingredient_id": 0, "available_amount": 1})
print(f"  recipe not found (expect 404): HTTP {missing.status_code} body={missing.json()}")
