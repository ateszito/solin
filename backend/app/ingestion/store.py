"""Ingestion record flat-store (contract §16.4 S-2 "flat file").

No Redis, no auto re-queue (no wait-slot): one submit = one record, a
terminal record is never recreated from the same source. Records live as
one JSON file each under the ingest-data root (sibling of /media).

Default-ON pure-local guards (§16.6/§16.8):
- per-identity 20/60s sliding window, counted over submit AND status
  polls together (§16.6 "20/60s submit+status"); identity = client IP,
  no account system in v1;
- inflight queue cap (default 12) rejected AT THE GATE on submit —
  never a silent queue-drop later.

Status key set (§16.4 "terminal-flag states"): non-terminal PENDING →
stages; terminal-success OK/LOW_CONFIDENCE; terminal errors listed
below. Unknown/pruned id → NOT_FOUND 404; a record whose uploaded source
file went past its expiry window answers 410 FILE_UNAVAILABLE (§16.2 R2).
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

# ---- §16.4 state machine -------------------------------------------------
NONTERMINAL = ("PENDING", "RESOLVING", "TRANSCRIBING", "EXTRACTING")
TERMINAL_OK = ("OK", "LOW_CONFIDENCE")
TERMINAL_ERR = ("TRANSCRIBED_EMPTY",
                "RESOLVE_FAILED_EXTRACTOR",
                "RESOLVE_FAILED_LOGIN_REQUIRED",
                "RESOLVE_FAILED_PRIVATE_OR_REGION",
                "RESOLVE_FAILED_NO_CHAIN",
                "FILE_UNAVAILABLE",
                "EXTRACT_FAILED")
TERMINAL = frozenset(TERMINAL_OK + TERMINAL_ERR)


def new_ingest_id() -> str:
    """ingest_id = '<kind>-<random suffix>'. Session ids are deliberately
    never reused (id-suffixed random suffix, never None)."""
    return f"{uuid.uuid4().hex[:12]}"


class IngestStore:
    """File-backed per-record store + the two default-ON gates."""

    def __init__(self, root: str, *, max_records: int = 200,
                 queue_inflight: int = 12, submit_per_min: int = 20,
                 submit_window_s: int = 60, expiry_h: int = 24):
        self.root = root
        os.makedirs(self.root, exist_ok=True)
        self._lock = threading.Lock()      # single-process, serialised writes
        self._limit = max(1, int(max_records))
        self._inflight_cap = max(1, int(queue_inflight))
        self._submit_cap = max(1, int(submit_per_min))
        self._window = max(1, int(submit_window_s))
        self._expiry_s = max(1, int(expiry_h)) * 3600
        self._identity: Dict[str, List[float]] = {}

    # -- identity throttle (20/60s default ON, submit+status) --------------
    def gate_identity(self, identity: str) -> bool:
        """True = allowed. Pure-local sliding window (no account system)."""
        now = time.time()
        with self._lock:
            hits = [t for t in self._identity.get(identity, [])
                    if now - t < self._window]
            if len(hits) >= self._submit_cap:
                self._identity[identity] = hits
                return False
            hits.append(now)
            self._identity[identity] = hits
            return True

    # -- inflight queue gate (default ON) ---------------------------------
    def inflight(self) -> int:
        return sum(1 for r in self.all() if r.get("status") in NONTERMINAL)

    def gate_inflight(self) -> bool:
        """429 when the inflight queue is over cap. This rejection at the
        GATE is the 'no queue-drop on submit' counter."""
        with self._lock:
            return self.inflight() < self._inflight_cap

    # -- record CRUD -------------------------------------------------------
    def _path(self, ingest_id: str) -> str:
        return os.path.join(self.root, f"{ingest_id}.json")

    def get(self, ingest_id: str) -> Optional[Dict[str, Any]]:
        try:
            with open(self._path(ingest_id), "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError,
                ValueError):
            return None

    def all(self) -> List[Dict[str, Any]]:
        out = []
        for name in sorted(os.listdir(self.root)):
            if name.endswith(".json"):
                rec = self.get(name[:-5])
                if rec and isinstance(rec, dict) and "ingest_id" in rec:
                    out.append(rec)
        return out

    def sweep(self) -> None:
        """Prune expired records (expiry_h, default 24h) first, then the
        oldest until under the max-records cap (default 200). Pruned ids
        read as NOT_FOUND 404 afterwards (§16.3)."""
        with self._lock:
            self._sweep_locked()

    def _sweep_locked(self) -> None:
        now = time.time()
        recs = self.all()
        keep = []
        for rec in sorted(recs, key=lambda r: r.get("created_at", 0)):
            rid = rec.get("ingest_id")
            if not rid:
                continue
            if now - rec.get("created_at", 0) > self._expiry_s:
                try:
                    os.remove(self._path(rid))
                except FileNotFoundError:
                    pass
            else:
                keep.append(rec)
        while len(keep) > self._limit:
            rec = keep.pop(0)   # oldest-first under the cap
            rid = rec.get("ingest_id")
            if rid:
                try:
                    os.remove(self._path(rid))
                except FileNotFoundError:
                    pass

    def create(self, *, source_type: str, source_id: str,
               file_key: str = "", locale: str = "en",
               identity: str = "") -> Dict[str, Any]:
        rid = new_ingest_id()
        rec = {
            "ingest_id": f"{source_type}-{rid}",
            "source_type": source_type,
            "source_id": source_id,          # never None ("" allowed)
            "file_key": file_key or None,
            "locale": locale or "en",
            "status": "PENDING",
            "stage": None,                   # current/last stage name
            "error": None,                   # flat C8 body when terminal-error
            "attempts": [],                  # per stage, default-on §16.5
            "transcript": None,
            "transcript_truncated": False,
            "recipe_draft": None,
            "created_at": time.time(),
            "done_at": None,
            "identity": identity,            # internal throttle hint only
        }
        self.sweep()                     # lock-free: sweep takes its own
        with self._lock:
            with open(self._path(rec["ingest_id"]), "w",
                      encoding="utf-8") as fh:
                json.dump(rec, fh, ensure_ascii=False)
        return rec

    def set(self, ingest_id: str, **fields: Any) -> None:
        rec = self.get(ingest_id)
        if rec is None:
            return
        rec.update(fields)
        with self._lock:
            with open(self._path(ingest_id), "w", encoding="utf-8") as fh:
                json.dump(rec, fh, ensure_ascii=False)
