"""Unit and integration tests for recipe photo extraction endpoint and service."""

from unittest.mock import patch, MagicMock
import io
import json
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.recipes.photo_extractor import extract_recipe_from_images, prepare_image

client = TestClient(app)


def create_dummy_image_bytes(color=(255, 0, 0), size=(200, 200)) -> bytes:
    img = Image.new("RGB", size, color=color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def test_prepare_image():
    raw_bytes = create_dummy_image_bytes(size=(1400, 800))
    b64, data_url = prepare_image(raw_bytes, max_dim=1000)
    assert b64 is not None
    assert data_url.startswith("data:image/jpeg;base64,")


def test_extract_recipe_from_images_mocked():
    sample_response_json = {
        "title": "Creamy Garlic Chicken & Mashed Potatoes",
        "description": "High-protein meal prep with cottage cheese mash.",
        "servings": 4,
        "servings_note": "per serving - 4 total",
        "total_time_min": 35,
        "prep_time_min": 15,
        "cook_time_min": 20,
        "difficulty": "easy",
        "cuisine": "american",
        "tags": ["highprotein", "chicken", "mealprep"],
        "dietary_info": ["high-protein"],
        "nutrition": {
            "calories": 549,
            "protein": 74.0,
            "carbs": 46.0,
            "fat": 9.5,
            "fiber": 2.0,
            "sugar": 3.0,
            "sodium": 650.0,
        },
        "ingredients": [
            {"name": "Potatoes", "qty": "1.4kg", "amount": 1.4, "unit": "kg", "note": "peeled & diced"},
            {"name": "Chicken Breast", "qty": "800g", "amount": 800, "unit": "g", "note": "raw weight"},
        ],
        "steps": [
            {"number": 1, "instruction": "Peel and boil potatoes for 20 minutes."},
            {"number": 2, "instruction": "Season chicken breast and cook in pan."},
        ],
    }

    raw_bytes = create_dummy_image_bytes()

    mock_resp_lines = [
        json.dumps({"message": {"content": json.dumps(sample_response_json)}, "done": True}).encode("utf-8")
    ]

    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp_lines

    with patch("app.recipes.photo_extractor.get_ollama_host", return_value="http://mock-ollama:11434"):
        with patch("urllib.request.urlopen", return_value=mock_resp):
            res = extract_recipe_from_images([raw_bytes], target_lang="auto", save_media=False)
            assert res["title"] == "Creamy Garlic Chicken & Mashed Potatoes"
            assert res["servings"] == 4
            assert res["nutrition"]["calories"] == 549
            assert res["macrosPerServing"]["protein"] == 74.0
            assert len(res["ingredients"]) == 2
            assert len(res["steps"]) == 2
            assert res["steps"][0]["text"] == "Peel and boil potatoes for 20 minutes."
            assert len(res["images"]) == 1


def test_extract_recipe_endpoint_json_mocked():
    sample_response_json = {
        "title": "Diet Bolognese",
        "description": "High-protein lean turkey pasta.",
        "servings": 4,
        "nutrition": {"calories": 488, "protein": 50.0, "carbs": 52.0, "fat": 9.0},
        "ingredients": [{"name": "Ground Turkey", "qty": "500g"}],
        "steps": [{"number": 1, "instruction": "Brown turkey in a pan."}],
    }

    mock_resp_lines = [
        json.dumps({"message": {"content": json.dumps(sample_response_json)}, "done": True}).encode("utf-8")
    ]
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp_lines

    raw_bytes = create_dummy_image_bytes()
    b64_str = f"data:image/jpeg;base64,{raw_bytes.hex()}"  # or proper base64

    import base64
    b64_data = f"data:image/jpeg;base64,{base64.b64encode(raw_bytes).decode('utf-8')}"

    with patch("app.recipes.photo_extractor.get_ollama_host", return_value="http://mock-ollama:11434"):
        with patch("urllib.request.urlopen", return_value=mock_resp):
            response = client.post(
                "/api/v1/recipes/extract-image",
                json={"images": [b64_data], "target_lang": "auto"},
            )
            assert response.status_code == 200
            data = response.json()
            assert data["title"] == "Diet Bolognese"
            assert data["servings"] == 4
            assert data["nutrition"]["calories"] == 488
            assert len(data["ingredients"]) == 1


def test_extract_recipe_endpoint_no_images():
    response = client.post("/api/v1/recipes/extract-image", json={"images": []})
    assert response.status_code == 400
