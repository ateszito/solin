"""Endpoint tests for /api/v1/kamra."""
import pytest
from fastapi.testclient import TestClient

from backend.app.main import app

client = TestClient(app)


def test_list_kamra_endpoint():
    resp = client.get("/api/v1/kamra")
    assert resp.status_code == 200
    items = resp.json()
    assert isinstance(items, list)
    assert len(items) >= 20
    names = [i["name"] for i in items]
    assert "csirkemell" in names
    assert "vöröshagyma" in names


def test_search_kamra_endpoint():
    resp = client.get("/api/v1/kamra?search=chicken")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) >= 1
    assert items[0]["id"] == "csirkemell"


def test_create_and_get_kamra_item():
    payload = {
        "name": "Bazsalikom levél",
        "name_en": "Basil leaf",
        "category": "spice",
        "synonyms": ["friss bazsalikom"],
        "subs": ["oregánó"],
        "product_ids": [],
    }
    create_resp = client.post("/api/v1/kamra", json=payload)
    assert create_resp.status_code == 201
    item = create_resp.json()
    item_id = item["id"]

    get_resp = client.get(f"/api/v1/kamra/{item_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["name_en"] == "Basil leaf"


def test_sync_recipe_endpoint():
    import uuid
    unique_new_name = f"egyedi teszt alapanyag {uuid.uuid4().hex[:6]}"
    sync_payload = {
        "ingredients": [
            {"name": "csirkeemlő", "qty": "650 g"},
            {"name": "parmezán", "qty": "40 g"},
            {"name": unique_new_name, "qty": "100 g"},
        ],
        "auto_create": True,
    }
    resp = client.post("/api/v1/kamra/sync-recipe", json=sync_payload)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["synced"]) == 3
    assert data["synced"][0]["kamra_id"] == "csirkemell"
    assert data["synced"][1]["kamra_id"] == "parmezan"
    assert data["synced"][2]["is_new"] is True
