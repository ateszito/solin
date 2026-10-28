"""Ingestion HTTP adapter (contract §16.3/§16.6, §16.8 error codes).

ONE router mounted at prefix /api/v1. Error bodies stay flat C8
{code, message, details?, fields?}: IngestionError subclasses
InventoryError, so the handler register_inventory already installed
formats ingestion errors byte-identically (one error dialect).

Endpoints (§16.3):
  POST /api/v1/ingest             202 | 400 | 403 | 429 (+404/410 kinds)
  GET  /api/v1/ingest/{id}        200 status block (+cond. recipe_draft)
                                  | 404 NOT_FOUND (pruned) | 410
                                  FILE_UNAVAILABLE (source file expired)
  GET  /api/v1/ingest/{id}/transcript   200 | 404 (pruned/never stored)
  GET  /api/v1/ingest/{id}/draft        200 | 404 | 422 (no draft yet)

Default-ON pure-local guards (§16.6): per-identity 20/60s over
submit AND status (identity = client IP; no account system in v1);
inflight queue cap 12 → 429 AT THE GATE on submit (no queue-drop
later). submit never blocks: 202 + background worker chain (§16.5).
"""

from __future__ import annotations

import time
from typing import Any, Dict
from urllib.parse import urlparse

from fastapi import APIRouter, Request

from .errors import IngestionError
from .store import NONTERMINAL, TERMINAL_ERR, TERMINAL_OK

# Accepted submit kinds (§16.3 "one-of submit"). Unknown kind → 400
# VALIDATION_ERROR (kind-reject default).
KINDS = ("url", "file_submit", "file_ref", "transcript")


