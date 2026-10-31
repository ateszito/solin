import pytest
from app.kamra.translator import translate_ingredient, norm
from app.recipes.storage import RecipeStore


def test_bilingual_translation_common_ingredients():
    hu, en, cat = translate_ingredient("baking powder")
    assert "sütőpor" in hu
    assert en == "Baking powder"
    assert cat == "pantry"

    hu, en, cat = translate_ingredient("coconut flour")
    assert "kókuszliszt" in hu
    assert en == "Coconut flour"
    assert cat == "grain"

    hu, en, cat = translate_ingredient("egg whites")
    assert "tojásfehérje" in hu
    assert en == "Egg whites"
    assert cat == "dairy"

    hu, en, cat = translate_ingredient("csirkemell")
    assert hu == "csirkemell"
    assert "Chicken breast" in en
    assert cat == "meat"


def test_recipe_store_crud_and_sync(tmp_path):
    store_file = tmp_path / "recipes.json"
    store = RecipeStore(path=str(store_file))

    r1 = {
        "id": "u-test1",
        "title": "Finom Tészta",
        "ingredients": [{"name": "tészta", "qty": "200 g"}, {"name": "baking powder", "qty": "1 tk"}],
        "steps": [{"t": 5, "text": "Forrald fel a vizet"}]
    }
    store.save_recipe(r1)

    loaded = store.get_recipe("u-test1")
    assert loaded is not None
    assert loaded["title"] == "Finom Tészta"

    # Test sync
    r2 = {
        "id": "u-test2",
        "title": "Avokádós Toast",
        "ingredients": [{"name": "avokádó", "qty": "1 db"}],
        "steps": []
    }
    synced = store.sync(custom_recipes=[r2], edits={"u-test1": {"servings": 4}})
    assert len(synced["custom_recipes"]) == 2
    assert synced["edits"]["u-test1"]["servings"] == 4

    # Delete
    assert store.delete_recipe("u-test1") is True
    assert store.get_recipe("u-test1") is None
