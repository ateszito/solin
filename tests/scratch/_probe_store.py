import os, sys
os.environ.setdefault("SOLIN_ENV", "unknown")
sys.path.insert(0, "backend")
import app.main as m
from fastapi.testclient import TestClient
c = TestClient(m.app)
r = c.get("/api/v1/recipes?limit=50")
results = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
print("GET /api/v1/recipes ->", r.status_code, "count:", len(results))
for x in results[:5]:
    print("  id:", x.get("id"), "title:", x.get("title"))
# Try scaling r1 (seed id) to see if it's pre-seeded in the store
for rid in ("r1", "r2"):
    e = c.post(f"/api/v1/recipes/{rid}/scale", json={"ingredient_id": "csirkeemlő", "available_amount": 850})
    print(f"scale {rid}: HTTP {e.status_code}")
