"""Pydantic models for authentication and user profiles."""
from __future__ import annotations

import re
from typing import List, Optional
from pydantic import BaseModel, Field, field_validator, model_validator


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class MacroGoals(BaseModel):
    kcal: Optional[int] = Field(default=None, ge=0, le=20000)
    protein_g: Optional[float] = Field(default=None, ge=0, le=2000)
    carbs_g: Optional[float] = Field(default=None, ge=0, le=2000)
    fat_g: Optional[float] = Field(default=None, ge=0, le=2000)


class UserProfile(BaseModel):
    id: str
    email: str
    name: str
    display_name: str = ""
    avatar: str = "👩‍🍳"
    bio: str = ""
    language: str = "hu"
    dietary_preferences: List[str] = Field(default_factory=list)
    macro_goals: MacroGoals = Field(default_factory=MacroGoals)
    auth_provider: str = "local"  # "local" | "google" | "both"
    role: str = "user"            # "owner" | "user"
    created_at: str
    updated_at: str

    @model_validator(mode="after")
    def _sync_names(self) -> "UserProfile":
        if not self.display_name and self.name:
            self.display_name = self.name
        elif not self.name and self.display_name:
            self.name = self.display_name
        return self


class RegisterRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=6, max_length=256)
    name: Optional[str] = Field(default=None, max_length=120)
    display_name: Optional[str] = Field(default=None, max_length=120)
    language: str = Field(default="hu")

    @field_validator("email")
    @classmethod
    def _validate_email(cls, v: str) -> str:
        clean = (v or "").strip().lower()
        if not EMAIL_RE.match(clean):
            raise ValueError("Invalid email address")
        return clean

    @model_validator(mode="after")
    def _resolve_name(self) -> "RegisterRequest":
        resolved = (self.display_name or self.name or "").strip()
        if not resolved:
            resolved = self.email.split("@")[0]
        self.name = resolved
        self.display_name = resolved
        return self


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=1, max_length=256)

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, v: str) -> str:
        return (v or "").strip().lower()


class GoogleAuthRequest(BaseModel):
    credential: Optional[str] = None
    id_token: Optional[str] = None
    email: Optional[str] = None
    name: Optional[str] = None
    display_name: Optional[str] = None
    picture: Optional[str] = None
    google_id: Optional[str] = None
    language: Optional[str] = "hu"


class ProfileUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    display_name: Optional[str] = Field(default=None, max_length=120)
    avatar: Optional[str] = Field(default=None, max_length=500)
    bio: Optional[str] = Field(default=None, max_length=500)
    language: Optional[str] = Field(default=None, max_length=10)
    dietary_preferences: Optional[List[str]] = None
    macro_goals: Optional[MacroGoals] = None


class PasswordChangeRequest(BaseModel):
    current_password: Optional[str] = ""
    new_password: str = Field(..., min_length=6, max_length=256)


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserProfile
