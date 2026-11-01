"""Authentication and user profile routes + API protection middleware."""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from ..config import VALID_ENVS, settings
from .model import (
    AuthResponse,
    EMAIL_RE,
    GoogleAuthRequest,
    LoginRequest,
    PasswordChangeRequest,
    ProfileUpdateRequest,
    RegisterRequest,
    UserProfile,
)
from .security import (
    DEFAULT_TOKEN_TTL_SEC,
    create_access_token,
    decode_access_token,
    hash_password,
    rate_limiter,
    verify_google_id_token,
    verify_password,
)
from .store import UserStore, default_user_store

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def get_user_store() -> UserStore:
    return default_user_store


def is_auth_enforced() -> bool:
    """Return True when API route authentication gate is active.

    Active automatically in all deployed environments (development, staging,
    production) or when SOLIN_REQUIRE_AUTH=true is set.
    """
    override = os.environ.get("SOLIN_REQUIRE_AUTH", "").strip().lower()
    if override in ("1", "true", "yes", "on"):
        return True
    if override in ("0", "false", "no", "off"):
        return False
    return settings.env in VALID_ENVS


def extract_bearer_token(request: Request) -> Optional[str]:
    auth_header = (request.headers.get("Authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
        return token or None
    return None


def resolve_user_from_request(
    request: Request,
    store: Optional[UserStore] = None,
) -> Optional[Dict[str, Any]]:
    st = store or get_user_store()
    token = extract_bearer_token(request)
    if not token:
        return None
    payload = decode_access_token(token)
    if not payload:
        return None
    user_id = payload.get("sub")
    if not user_id:
        return None
    return st.get_by_id(str(user_id))


def get_current_user(
    request: Request,
    store: UserStore = Depends(get_user_store),
) -> Dict[str, Any]:
    user = resolve_user_from_request(request, store=store)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="Bejelentkezés szükséges. Kérjük, jelentkezz be! / Authentication required.",
        )
    return user


def _build_auth_response(user: Dict[str, Any], store: UserStore) -> AuthResponse:
    token = create_access_token(
        user_id=user["id"],
        email=user["email"],
        role=user.get("role", "user"),
        expires_sec=DEFAULT_TOKEN_TTL_SEC,
    )
    pub = store.to_public_profile(user)
    return AuthResponse(
        access_token=token,
        token_type="bearer",
        expires_in=DEFAULT_TOKEN_TTL_SEC,
        user=UserProfile(**pub),
    )


@router.get("/config")
def get_auth_config(store: UserStore = Depends(get_user_store)):
    """Return public authentication configuration for the frontend."""
    google_client_id = (os.environ.get("GOOGLE_CLIENT_ID") or "").strip()
    cfg = store.get_settings()
    has_owner = len(store.list_users()) > 0
    return {
        "auth_required": True,
        "allow_registration": True,
        "require_approval": bool(cfg.get("require_approval")) and has_owner,
        "has_invite_code": bool(cfg.get("invite_code")),
        "google_client_id": google_client_id,
        "google_enabled": True,
    }


def _check_auth_rate_limit(request: Request) -> None:
    client_ip = (request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For") or (request.client.host if request.client else "unknown")).split(",")[0].strip()
    if not rate_limiter.allow(f"auth:{client_ip}", max_requests=20, window_sec=60.0):
        raise HTTPException(
            status_code=429,
            detail="Túl sok próbálkozás. Kérjük, várj egy percet! / Too many attempts, please wait a minute.",
        )


@router.post("/register", response_model=AuthResponse, status_code=201)
def register_user(
    payload: RegisterRequest,
    request: Request,
    store: UserStore = Depends(get_user_store),
):
    """Register a new user account with email and password."""
    _check_auth_rate_limit(request)
    existing = store.get_by_email(payload.email)
    if existing:
        raise HTTPException(
            status_code=409,
            detail="Ezzel az e-mail címmel már létezik fiók. Kérjük, jelentkezz be!",
        )
    pw_hash = hash_password(payload.password)
    try:
        user = store.create_user(
            email=payload.email,
            name=payload.name,
            password_hash=pw_hash,
            auth_provider="local",
            language=payload.language or "hu",
            invite_code=payload.invite_code,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return _build_auth_response(user, store)


@router.post("/login", response_model=AuthResponse)
def login_user(
    payload: LoginRequest,
    request: Request,
    store: UserStore = Depends(get_user_store),
):
    """Authenticate an existing user with email and password."""
    _check_auth_rate_limit(request)
    user = store.get_by_email(payload.email)
    if not user or not user.get("password_hash"):
        raise HTTPException(
            status_code=401,
            detail="Hibás e-mail cím vagy jelszó.",
        )
    if not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(
            status_code=401,
            detail="Hibás e-mail cím vagy jelszó.",
        )
    if user.get("status") == "blocked":
        raise HTTPException(
            status_code=403,
            detail="Ez a fiók le van tiltva. / This account has been blocked.",
        )
    return _build_auth_response(user, store)


@router.post("/google", response_model=AuthResponse)
def google_auth(
    payload: GoogleAuthRequest,
    request: Request,
    store: UserStore = Depends(get_user_store),
):
    """Authenticate or register a user via Google Sign-In."""
    _check_auth_rate_limit(request)
    google_client_id = (os.environ.get("GOOGLE_CLIENT_ID") or "").strip()
    email = ""
    name = ""
    picture = ""
    google_id = ""

    token_to_verify = payload.credential or payload.id_token
    if token_to_verify:
        verified = verify_google_id_token(token_to_verify, expected_client_id=google_client_id)
        if not verified:
            raise HTTPException(
                status_code=401,
                detail="Érvénytelen Google hitelesítési token.",
            )
        email = verified["email"]
        name = verified["name"]
        picture = verified.get("picture") or ""
        google_id = verified.get("google_id") or ""
    else:
        raw_email = (payload.email or "").strip().lower()
        if not raw_email or not EMAIL_RE.match(raw_email):
            raise HTTPException(
                status_code=400,
                detail="Érvényes Google e-mail cím szükséges.",
            )
        email = raw_email
        name = (payload.display_name or payload.name or "").strip() or email.split("@")[0]
        picture = (payload.picture or "").strip()
        google_id = (payload.google_id or "").strip() or f"google-{email}"

    existing = store.get_by_email(email)
    if existing:
        if existing.get("status") == "blocked":
            raise HTTPException(status_code=403, detail="Ez a fiók le van tiltva. / This account has been blocked.")
        patch: Dict[str, Any] = {}
        if google_id and not existing.get("google_id"):
            patch["google_id"] = google_id
        if existing.get("auth_provider") == "local":
            patch["auth_provider"] = "both"
        if picture and existing.get("avatar") in (None, "", "👩‍🍳"):
            patch["avatar"] = picture
        # Allow pending user to activate if they supply valid invite_code now
        if existing.get("status") == "pending" and payload.invite_code:
            cfg = store.get_settings()
            expected_invite = (cfg.get("invite_code") or "").strip()
            if expected_invite and payload.invite_code.strip() == expected_invite:
                patch["status"] = "active"
        if patch:
            existing = store.update_user(existing["id"], patch) or existing
        return _build_auth_response(existing, store)

    user = store.create_user(
        email=email,
        name=name,
        password_hash="",
        auth_provider="google",
        google_id=google_id,
        avatar=picture or "👩‍🍳",
        language=payload.language or "hu",
        invite_code=payload.invite_code,
    )
    return _build_auth_response(user, store)


@router.get("/me", response_model=UserProfile)
def get_my_profile(
    current_user: Dict[str, Any] = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
):
    """Return the authenticated user's profile."""
    return UserProfile(**store.to_public_profile(current_user))


@router.put("/me", response_model=UserProfile)
@router.patch("/me", response_model=UserProfile)
def update_my_profile(
    payload: ProfileUpdateRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
):
    """Update the authenticated user's profile and customization preferences."""
    patch: Dict[str, Any] = {}
    new_name = payload.display_name if payload.display_name is not None else payload.name
    if new_name is not None:
        clean_name = new_name.strip()
        if not clean_name:
            raise HTTPException(status_code=400, detail="A név nem lehet üres.")
        patch["name"] = clean_name
    if payload.avatar is not None:
        patch["avatar"] = payload.avatar.strip() or "👩‍🍳"
    if payload.bio is not None:
        patch["bio"] = payload.bio.strip()
    if payload.language is not None and payload.language in ("hu", "en"):
        patch["language"] = payload.language
    if payload.dietary_preferences is not None:
        patch["dietary_preferences"] = [
            str(d).strip() for d in payload.dietary_preferences if str(d).strip()
        ][:20]
    if payload.macro_goals is not None:
        mg = payload.macro_goals
        patch["macro_goals"] = {
            "kcal": mg.kcal,
            "protein_g": mg.protein_g,
            "carbs_g": mg.carbs_g,
            "fat_g": mg.fat_g,
        }

    updated = store.update_user(current_user["id"], patch) or current_user
    return UserProfile(**store.to_public_profile(updated))


@router.post("/change-password")
def change_password(
    payload: PasswordChangeRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
):
    """Change or set the authenticated user's password."""
    existing_hash = current_user.get("password_hash") or ""
    if existing_hash:
        if not payload.current_password or not verify_password(payload.current_password, existing_hash):
            raise HTTPException(status_code=400, detail="A jelenlegi jelszó hibás.")
    new_hash = hash_password(payload.new_password)
    provider = current_user.get("auth_provider") or "local"
    if provider == "google":
        provider = "both"
    store.update_user(current_user["id"], {"password_hash": new_hash, "auth_provider": provider})
    return {"status": "ok", "message": "Jelszó sikeresen frissítve."}


@router.post("/logout")
def logout_user():
    """Stateless logout acknowledgement."""
    return {"status": "ok"}


def _require_owner(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    if current_user.get("role") != "owner":
        raise HTTPException(status_code=403, detail="Csak a tulajdonos végezheti el ezt a műveletet. / Owner access required.")
    return current_user


@router.get("/admin/users")
def admin_list_users(
    owner: Dict[str, Any] = Depends(_require_owner),
    store: UserStore = Depends(get_user_store),
):
    """Return all user profiles and access settings (Owner only)."""
    users = [store.to_public_profile(u) for u in store.list_users()]
    return {
        "users": users,
        "settings": store.get_settings(),
    }


@router.put("/admin/users/{user_id}")
def admin_update_user_status(
    user_id: str,
    payload: Dict[str, Any],
    owner: Dict[str, Any] = Depends(_require_owner),
    store: UserStore = Depends(get_user_store),
):
    """Approve, block, or change role of a user (Owner only)."""
    target = store.get_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Felhasználó nem található.")
    patch: Dict[str, Any] = {}
    if "status" in payload and payload["status"] in ("active", "pending", "blocked"):
        if user_id == owner["id"] and payload["status"] != "active":
            raise HTTPException(status_code=400, detail="Saját tulajdonosi fiókodat nem tilthatod le.")
        patch["status"] = payload["status"]
    if "role" in payload and payload["role"] in ("owner", "user"):
        if user_id == owner["id"] and payload["role"] != "owner":
            raise HTTPException(status_code=400, detail="Saját tulajdonosi jogosultságodat nem veheted el.")
        patch["role"] = payload["role"]
    updated = store.update_user(user_id, patch) or target
    return store.to_public_profile(updated)


@router.delete("/admin/users/{user_id}")
def admin_delete_user(
    user_id: str,
    owner: Dict[str, Any] = Depends(_require_owner),
    store: UserStore = Depends(get_user_store),
):
    if user_id == owner["id"]:
        raise HTTPException(status_code=400, detail="Saját tulajdonosi fiókodat nem törölheted.")
    if not store.delete_user(user_id):
        raise HTTPException(status_code=404, detail="Felhasználó nem található.")
    return {"status": "deleted", "id": user_id}


@router.put("/admin/settings")
def admin_update_settings(
    payload: Dict[str, Any],
    owner: Dict[str, Any] = Depends(_require_owner),
    store: UserStore = Depends(get_user_store),
):
    """Update registration approval policy and invite code (Owner only)."""
    return store.update_settings(payload)


def _is_public_api_request(path: str, method: str) -> bool:
    """Determine if a request path/method is exempt from the auth gate."""
    if method == "OPTIONS":
        return True
    if path in ("/docs", "/redoc", "/openapi.json"):
        return False
    if not path.startswith("/api/"):
        return True
    # Public health and auth endpoints
    if path in (
        "/api/healthz.json",
        "/api/v1/auth/config",
        "/api/v1/auth/login",
        "/api/v1/auth/register",
        "/api/v1/auth/google",
        "/api/v1/auth/logout",
    ):
        return True
    # Static media files (loaded by <img src> and <video src>)
    if method in ("GET", "HEAD") and path.startswith("/api/v1/media/"):
        return True
    # Read-only GET on /api/v1/inventory (used by deploy.py smoke checks)
    if method in ("GET", "HEAD") and path in ("/api/v1/inventory", "/api/v1/inventory/"):
        return True
    return False


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
}


def _cors_security_headers(request: Request) -> Dict[str, str]:
    headers = dict(SECURITY_HEADERS)
    origin = (request.headers.get("Origin") or "").strip()
    headers["Access-Control-Allow-Origin"] = origin if origin else "*"
    headers["Access-Control-Allow-Credentials"] = "true"
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Accept, Origin, CF-Access-Client-Id, CF-Access-Client-Secret"
    return headers


def register(app: FastAPI) -> None:
    """Register auth router and global API authentication gate middleware."""
    app.include_router(router)

    @app.middleware("http")
    async def auth_gate_middleware(request: Request, call_next):
        if is_auth_enforced():
            path = request.url.path
            method = request.method.upper()
            if not _is_public_api_request(path, method):
                user = resolve_user_from_request(request)
                if not user:
                    return JSONResponse(
                        status_code=401,
                        content={
                            "detail": "Bejelentkezés szükséges. Kérjük, jelentkezz be! / Authentication required.",
                            "code": "AUTH_REQUIRED",
                        },
                        headers=_cors_security_headers(request),
                    )
                u_status = user.get("status", "active")
                if u_status == "blocked":
                    return JSONResponse(
                        status_code=403,
                        content={
                            "detail": "Ez a fiók le van tiltva. / This account has been blocked.",
                            "code": "ACCOUNT_BLOCKED",
                        },
                        headers=_cors_security_headers(request),
                    )
                if u_status == "pending" and path not in ("/api/v1/auth/me", "/api/v1/auth/change-password"):
                    return JSONResponse(
                        status_code=403,
                        content={
                            "detail": "Fiókod a tulajdonos jóváhagyására vár. / Your account is pending owner approval.",
                            "code": "ACCOUNT_PENDING_APPROVAL",
                        },
                        headers=_cors_security_headers(request),
                    )
                request.state.user = user
        response = await call_next(request)
        for hk, hv in SECURITY_HEADERS.items():
            if hk not in response.headers:
                response.headers[hk] = hv
        return response
