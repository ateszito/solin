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
