"""Unit tests for Kamra (Pantry) store and service."""
import os
import tempfile
import pytest

from backend.app.kamra.model import KamraItemCreate, KamraItemUpdate, RecipeSyncRequest, RecipeIngredientItem
from backend.app.kamra.store import KamraStore
from backend.app.kamra.service import KamraService, norm, slugify


@pytest.fixture
def temp_kamra_store():
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "kamra.json")
        store = KamraStore(path=path)
        yield store


def test_seed_initialization(temp_kamra_store):
    items = temp_kamra_store.list_all()
    assert len(items) >= 20
    # csirkemell should exist
    csirke = temp_kamra_store.get("csirkemell")
    assert csirke is not None
    assert csirke["name"] == "csirkemell"
    assert csirke["name_en"] == "Chicken breast"
    assert "p1" in csirke["product_ids"]
    assert "pulykamell" in csirke["subs"]


def test_norm_and_slugify():
    assert norm("Csirke-mell (filézett)!") == "csirke mell filezett"
    assert norm("Vöröshagyma") == "voroshagyma"
    assert slugify("Vöröshagyma apróra") == "voroshagyma_aprora"


def test_find_match_exact_and_synonym(temp_kamra_store):
    svc = KamraService(store=temp_kamra_store)
    # Match by exact Hungarian
    m1 = svc.find_match("vöröshagyma")
    assert m1 is not None
    assert m1["id"] == "voroshagyma"

    # Match by synonym
    m2 = svc.find_match("csirkeemlő")
    assert m2 is not None
    assert m2["id"] == "csirkemell"

    # Match by English name
    m3 = svc.find_match("Chicken breast")
    assert m3 is not None
    assert m3["id"] == "csirkemell"


def test_create_and_update_item(temp_kamra_store):
    svc = KamraService(store=temp_kamra_store)
    new_item = svc.create_item(
        KamraItemCreate(
            name="avokádó",
            name_en="Avocado",
            category="produce",
            synonyms=["avocado", "hass avokádó"],
            subs=["guacamole"],
            product_ids=[],
        )
    )
    assert new_item["id"] == "avokado"
    assert new_item["name_en"] == "Avocado"

    # Update item
    updated = svc.update_item("avokado", KamraItemUpdate(product_ids=["p99"]))
    assert "p99" in updated["product_ids"]


def test_sync_recipe_flow(temp_kamra_store):
    svc = KamraService(store=temp_kamra_store)
    req = RecipeSyncRequest(
        ingredients=[
            RecipeIngredientItem(name="csirkeemlő", qty="650 g"),
            RecipeIngredientItem(name="új egzotikus fűszer", qty="1 tk"),
        ],
        auto_create=True,
    )
    res = svc.sync_recipe(req)
    assert len(res.synced) == 2
    # csirkeemlő matched existing
    assert res.synced[0].kamra_id == "csirkemell"
    assert res.synced[0].is_new is False

    # new spice was auto-registered
    assert res.synced[1].is_new is True
    assert res.created_count == 1
    # Check it can be retrieved now
    new_id = res.synced[1].kamra_id
    assert temp_kamra_store.get(new_id) is not None
