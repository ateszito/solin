"""Tests for User Authentication, Google Sign-In, Profile Customization, and API Auth Gate."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.auth.store import UserStore
from app.auth import routes as auth_routes


@pytest.fixture()
def isolated_user_store(tmp_path, monkeypatch):
    store = UserStore(path=str(tmp_path / "users.json"))
    monkeypatch.setattr(auth_routes, "default_user_store", store)
    return store


def test_register_login_and_profile_update(isolated_user_store):
    client = TestClient(app)

    # 1. Register first user -> gets "owner" role
    reg = client.post(
        "/api/v1/auth/register",
        json={
            "email": "agnes@solin.hu",
            "password": "secretPassword123",
            "display_name": "Ágnes",
            "language": "hu",
        },
    )
    assert reg.status_code == 201, reg.text
    body = reg.json()
    assert body["access_token"]
    assert body["user"]["email"] == "agnes@solin.hu"
    assert body["user"]["display_name"] == "Ágnes"
    assert body["user"]["role"] == "owner"
    token = body["access_token"]

    # 2. Duplicate registration returns 409
    dup = client.post(
        "/api/v1/auth/register",
        json={
            "email": "AGNES@solin.hu",
            "password": "anotherPassword123",
            "display_name": "Dup",
        },
    )
    assert dup.status_code == 409

    # 3. Login with wrong password returns 401
    bad_login = client.post(
        "/api/v1/auth/login",
        json={"email": "agnes@solin.hu", "password": "wrongPassword"},
    )
    assert bad_login.status_code == 401

    # 4. Login with valid password returns 200 + token
    good_login = client.post(
        "/api/v1/auth/login",
        json={"email": "agnes@solin.hu", "password": "secretPassword123"},
    )
    assert good_login.status_code == 200
    assert good_login.json()["access_token"]

    # 5. Fetch & update profile via /api/v1/auth/me
    headers = {"Authorization": f"Bearer {token}"}
    me = client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["email"] == "agnes@solin.hu"

    upd = client.put(
        "/api/v1/auth/me",
        headers=headers,
        json={
            "display_name": "Chef Ágnes",
            "bio": "High-protein recipes & meal prep",
            "avatar": "🥑",
            "language": "en",
            "dietary_preferences": ["high_protein", "lactose_free"],
            "macro_goals": {
                "kcal": 2150,
                "protein_g": 160,
                "carbs_g": 210,
                "fat_g": 70,
            },
        },
    )
    assert upd.status_code == 200
    prof = upd.json()
    assert prof["display_name"] == "Chef Ágnes"
    assert prof["avatar"] == "🥑"
    assert prof["language"] == "en"
    assert prof["dietary_preferences"] == ["high_protein", "lactose_free"]
    assert prof["macro_goals"]["protein_g"] == 160


def test_google_auth_and_password_change(isolated_user_store):
    client = TestClient(app)

    g_resp = client.post(
        "/api/v1/auth/google",
        json={
            "email": "chef.google@gmail.com",
            "display_name": "Google Chef",
            "language": "hu",
        },
    )
    assert g_resp.status_code == 200, g_resp.text
    g_data = g_resp.json()
    assert g_data["user"]["auth_provider"] == "google"
    assert g_data["user"]["display_name"] == "Google Chef"
    token = g_data["access_token"]

    # Set a password on the Google-created account, then log in with email+password
    pw_resp = client.post(
        "/api/v1/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "", "new_password": "newGooglePassword123"},
    )
    assert pw_resp.status_code == 200

    email_login = client.post(
        "/api/v1/auth/login",
        json={"email": "chef.google@gmail.com", "password": "newGooglePassword123"},
    )
    assert email_login.status_code == 200


def test_auth_gate_blocks_unauthenticated_feature_routes(isolated_user_store, monkeypatch):
    monkeypatch.setenv("SOLIN_REQUIRE_AUTH", "true")
    client = TestClient(app)

    # Public probe routes remain accessible
    assert client.get("/healthz").status_code == 200
    assert client.get("/api/v1/auth/config").status_code == 200
    assert client.get("/api/v1/inventory?limit=1").status_code == 200

    # Feature routes are locked with 401 when unauthenticated
    assert client.get("/api/v1/recipes/sync").status_code == 401
    assert client.post("/api/v1/recipes/sync", json={}).status_code == 401
    assert client.get("/api/v1/kamra").status_code == 401
    assert client.post("/api/v1/kamra", json={"name": "zabpehely"}).status_code == 401
    assert client.post("/api/v1/inventory", json={}).status_code == 401

    # Register & authenticate -> feature routes unlock
    reg = client.post(
        "/api/v1/auth/register",
        json={
            "email": "member@solin.hu",
            "password": "validPassword123",
            "display_name": "Member",
        },
    )
    assert reg.status_code == 201
    token = reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    assert client.get("/api/v1/recipes/sync", headers=headers).status_code == 200
    assert client.get("/api/v1/kamra", headers=headers).status_code == 200
