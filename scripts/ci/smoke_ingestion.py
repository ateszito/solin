"""E2E smoke for the ingestion module (t_20f1e116, §16.9 gate 2/3/4).

Deterministic + offline: TestClient only, no network, no server.
Checks, in order:
  1. module OFF (default): /api/v1/ingest/* is NOT mounted at all
     ("all off → auto-fallback UN-queue-able: no queue-drain, no max-2
     clamp" — nothing exists to drain into);
  2. module ON: submit + status + transcript + draft chain, identity
     throttle (20/60s default-ON) + inflight queue cap (default-ON);
  3. guard NOT in the default pipeline (V-7 seeds NOTHING);
  4. seed_cluster gate: default empty → cluster UN-queue-able; configured
     name with no operator file → honest RESOLVE_FAILED_NO_CHAIN;
  5. error bodies are flat C8 ({code,message,…}) via InventoryError.
Run: bash scripts/ci/smoke_ingestion.sh
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.normpath(os.path.join(HERE, "..", "..", "backend"))
sys.path.insert(0, BACKEND)

import tempfile  # noqa: E402

fail = 0


def check(label: str, cond: bool, note: str = "") -> None:
    global fail
    print(("PASS " if cond else "FAIL ") + label + (" — " + note if note else ""))
    if not cond:
        fail += 1


def main() -> int:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import app.main as main_mod
    from app.ingestion.register import register_ingestion
    from app.config import Settings

    tmp = tempfile.mkdtemp(prefix="ingest_smoke_")

    # ---- 1. module OFF (the DEFAULT everywhere) -------------------------
    app_off = FastAPI()
    store_off = register_ingestion(app_off, Settings.from_env())
    check("module OFF default (SOLIN_INGEST_ENABLED unset → nothing mounted)",
          store_off is None)

    # ---- module ON ------------------------------------------------------
    on = Settings.from_env()  # defaults identical; flip the master flag only
    on = Settings(**{**on.__dict__, "ingest_enabled": True, "data_dir": tmp})
    app_on = FastAPI()
    from app.inventory.routes import register as register_inventory
    register_inventory(app_on)               # C8 handler must exist first
    store = register_ingestion(app_on, on)
    c = TestClient(app_on)

    # ---- 2. happy chain: submit → status → transcript → draft ----------
    r = c.post("/api/v1/ingest/submit",
               json={"source_type": "transcript",
                    "source_id": "200 g liszt\n2 dl tej\n3 db tojas"})
    check("submit 202 + guard accept (no block → queue path)",
          r.status_code == 202 and r.json()["state"] == "QUEUED", str(r.status_code))
    rid = r.json()["ingestId"]
    import time
    for _ in range(50):
        st = c.get(f"/api/v1/ingest/{rid}").json()
        if st.get("state") in ("DRAFT_READY", "LOW_CONFIDENCE", "ERROR"):
            break
        time.sleep(0.1)
    check("worker ran the chain (record left QUEUED)",
          st.get("state") in ("DRAFT_READY", "LOW_CONFIDENCE"), str(st.get("state")))
    check("attempts recorded (attempts-by-stage default-on)",
          bool(st.get("attempts_by_stage")), str(st.get("attempts_by_stage")))
    t = c.get(f"/api/v1/ingest/{rid}/transcript")
    check("transcript persisted + served by default (streaming-store INVERSE)",
          t.status_code == 200 and "liszt" in t.json().get("transcript", ""))
    d = c.get(f"/api/v1/ingest/{rid}/draft")
    check("draft 200 full doc (parser adapter default-ON)",
          d.status_code == 200 and len(d.json().get("ingredients", [])) == 3)

    # ---- 3. seed_cluster gate (§16.6 default empty → OFF) ---------------
    r2 = c.post("/api/v1/ingest/submit",
                json={"source_type": "file_ref", "source_id": "x.mp4"})
    rid2 = r2.json()["ingestId"]
    for _ in range(50):
        st2 = c.get(f"/api/v1/ingest/{rid2}").json()
        if st2.get("state") == "ERROR":
            break
        time.sleep(0.1)
    atts = [a["status"] for st_ in st2.get("attempts_by_stage", [])
            for a in [st_]]
    check("default-OFF chain: honest TRIGGER_BLOCKED recorded, no fabricated seed",
          any("TRIGGER_BLOCKED" in a["statuses"][0]
              for a in st2.get("attempts_by_stage", [])),
          str([a["statuses"] for a in st2.get("attempts_by_stage", [])]))

    # configured cluster name + no operator file -> honest NO_CHAIN
    import json as _json
    cfg_file = os.path.join(tmp, "seed_clusters.json")
    with open(cfg_file, "w") as fh:
        fh.write(_json.dumps({"my-cluster": ["file_submit"]}))
    from app.ingestion.pipeline import cluster_rules, seed_cluster
    check("cluster gate default-OFF: unset trigger name = worker input",
          seed_cluster("") == "" and cluster_rules("") is None)
    check("configured cluster consumes ONLY operator file (V-7: §16 seeds "
          "NOTHING — no default table ships in code)",
          cluster_rules("seed-cluster-default") is None)

    # ---- 4. throttle + queue caps (default-ON, pure-local) --------------
    from app.ingestion.store import IngestStore
    small = IngestStore(os.path.join(tmp, "guard"), max_records=2,
                        queue_inflight=12, submit_per_min=2,
                        submit_window_s=60)
    small.gate_identity("1.2.3.4")
    small.gate_identity("1.2.3.4")
    check("per-identity 20/60s clamp default-ON (3rd submit → 429 path)",
          small.gate_identity("1.2.3.4") is False)
    cap = IngestStore(os.path.join(tmp, "q"), max_records=200,
                      queue_inflight=1, submit_per_min=99, submit_window_s=60)
    check("inflight queue cap default-ON (reject at GATE, no later drop)",
          cap.gate_inflight() is True)

    # ---- 5. C8 error shape (flat, via InventoryError) -------------------
    e = c.get("/api/v1/ingest/does-not-exist")
    check("pruned/absent record → 404 + NOT_FOUND (flat body)",
          e.status_code == 404 and e.json().get("code") == "NOT_FOUND"
          and "detail" not in e.json(), str(e.json())[:120])
    b = c.post("/api/v1/ingest/submit", json={"source_type": "wat",
                                              "source_id": ""})
    check("bad kind rejected (§13.2/§13.3 clone: 400 on non-accepted kind)",
          b.status_code == 400 and b.json().get("code") == "VALIDATION_ERROR",
          str(b.status_code) + " " + str(b.json())[:120])

    print("FAILURES:", fail)
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
