"""Real HTTP acceptance check against a running uvicorn server (in a thread).

Boots ``app.main:app`` on 127.0.0.1:PORT, then talks to it with urllib
(genuine sockets over HTTP, not TestClient). Verifies:
  * 200 + canonical design §5 values (850 g and 480 g) over the wire
  * 400 / 404 status codes
  * the two corrected cells from the errant run (36.92 g, 29.54 g)
Then shuts the server down in the same run (no lingering process).
"""
import socket
import threading
import time
import urllib.request
import urllib.error

import uvicorn

from app.main import app, _store
from app.main import RecipeResponse, NutrientInfo, Ingredient, Step


def _free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _req(method, url, body=None):
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        import json
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def main():
    port = _free_port()
    # Seed a canonical published recipe into the live store.
    _store["acc-001"] = RecipeResponse(
        id="acc-001", title="Focirkeemlős csirkesor", cuisine="Hungarian",
        rating=4.5,
        nutrition=NutrientInfo(calories=550),
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

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on")
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()

    base = f"http://127.0.0.1:{port}"
    # Wait for readiness (max ~10s)
    ready = False
    for _ in range(100):
        try:
            code, _ = _req("GET", base + "/healthz")
            if code == 200:
                ready = True
                break
        except Exception:
            pass
        time.sleep(0.1)
    if not ready:
        raise SystemExit("server did not become ready")

    failures = 0
    def check(label, got, want):
        nonlocal failures
        ok = got == want
        if not ok:
            failures += 1
        print(f"  [{'OK' if ok else 'FAIL'}] {label}: {got}" + ("" if ok else f"  want {want}"))

    print("== curl-style HTTP acceptance against:", base)
    print("-- 200 upscale 850 g --")
    code, body = _req("POST", base + "/api/v1/recipes/acc-001/scale",
                      {"ingredient_id": "csirkeemlo", "available_amount": 850})
    import json as _j
    j = _j.loads(body)
    by = {i["name"]: i for i in j["ingredients"]}
    check("status", code, 200)
    check("csirkeemlo", by["csirkeemlo"]["amount"], 850)
    check("voroshagyma", by["voroshagyma"]["amount"], 261.54)
    check("kolbasz", by["kolbasz"]["amount"], 65.38)
    check("tejszin", by["tejszin"]["amount"], 209.23)
    check("parmezan", by["parmezan"]["amount"], 52.31)
    check("teszta", by["teszta"]["amount"], 313.85)
    check("spinot", by["spinot"]["amount"], 104.62)
    check("fokhagyma", by["fokhagyma"]["amount"], 4)
    check("paradicsompure", by["paradicsompure"]["amount"], 3.9)
    check("fustolt-paprika", by["fustolt-paprika"]["amount"], 1.3)
    check("bors", by["bors"]["amount"], 0.7)
    check("so manual", by["so"]["manual"], True)
    check("csili manual", by["csili"]["manual"], True)

    print("-- 200 downscale 480 g --")
    code, body = _req("POST", base + "/api/v1/recipes/acc-001/scale",
                      {"ingredient_id": "csirkeemlo", "available_amount": 480})
    j = _j.loads(body)
    by = {i["name"]: i for i in j["ingredients"]}
    check("status", code, 200)
    check("kolbasz (corrected cell)", by["kolbasz"]["amount"], 36.92)
    check("parmezan (corrected cell)", by["parmezan"]["amount"], 29.54)
    check("fokhagyma", by["fokhagyma"]["amount"], 2)
    check("bors", by["bors"]["amount"], 0.4)

    print("-- 400 bad available_amount --")
    code, _ = _req("POST", base + "/api/v1/recipes/acc-001/scale",
                   {"ingredient_id": "csirkeemlo", "available_amount": 0})
    check("zero -> 400", code, 400)
    code, _ = _req("POST", base + "/api/v1/recipes/acc-001/scale",
                   {"ingredient_id": "csirkeemlo", "available_amount": "abc"})
    check("non-numeric -> 400", code, 400)

    print("-- 404 --")
    code, _ = _req("POST", base + "/api/v1/recipes/missing/scale",
                   {"ingredient_id": "x", "available_amount": 100})
    check("unknown recipe -> 404", code, 404)
    code, _ = _req("POST", base + "/api/v1/recipes/acc-001/scale",
                   {"ingredient_id": "missing-thing", "available_amount": 100})
    check("unknown ingredient -> 404", code, 404)

    # shutdown the server cleanly in the same run
    server.should_exit = True
    t.join(timeout=5)
    print()
    if failures == 0:
        print("CURL ACCEPTANCE: ALL CHECKS PASSED")
    else:
        print(f"CURL ACCEPTANCE: {failures} CHECK(S) FAILED")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
