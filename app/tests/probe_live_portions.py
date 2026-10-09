"""One-off dev probe: exercise the LIVE solin-dev portions endpoint and confirm
the exact wire shape my UI code consumes (echo + per_portion + invariant).
Run:  python3 app/tests/probe_live_portions.py
Not part of the test suite — hits the network and prints a human-readable diff.
"""
import json
import sys
import urllib.error
import urllib.request

import decimal

BASE = "https://solin-dev.ateszito.com/api/v1/inventory"


def _req(url, body=None, method="GET"):
    headers = {"Content-Type": "application/json",
               "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) ProbeSolin/1.0"}
    data = json.dumps(body).encode() if body is not None else None
    return urllib.request.Request(url, data=data, headers=headers, method=method)


def post(path, body):
    try:
        with urllib.request.urlopen(_req(BASE + path, body, "POST"), timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def get(path):
    with urllib.request.urlopen(_req(BASE + path), timeout=30) as r:
        return json.loads(r.read().decode())


def r2(x):
    return float(decimal.Decimal(str(x)).quantize(
        decimal.Decimal("0.01"), rounding=decimal.ROUND_HALF_UP))


def main():
    items = get("?limit=5").get("items") or []
    if not items:
        print("no products on dev → nothing to probe"); return 2
    p0 = items[0]
    unit = p0.get("base_unit") or "g"
    pid = p0["id"]
    print(f"probing with product={pid} base_unit={unit} qty=200 {unit}")

    ok = True

    s1, b1 = post("/macros/count",
                  {"items": [{"product_id": pid, "quantity": 200, "unit": unit}],
                   "portions": 4})
    print(f"\n--- portions=4 ---")
    print(f"  http={s1}")
    print(f"  echo portions = {b1.get('portions')}")
    print(f"  totals        = {b1.get('totals')}")
    print(f"  per_portion   = {b1.get('per_portion')}")
    print(f"  per_portion key order = {list((b1.get('per_portion') or {}).keys())}")
    print(f"  total_cost    = {b1.get('total_cost')}")
    t = b1.get("totals") or {}
    mine = {k: r2(v / 4) for k, v in t.items()}
    print(f"  invariant local r2HALFUP(totals/4) = {mine}")
    print(f"  MATCH server vs local = {mine == b1.get('per_portion')}")
    ok &= (s1 == 200) and (b1.get("portions") == 4) and (mine == b1.get("per_portion"))

    s2, b2 = post("/macros/count",
                  {"items": [{"product_id": pid, "quantity": 200, "unit": unit}]})
    print(f"\n--- no portions (backward-compat) ---")
    print(f"  http={s2} echo portions={b2.get('portions')}")
    same = b2.get("per_portion") == b2.get("totals")
    print(f"  per_portion == totals ? {same}")
    ok &= (s2 == 200) and (b2.get("portions") == 1) and same

    for label, val in [("portions=0", 0), ("portions=-3", -3),
                       ("portions=2.5", 2.5), ("portions=1000", 1000),
                       ("portions='abc'", "abc")]:
        s, b = post("/macros/count",
                    {"items": [{"product_id": pid, "quantity": 200, "unit": unit}],
                     "portions": val})
        print(f"  {label}: http={s} body={b}")
        ok &= (s == 400) and (b.get("code") == "PORTIONS_INVALID") \
              and (b.get("fields") == ["portions"])

    print(f"\nSUMMARY: {'ALL OK' if ok else 'SOME ASSERTIONS FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