def identity_of(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "anon"


def _url_hosts(cfg: Dict[str, Any]) -> tuple:
    return tuple(h.strip().lower() for h in
                 (cfg.get("url_fetch_hosts") or "").split(",") if h.strip())


def _is_platform_url(url: str, cfg: Dict[str, Any]) -> bool:
    try:
        host = (urlparse(url).netloc or "").split(":")[0].lower()
    except ValueError:
        return False
    return any(host == h or host.endswith("." + h)
               for h in _url_hosts(cfg))


def build_router(store, cfg: Dict[str, Any]) -> APIRouter:
    router = APIRouter()

    def guard_identity(request: Request) -> None:
        # 20/60s per identity, submit+status counted together (§16.6)
        if not store.gate_identity(identity_of(request)):
            raise IngestionError(429, "TOO_MANY_REQUESTS",
                                 "per-identity 20/60s guard tripped "
                                 "(default-on, pure-local)")

    def guard_inflight() -> None:
        if not store.gate_inflight():
            raise IngestionError(429, "TOO_MANY_REQUESTS",
                                 "inflight queue over cap (default 12); "
                                 "rejected at the gate — no queue-drop "
                                 "later (default-on)")

    @router.post("/ingest", status_code=202)
    @router.post("/ingest/submit", status_code=202)
    def submit(request: Request, body: Dict[str, Any]) -> Dict[str, Any]:
        guard_identity(request)
        guard_inflight()

        kind = body.get("source_type", "")
        sid = body.get("source_id", "")
        fkey = body.get("file_key", "")
        locale = body.get("locale", "en")

        if kind not in KINDS:
            raise IngestionError(
                400, "VALIDATION_ERROR",
                f"source_type {kind!r} is not an accepted kind "
                f"(one-of: {', '.join(KINDS)})",
                fields=["source_type"])
        if not isinstance(sid, str) or not isinstance(fkey, str):
            raise IngestionError(400, "VALIDATION_ERROR",
                                 "source_id and file_key must be strings "
                                 "('' allowed)",
                                 fields=["source_id", "file_key"])

        orig_kind = kind
        if kind == "file_ref":
            kind = "file_submit"
            if not fkey and sid:
                fkey = sid

        if kind == "url":
            # unsupported-platform shape is a 400 FIRST (kind-reject),
            # then the flag gate (§16.3: 403 when SOLIN_URL_FETCH=off —
            # error branch routes to B/manual, never auto-parse).
            if not sid or not _is_platform_url(sid, cfg):
                raise IngestionError(400, "VALIDATION_ERROR",
                                     "url is not a TikTok/Instagram shape "
                                     "in the accepted host set",
                                     fields=["source_type", "source_id"])
            if not cfg.get("url_fetch", False):
                raise IngestionError(
                    403, "FEATURE_DISABLED",
                    "URL auto-fetch is OFF by default (SOLIN_URL_FETCH) — "
                    "download on your device and attach the file, or "
                    "paste the transcript (path B/C)")
        elif kind == "file_submit":
            if orig_kind != "file_ref":
                if not fkey:
                    raise IngestionError(400, "VALIDATION_ERROR",
                                         "file_submit needs file_key",
                                         fields=["file_key"])
                import os as _os
                root = cfg.get("data_root", "")
                full = _os.path.join(root, fkey) if root else ""
                if not full or not _os.path.isfile(full):
                    raise IngestionError(400, "VALIDATION_ERROR",
                                         "file_key not found inside the "
                                         "ingest-data root (upload first — "
                                         "kind-reject default)",
                                         fields=["file_key"])
        else:  # transcript
            if not isinstance(sid, str) or not sid.strip():
                raise IngestionError(400, "VALIDATION_ERROR",
                                     "empty transcript paste has nothing "
                                     "to resolve (empty→submit guard)",
                                     fields=["source_id"])

        rec = store.create(source_type=kind, source_id=sid,
                           file_key=fkey, locale=locale,
                           identity=identity_of(request))
        # 202 immediately — UI polls, never blocks (§16.3 async pattern).
        return {"ingest_id": rec["ingest_id"],
                "ingestId": rec["ingest_id"],
                "status": "PENDING",
                "state": "QUEUED",
                "created_at": rec["created_at"],
                "poll": f"/api/v1/ingest/{rec['ingest_id']}"}

    @router.get("/ingest/{ingest_id}")
    def status(request: Request, ingest_id: str) -> Dict[str, Any]:
        guard_identity(request)
        rec = store.get(ingest_id)
        if rec is None:
            raise IngestionError(404, "NOT_FOUND",
                                 "record not found or pruned (expiry "
                                 "default 24h; transcripts do not "
                                 "outlive their record)")
        # §16.2 R2 + §16.3: a file-source record read after its source
        # file's expiry window is FILE_UNAVAILABLE (410), not a stale 200.
        if (rec.get("source_type") == "file_submit"
                and time.time() - rec.get("created_at", 0)
                > cfg.get("expiry_h", 24) * 3600):
            raise IngestionError(410, "FILE_UNAVAILABLE",
                                 "uploaded source file already pruned or "
                                 "expired (§16.2 R2)")
        if rec["status"] in TERMINAL_ERR or rec.get("error"):
            out_state = "ERROR"
        elif rec["status"] in TERMINAL_OK:
            out_state = "DRAFT_READY"
        elif rec["status"] in NONTERMINAL:
            out_state = "QUEUED"
        else:
            out_state = rec["status"]
        out = {
            "ingest_id": ingest_id,
            "status": rec["status"],
            "state": out_state,
            "stage": rec.get("stage"),
            "attempt": len(rec.get("attempts") or []),
            "attempts_by_stage": [
                {"stage": a["stage"], "status": a["status"], "statuses": [a["status"]],
                 "at": a["at"]} for a in (rec.get("attempts") or [])][-4:],
        }
        if rec.get("status") in NONTERMINAL:
            out["detail"] = ("chain in flight (worker polls every "
                             "SOLIN_WORKER_POLL_S seconds)")
        if rec.get("status") not in NONTERMINAL and rec.get("error"):
            out["error"] = rec["error"]                    # C8 body inline
            out["detail"] = rec["error"]["message"]
        if rec.get("recipe_draft"):
            out["recipe_draft"] = rec["recipe_draft"]      # cond. block
        return out

    @router.get("/ingest/{ingest_id}/transcript")
    def transcript(ingest_id: str) -> Dict[str, Any]:
        rec = store.get(ingest_id)
        if rec is None or not rec.get("transcript"):
            raise IngestionError(404, "NOT_FOUND",
                                 "no transcript stored (pruned, or the "
                                 "chain never produced one)")
        return {"ingest_id": ingest_id,
                "truncated": bool(rec.get("transcript_truncated")),
                "transcript": rec["transcript"]}

    @router.get("/ingest/{ingest_id}/draft")
    def draft(ingest_id: str) -> Dict[str, Any]:
        rec = store.get(ingest_id)
        if rec is None:
            raise IngestionError(404, "NOT_FOUND",
                                 "record not found or pruned")
        if not rec.get("recipe_draft"):
            # resolved-without-usable-script / chain-blocked lineage
            raise IngestionError(422, "UNPROCESSABLE",
                                 f"no draft yet (status={rec['status']})")
        draft_obj = rec["recipe_draft"]
        if isinstance(draft_obj, dict) and "recipe_json" in draft_obj:
            res = dict(draft_obj["recipe_json"])
            res["trust"] = draft_obj.get("trust", 0.55)
            res["recipe_json"] = draft_obj["recipe_json"]
            return res
        return draft_obj

    return router
