"""Acceptance and unit tests for recipe ingestion API (§16, t_20f1e116)."""
import json
import os
import tempfile
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.ingestion.register import register_ingestion
from app.ingestion.pipeline import cluster_rules, seed_cluster
from app.ingestion.store import IngestStore
from app.inventory.routes import register as register_inventory


@pytest.fixture()
def ingest_app(tmp_path):
    settings = Settings.from_env()
    cfg = Settings(
        **{
            **settings.__dict__,
            "ingest_enabled": True,
            "data_dir": str(tmp_path),
            "ingest_data_root": str(tmp_path / "media"),
            "worker_poll_s": 0.1,
        }
    )
    app = FastAPI()
    register_inventory(app)
    register_ingestion(app, cfg)
    return app


def test_ingestion_disabled_by_default():
    app = FastAPI()
    settings = Settings.from_env()
    store = register_ingestion(app, settings)
    assert store is None


def test_ingest_transcript_flow(ingest_app):
    c = TestClient(ingest_app)
    r = c.post(
        "/api/v1/ingest",
        json={"source_type": "transcript", "source_id": "200 g liszt\n2 dl tej\n3 db tojas"},
    )
    assert r.status_code == 202
    data = r.json()
    assert data["status"] == "PENDING"
    rid = data["ingest_id"]

    import time
    for _ in range(50):
        st = c.get(f"/api/v1/ingest/{rid}").json()
        if st.get("state") in ("DRAFT_READY", "ERROR"):
            break
        time.sleep(0.1)

    assert st.get("state") == "DRAFT_READY"
    assert st.get("status") == "OK"

    tr = c.get(f"/api/v1/ingest/{rid}/transcript")
    assert tr.status_code == 200
    assert "liszt" in tr.json()["transcript"]

    d = c.get(f"/api/v1/ingest/{rid}/draft")
    assert d.status_code == 200
    assert len(d.json()["ingredients"]) == 3


def test_ingest_url_disabled_default(ingest_app):
    c = TestClient(ingest_app)
    r = c.post(
        "/api/v1/ingest",
        json={"source_type": "url", "source_id": "https://www.tiktok.com/@chef/video/12345"},
    )
    assert r.status_code == 403
    assert r.json()["code"] == "FEATURE_DISABLED"


def test_ingest_unknown_kind(ingest_app):
    c = TestClient(ingest_app)
    r = c.post("/api/v1/ingest", json={"source_type": "invalid_kind", "source_id": "abc"})
    assert r.status_code == 400
    assert r.json()["code"] == "VALIDATION_ERROR"


def test_ingest_platform_kind_aliases(ingest_app):
    c = TestClient(ingest_app)
    # tiktok alias normalized to url -> 403 FEATURE_DISABLED when url_fetch is false
    r = c.post(
        "/api/v1/ingest",
        json={"source_type": "tiktok", "source_id": "https://www.tiktok.com/@chef/video/12345"},
    )
    assert r.status_code == 403
    assert r.json()["code"] == "FEATURE_DISABLED"
