"""Cryptographic helpers for password hashing, JWT tokens, and Google OAuth."""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import socket
import threading
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from ..config import settings

PBKDF2_ITERATIONS = 200_000
DEFAULT_TOKEN_TTL_SEC = 30 * 86400  # 30 days


def _jwt_secret() -> bytes:
    raw = settings.jwt_secret_key or os.environ.get("JWT_SECRET_KEY") or "solin-local-dev-jwt-secret-key-v1"
    return raw.encode("utf-8")


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * ((4 - len(data) % 4) % 4)
    return base64.urlsafe_b64decode((data + pad).encode("ascii"))


def hash_password(password: str) -> str:
    """Hash a plaintext password using PBKDF2-HMAC-SHA256 with a 16-byte salt."""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    """Verify a plaintext password against a stored PBKDF2 hash in constant time."""
    if not password or not stored_hash:
        return False
    try:
        parts = stored_hash.split("$")
        if len(parts) != 4 or parts[0] != "pbkdf2_sha256":
            return False
        iterations = int(parts[1])
        salt = bytes.fromhex(parts[2])
        expected = bytes.fromhex(parts[3])
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def create_access_token(
    user_id: str,
    email: str,
    role: str = "user",
    expires_sec: int = DEFAULT_TOKEN_TTL_SEC,
) -> str:
    """Create an HS256-signed JWT token."""
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "iat": now,
        "exp": now + expires_sec,
    }
    h_b64 = _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    p_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{h_b64}.{p_b64}".encode("ascii")
    sig = hmac.new(_jwt_secret(), signing_input, hashlib.sha256).digest()
    s_b64 = _b64url_encode(sig)
    return f"{h_b64}.{p_b64}.{s_b64}"


def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    """Verify and decode an HS256 JWT token. Returns None if invalid or expired."""
    if not token or not isinstance(token, str):
        return None
    parts = token.strip().split(".")
    if len(parts) != 3:
        return None
    h_b64, p_b64, s_b64 = parts
    try:
        signing_input = f"{h_b64}.{p_b64}".encode("ascii")
        expected_sig = hmac.new(_jwt_secret(), signing_input, hashlib.sha256).digest()
        actual_sig = _b64url_decode(s_b64)
        if not hmac.compare_digest(actual_sig, expected_sig):
            return None
        payload = json.loads(_b64url_decode(p_b64).decode("utf-8"))
        if not isinstance(payload, dict):
            return None
        exp = payload.get("exp")
        if exp is not None and int(time.time()) > int(exp):
            return None
        if not payload.get("sub"):
            return None
        return payload
    except Exception:
        return None


def verify_google_id_token(id_token: str, expected_client_id: str = "") -> Optional[Dict[str, Any]]:
    """Verify a Google OAuth / GIS ID token via Google's tokeninfo endpoint."""
    if not id_token:
        return None
    try:
        url = "https://oauth2.googleapis.com/tokeninfo?" + urllib.parse.urlencode({"id_token": id_token})
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                return None
            data = json.loads(resp.read().decode("utf-8"))
        if expected_client_id and data.get("aud") != expected_client_id:
            return None
        email = (data.get("email") or "").strip().lower()
        if not email:
            return None
        return {
            "email": email,
            "name": data.get("name") or email.split("@")[0],
            "picture": data.get("picture") or "",
            "google_id": data.get("sub") or "",
            "email_verified": str(data.get("email_verified", "true")).lower() == "true",
        }
    except Exception:
        return None


class SlidingWindowRateLimiter:
    """Thread-safe in-memory sliding-window rate limiter."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hits: Dict[str, List[float]] = {}

    def allow(self, key: str, max_requests: int = 15, window_sec: float = 60.0) -> bool:
        now = time.monotonic()
        cutoff = now - window_sec
        with self._lock:
            bucket = [t for t in self._hits.get(key, []) if t > cutoff]
            if len(bucket) >= max_requests:
                self._hits[key] = bucket
                return False
            bucket.append(now)
            self._hits[key] = bucket
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


rate_limiter = SlidingWindowRateLimiter()


def _is_disallowed_ip(ip_str: str) -> bool:
    try:
        ip_obj = ipaddress.ip_address(ip_str)
        return (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
        )
    except ValueError:
        return True


def validate_safe_public_url(url: str) -> str:
    """Validate that a URL is strictly http(s) and points to a public internet host (SSRF protection).

    Raises ValueError if the URL is invalid, non-HTTP(S), or targets a private/internal/loopback address.
    """
    clean = (url or "").strip()
    if not clean:
        raise ValueError("URL cannot be empty")
    parsed = urllib.parse.urlparse(clean)
    if parsed.scheme.lower() not in ("http", "https"):
        raise ValueError("Only http:// and https:// URLs are permitted")
    host = (parsed.hostname or "").strip().lower()
    if not host:
        raise ValueError("URL must contain a valid hostname")
    if host in ("localhost", "0.0.0.0", "127.0.0.1", "::1") or host.endswith((".local", ".internal", ".lan")):
        raise ValueError("Internal or loopback hosts are not permitted")

    # Check if host is a literal IP address
    try:
        ipaddress.ip_address(host)
        if _is_disallowed_ip(host):
            raise ValueError("Private or reserved IP addresses are not permitted")
        return clean
    except ValueError as e:
        if "Private or reserved" in str(e):
            raise

    # Require a public domain structure (at least one dot)
    if "." not in host:
        raise ValueError("Internal single-label hostnames are not permitted")

    # Resolve DNS if network is available; block if any resolved IP is private/loopback
    try:
        infos = socket.getaddrinfo(host, None)
        for info in infos:
            sockaddr = info[4]
            if sockaddr and len(sockaddr) >= 1:
                ip_candidate = str(sockaddr[0]).split("%")[0]
                if _is_disallowed_ip(ip_candidate):
                    raise ValueError("URL resolves to a private or internal network address")
    except socket.gaierror:
        # DNS resolution failure will be handled downstream by yt-dlp / HTTP client
        pass

    return clean

