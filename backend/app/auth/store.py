"""Thread-safe persistent JSON store for user accounts and profiles."""
from __future__ import annotations

import datetime
import json
import os
import threading
import uuid
from typing import Any, Dict, List, Optional

from ..config import VALID_ENVS, settings


def _default_user_store_path() -> str:
    base = (settings.data_dir or "media").rstrip("/")
    return os.path.join(base, "store", "users.json")


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class UserStore:
    def __init__(self, path: Optional[str] = None) -> None:
        self._path = path or _default_user_store_path()
        self._lock = threading.Lock()
        self._ensure_init()

    @property
    def path(self) -> str:
        return self._path

    def _ensure_init(self) -> None:
        with self._lock:
            if not os.path.exists(self._path):
                self._write_unlocked({"users": {}})

    def _read_unlocked(self) -> Dict[str, Any]:
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                doc = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {"users": {}}
        if not isinstance(doc, dict) or not isinstance(doc.get("users"), dict):
            return {"users": {}}
        return doc

    def _write_unlocked(self, doc: Dict[str, Any]) -> None:
        parent = os.path.dirname(self._path) or "."
        os.makedirs(parent, exist_ok=True)
        payload = json.dumps(doc, indent=2, ensure_ascii=False)
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp, self._path)

    def get_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            doc = self._read_unlocked()
            u = doc["users"].get(user_id)
            return dict(u) if u else None

    def get_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        norm_email = (email or "").strip().lower()
        if not norm_email:
            return None
        with self._lock:
            doc = self._read_unlocked()
            for u in doc["users"].values():
                if (u.get("email") or "").lower() == norm_email:
                    return dict(u)
            return None

    def list_users(self) -> List[Dict[str, Any]]:
        with self._lock:
            doc = self._read_unlocked()
            return [dict(u) for u in doc["users"].values()]

    def create_user(
        self,
        email: str,
        name: str,
        password_hash: str = "",
        auth_provider: str = "local",
        google_id: str = "",
        avatar: str = "👩‍🍳",
        language: str = "hu",
        invite_code: Optional[str] = None,
    ) -> Dict[str, Any]:
        norm_email = email.strip().lower()
        now = _now_iso()
        with self._lock:
            doc = self._read_unlocked()
            for existing in doc["users"].values():
                if (existing.get("email") or "").lower() == norm_email:
                    raise ValueError("Email already registered")

            is_first_user = len(doc["users"]) == 0
            cfg = self._get_settings_unlocked(doc)
            expected_invite = (cfg.get("invite_code") or os.environ.get("SOLIN_INVITE_CODE") or "").strip()
            given_invite = (invite_code or "").strip()

            if is_first_user:
                user_status = "active"
            elif expected_invite and given_invite and given_invite == expected_invite:
                user_status = "active"
            elif cfg.get("require_approval"):
                user_status = "pending"
            else:
                user_status = "active"

            uid = "usr-" + uuid.uuid4().hex[:12]
            user = {
                "id": uid,
                "email": norm_email,
                "name": name.strip(),
                "password_hash": password_hash,
                "auth_provider": auth_provider,
                "google_id": google_id,
                "avatar": avatar or "👩‍🍳",
                "bio": "",
                "language": language if language in ("hu", "en") else "hu",
                "dietary_preferences": [],
                "macro_goals": {
                    "kcal": None,
                    "protein_g": None,
                    "carbs_g": None,
                    "fat_g": None,
                },
                "role": "owner" if is_first_user else "user",
                "status": user_status,
                "created_at": now,
                "updated_at": now,
            }
            doc["users"][uid] = user
            self._write_unlocked(doc)
            return dict(user)

    def _get_settings_unlocked(self, doc: Dict[str, Any]) -> Dict[str, Any]:
        raw = doc.get("settings")
        if not isinstance(raw, dict):
            raw = {}
        default_require = (
            settings.env in VALID_ENVS
            and os.environ.get("SOLIN_OPEN_REGISTRATION", "").strip().lower() not in ("1", "true", "yes")
        )
        return {
            "require_approval": bool(raw.get("require_approval", default_require)),
            "invite_code": str(raw.get("invite_code") or os.environ.get("SOLIN_INVITE_CODE") or ""),
        }

    def get_settings(self) -> Dict[str, Any]:
        with self._lock:
            doc = self._read_unlocked()
            return self._get_settings_unlocked(doc)

    def update_settings(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            doc = self._read_unlocked()
            cur = self._get_settings_unlocked(doc)
            if "require_approval" in patch and patch["require_approval"] is not None:
                cur["require_approval"] = bool(patch["require_approval"])
            if "invite_code" in patch and patch["invite_code"] is not None:
                cur["invite_code"] = str(patch["invite_code"]).strip()
            doc["settings"] = cur
            self._write_unlocked(doc)
            return dict(cur)

    def delete_user(self, user_id: str) -> bool:
        with self._lock:
            doc = self._read_unlocked()
            if user_id not in doc["users"]:
                return False
            del doc["users"][user_id]
            self._write_unlocked(doc)
            return True

    def update_user(self, user_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self._lock:
            doc = self._read_unlocked()
            user = doc["users"].get(user_id)
            if not user:
                return None
            for k, v in patch.items():
                if k not in ("id", "email", "created_at") and v is not None:
                    user[k] = v
            user["updated_at"] = _now_iso()
            doc["users"][user_id] = user
            self._write_unlocked(doc)
            return dict(user)

    @staticmethod
    def to_public_profile(user: Dict[str, Any]) -> Dict[str, Any]:
        mg = user.get("macro_goals") or {}
        resolved_name = user.get("name") or user.get("display_name") or user["email"].split("@")[0]
        return {
            "id": user["id"],
            "email": user["email"],
            "name": resolved_name,
            "display_name": resolved_name,
            "avatar": user.get("avatar") or "👩‍🍳",
            "bio": user.get("bio") or "",
            "language": user.get("language") or "hu",
            "dietary_preferences": list(user.get("dietary_preferences") or []),
            "macro_goals": {
                "kcal": mg.get("kcal"),
                "protein_g": mg.get("protein_g"),
                "carbs_g": mg.get("carbs_g"),
                "fat_g": mg.get("fat_g"),
            },
            "auth_provider": user.get("auth_provider") or "local",
            "role": user.get("role") or "user",
            "status": user.get("status") or "active",
            "created_at": user.get("created_at") or _now_iso(),
            "updated_at": user.get("updated_at") or _now_iso(),
        }


default_user_store = UserStore()
