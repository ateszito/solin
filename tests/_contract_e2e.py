"""E2E: exercise the exact HTTP contract the browser sends (scale.js scaleViaApi).

Verifies the fix: the frontend now sends `ingredient_id` (not `ingredient_name`),
which matches the backend's ScaleRequest model.
"""
import sys, json, os
os.environ.setdefault("SOLIN_ENV", "unknown")
sys.path.insert(0, "backend")
import app.main as m
from fastapi.testclient import TestClient

c = TestClient(m.app)

# Same recipe as _smoke.py
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
assert r.status_code == 201, f"seed failed: {r.status_code} {r.text[:300]}"
rid = r.json()["id"]
print(f"seed: 201 → id={rid}")

print("\n=== CONTRACT PATHS (what scale.js actually sends) ===")

# 1. name anchor + name in body (the fix: ingredient_id=name string)
r1 = c.post(f"/api/v1/recipes/{rid}/scale",
            json={"ingredient_id": "chicken breast", "available_amount": 850})
print(f"  name anchor 'chicken breast' 850: {r1.status_code}")
if r1.status_code == 200:
    d = r1.json()
    print(f"    factor: {d['scale_factor']} (num: {d['scale_factor_num']})")
    for x in d["ingredients"][:5]:
        print(f"    {x['name']}  base={x['base_amount']} → {x['amount']} {x['unit']}  manual={x.get('manual')}")

# 2. 0-based index (the other form resolve_ingredient accepts)
r2 = c.post(f"/api/v1/recipes/{rid}/scale",
            json={"ingredient_id": 2, "available_amount": 480})
print(f"  index anchor 2 @ 480: {r2.status_code}  factor={r2.json().get('scale_factor') if r2.status_code==200 else r2.json()}")

# 3. regression: old (buggy) field should now be 422, not 200
r3 = c.post(f"/api/v1/recipes/{rid}/scale",
            json={"ingredient_name": "chicken breast", "available_amount": 850})
print(f"  OLD field 'ingredient_name' (regression check): {r3.status_code} (expect 422)")

# 4. numeric anchor (string '2')
r4 = c.post(f"/api/v1/recipes/{rid}/scale",
            json={"ingredient_id": "2", "available_amount": 1000})
print(f"  string index '2' @ 1000: {r4.status_code}  factor={r4.json().get('scale_factor') if r4.status_code==200 else r4.json()}")

print("\n=== VERDICT ===")
ok = (r1.status_code == 200
      and r2.status_code == 200
      and r3.status_code == 422
      and r4.status_code == 200)
print("  ALL CONTRACT PATHS WORK" if ok else "  SOME PATHS BROKEN — see above")
sys.exit(0 if ok else 1)
