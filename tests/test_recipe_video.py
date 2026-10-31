"""Unit tests for video upload and downloader endpoints."""
import io
import pytest
from fastapi.testclient import TestClient

from backend.app.main import app

client = TestClient(app)


def test_video_upload_endpoint():
    dummy_mp4 = b"\x00\x00\x00 ftypisom\x00\x00\x02\x00isomiso2mp41\x00\x00\x00\x08free"
    files = {"file": ("test_video.mp4", io.BytesIO(dummy_mp4), "video/mp4")}
    data = {"recipe_id": "test_rec_1"}
    resp = client.post("/api/v1/recipes/video/upload", files=files, data=data)
    assert resp.status_code == 200
    res = resp.json()
    assert "video_url" in res
    assert res["video_url"].startswith("/api/v1/media/videos/")
    assert res["video_url"].endswith(".mp4")


def test_video_upload_invalid_format():
    dummy_txt = b"not a video"
    files = {"file": ("test.txt", io.BytesIO(dummy_txt), "text/plain")}
    resp = client.post("/api/v1/recipes/video/upload", files=files)
    assert resp.status_code == 400


def test_video_download_endpoint(monkeypatch):
    from backend.app.recipes import video_service

    def fake_download(url, recipe_id=None):
        return {
            "video_url": "/api/v1/media/videos/rec_mock_123.mp4",
            "filename": "rec_mock_123.mp4",
            "thumbnail_url": "/api/v1/media/videos/rec_mock_123_thumb.jpg",
            "title": "Creamy Garlic Chicken",
            "duration": 45,
            "creator": "aussiefitness",
            "description": "549 Kcal | 74g Protein Creamy Garlic Chicken and Mashed Potatoes recipe",
            "size_bytes": 10240,
        }

    monkeypatch.setattr(video_service, "download_video_from_url", fake_download)

    payload = {"url": "https://www.tiktok.com/@aussiefitness/video/123456", "recipe_id": "r1"}
    resp = client.post("/api/v1/recipes/video/download", json=payload)
    assert resp.status_code == 200
    res = resp.json()
    assert res["video_url"] == "/api/v1/media/videos/rec_mock_123.mp4"
    assert res["description"] == "549 Kcal | 74g Protein Creamy Garlic Chicken and Mashed Potatoes recipe"
    assert res["creator"] == "aussiefitness"
    assert res["title"] == "Creamy Garlic Chicken"


def test_video_extract_endpoint(monkeypatch):
    from backend.app.recipes import video_service

    def fake_download(url, recipe_id=None):
        return {
            "video_url": "/api/v1/media/videos/rec_mock_123.mp4",
            "filename": "rec_mock_123.mp4",
            "thumbnail_url": "/api/v1/media/videos/rec_mock_123_thumb.jpg",
            "title": "Creamy Garlic Chicken & Mashed Potatoes",
            "duration": 45,
            "creator": "aussiefitness",
            "description": "549 Kcal | 74g Protein | 46g Carbs | 9.5g Fat\n\nIngredients:\n• 1.4KG Peeled & Diced Potatoes\n• 300g Blended Low Fat Cottage Cheese\n• 800g Chicken Breast\n\nInstructions:\n1. Peel & dice potatoes and boil for 20 minutes\n2. Blend cottage cheese and mix with mash",
            "size_bytes": 10240,
        }

    monkeypatch.setattr(video_service, "download_video_from_url", fake_download)

    payload = {"url": "https://www.tiktok.com/@aussiefitness/video/123456"}
    resp = client.post("/api/v1/recipes/extract-video", json=payload)
    assert resp.status_code == 200
    res = resp.json()
    assert res["title"] == "Creamy Garlic Chicken & Mashed Potatoes"
    assert res["video"] == "/api/v1/media/videos/rec_mock_123.mp4"
    assert res["macrosPerServing"]["kcal"] == 549
    assert res["macrosPerServing"]["protein"] == 74
    assert len(res["ingredients"]) >= 2
    assert len(res["steps"]) >= 2


def test_video_extract_steps_from_transcript_when_description_empty(monkeypatch):
    from backend.app.recipes import video_service

    def fake_download(url, recipe_id=None):
        return {
            "video_url": "/api/v1/media/videos/rec_pasta_123.mp4",
            "filename": "rec_pasta_123.mp4",
            "thumbnail_url": "/api/v1/media/videos/rec_pasta_123_thumb.jpg",
            "title": "Javítom magam — Chicken & Sausage Pasta",
            "duration": 60,
            "creator": "iamvargacsaba",
            "description": "Javítom magam, ez 10/10!! A kiírt tápérték egy adagra értendő. 5 adagra osztottam az egészet 🫡 #recept #highprotein",
            "transcript": "[6s] nyomjuk kétszáz gramm vöröshagyma bele a tálba\n[8s] és mehet hozzá ötven gramm apróra vágott kolbász\n[13s] akkor mehet bele hatszázötven gramm csirkeemlő",
            "size_bytes": 20480,
        }

    monkeypatch.setattr(video_service, "download_video_from_url", fake_download)

    payload = {"url": "https://www.tiktok.com/@iamvargacsaba/video/7673157007536344342"}
    resp = client.post("/api/v1/recipes/extract-video", json=payload)
    assert resp.status_code == 200
    res = resp.json()
    assert "transcript" in res
    assert "[6s] nyomjuk kétszáz gramm vöröshagyma" in res["transcript"]
    # Even with empty description steps, steps are produced from the transcript
    assert len(res["steps"]) >= 2
    assert res["steps"][0]["t"] == 6 or res["steps"][0]["t"] > 0
    assert len(res["ingredients"]) >= 2

