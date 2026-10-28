"""Worker chain (contract §16.5/§16.6) — "worker input", never a scraper.

One attempt chain per record, no auto-requeue (no wait-slot): every
chain records ONE honest terminal attempt. There is NO default provider
and NOTHING seeded here (§16.9 V-7 "§16 seeds NOTHING"):

* kind `url`          — only queued when SOLIN_URL_FETCH=on; the chain
                        terminates HONESTLY at RESOLVE_FAILED_EXTRACTOR:
                        no yt-dlp/scraper/OAuth ships in v1 (A1) and we
                        never fabricate fetch results. Default OFF means
                        URL submits never even queue (403 in api.py).
* kind `transcript`   — manual paste (path B/C): parsed directly.
* kind `file_submit`  — file uploaded inside the ingest-data root
                        (path B). Sidecar .srt/.vtt/.txt counts as the
                        transcript; audio/video with SOLIN_INGEST_ASR_CMD
                        configured runs that operator command (never a
                        default provider); anything else terminates
                        honestly (FILE_UNAVAILABLE / RESOLVE_FAILED_*).

seed_cluster (default empty/OFF): an empty trigger name means "worker
input", NOT an auto-fallback chain; a configured name must resolve in
the operator's seed_clusters.json file (none ships in code).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

# ---- seed-cluster gate (§16.6 "COUNTERS default empty OFF") --------------

def seed_cluster(name: str = "") -> str:
    """Return configured seed cluster name or empty string if unset."""
    return (name or "").strip()


def cluster_rules(name: str, data_root: str = "") -> Optional[List[str]]:
    """Operator-file lookup ONLY. Empty/missing/unlisted → None (honest
    worker-input chain). The table is data, never seeded by §16."""
    name = (name or "").strip()
    if not name:
        return None
    path = os.path.join(data_root or ".", "seed_clusters.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            table = json.load(fh)
        rules = table.get(name)
        return list(rules) if isinstance(rules, list) else None
    except (OSError, ValueError):
        return None


# ---- transcript helpers ---------------------------------------------------

_SIDECAR = (".srt", ".vtt", ".txt")


def strip_vtt(raw: str) -> str:
    """Crude caption-to-speech strip: timestamps + cue headers gone."""
    lines = []
    for ln in raw.splitlines():
        s = ln.strip()
        if (not s or s.isdigit() or "-->" in s
                or s.lower().startswith(("webvtt", "{\\"))):
            continue
        s = re.sub(r"<[^>]+>", "", s).strip()
        if s:
            lines.append(s)
    return "\n".join(lines)


def parse_ingredients(text: str) -> List[Dict[str, Any]]:
    """Draft parser for the v1 chain: 'qty unit name' lines (HU units
    included). Max 40 rows. Injected app_services may override later —
    never fabricates: unparsable lines yield NO rows."""
    rows: List[Dict[str, Any]] = []
    line_re = re.compile(
        r"^\s*([0-9]+(?:[.,][0-9]+)?)\s*"
        r"(g|kg|ml|dl|l|db|darab|spuri|so|csipet|gerezd|pcs|dl)\s+"
        r"(.+?)\s*$", re.IGNORECASE)
    for raw in (text or "").splitlines():
        m = line_re.match(raw)
        if not m:
            continue
        rows.append({"name": m.group(3).strip(),
                     "amount": float(m.group(1).replace(",", ".")),
                     "unit": (m.group(2) or "pcs").lower(),
                     "prep": "", "order": len(rows) + 1})
        if len(rows) >= 40:
            break
    return rows


def parse_steps(text: str) -> List[Dict[str, Any]]:
    steps: List[Dict[str, Any]] = []
    step_re = re.compile(r"^\s*(?:step\s*)?(\d{1,2})[.)]\s+(.+)$",
                         re.IGNORECASE)
    for raw in (text or "").splitlines():
        m = step_re.match(raw)
        if m:
            steps.append({"number": int(m.group(1)),
                          "instruction": m.group(2).strip()[:600]})
        if len(steps) >= 40:
            break
    return steps


def first_line(text: str) -> str:
    for ln in (text or "").splitlines():
        s = ln.strip()
        if s and not re.match(r"^\s*\d", s):
            return s[:280]
    return ""


# ---- the worker -----------------------------------------------------------

class IngestWorker(threading.Thread):
    """Background chain runner (default 2 threads, max 4). Polls the flat
    store, claims PENDING records (once per id per process — no
    auto-requeue, no queue-drop later)."""

    def __init__(self, store, cfg: Dict[str, Any], worker_id: int = 0) -> None:
        super().__init__(daemon=True, name=f"ingest-worker-{worker_id}")
        self.store = store
        self.cfg = cfg
        self._stop = threading.Event()
        self._seen: set = set()

    def run(self) -> None:
        interval = float(self.cfg.get("poll_s", 5))
        poll_wait = min(1.0, interval)
        while not self._stop.is_set():
            busy = False
            for rec in list(self.store.all()):
                rid = rec.get("ingest_id")
                if (rec.get("status") == "PENDING" and rid
                        and rid not in self._seen):
                    self._seen.add(rid)
                    busy = True
                    try:
                        self._chain(rid)
                    except Exception as exc:            # honest ERROR
                        self._fail(rid, "EXTRACT", "EXTRACT_FAILED",
                                   f"worker chain crashed: {exc!r}"[:200])
            if self._stop.wait(0.05 if busy else poll_wait):
                break

    def stop(self) -> None:
        self._stop.set()

    # -- helpers -----------------------------------------------------------
    def _attempt(self, rid, stage, status, detail=""):
        rec = self.store.get(rid)
        if rec is None:
            return None
        rec["attempts"] = rec.get("attempts", []) + [
            {"stage": stage, "status": status, "detail": detail,
             "at": time.time()}]
        return rec

    def _fail(self, rid, stage, status, detail):
        """Terminal-error end: status block carries {code, message} (C8)."""
        rec = self._attempt(rid, stage, status, detail)
        if rec is not None:
            self.store.set(rid, status=status, stage=stage, done_at=time.time(),
                           error={"code": status, "message": detail[:280]},
                           attempts=rec["attempts"])

    def _ok(self, rid, status, stage="EXTRACT"):
        rec = self._attempt(rid, stage, status)
        if rec is not None:
            self.store.set(rid, status=status, stage=stage,
                           done_at=time.time(), error=None,
                           attempts=rec["attempts"])

    # -- one chain per record ----------------------------------------------
    def _chain(self, rid: str) -> None:
        rec = self.store.get(rid)
        if rec is None or rec.get("status") != "PENDING":
            return
        self.store.set(rid, stage="RESOLVE")

        # 0) seed_cluster gate: default empty = worker input (honest
        #    chain). A configured name with no operator table is an honest
        #    terminal — an empty trigger never becomes an auto-fallback.
        cluster = (self.cfg.get("seed_cluster") or "").strip()
        if cluster and cluster_rules(cluster,
                                      self.cfg.get("data_root", "")) is None:
            self._fail(rid, "RESOLVE", "RESOLVE_FAILED_NO_CHAIN",
                       f"seed_cluster '{cluster}' configured but no "
                       "operator table ships (§16.9 V-7 seeds NOTHING)")
            return

        kind = rec.get("source_type")
        sid = rec.get("source_id") or ""

        # 1) URL kind — default-OFF never queues; flag-ON terminates
        #    honestly. No extractor ships in v1, no fabricated result.
        if kind == "url":
            self._fail(rid, "RESOLVE", "RESOLVE_FAILED_EXTRACTOR",
                       "URL auto-fetch chain has no extractor in v1 "
                       "(A1: no yt-dlp/scraper ships; this record only "
                       "proves the flag path queues honestly)")
            return

        # 2) transcript acquisition (stage TRANSCRIBING)
        if kind == "transcript":
            text = sid[: self.cfg.get("max_chars", 200_000)]
            trigger = "manual"
        elif kind == "file_submit":
            path = self._resolve_file(rec.get("file_key") or "")
            if path is None:
                # private/missing-video branch: file gone, never uploaded
                # into the ingest-data root, or past its expiry window.
                self._fail(rid, "RESOLVE", "TRIGGER_BLOCKED",
                           "uploaded source file missing or past its "
                           "expiry window (§16.2 R2): not in the "
                           "ingest-data root")
                return
            trigger = "file_submit"
            ext = os.path.splitext(path)[1].lower()
            if ext in _SIDECAR:
                try:
                    with open(path, "r", encoding="utf-8",
                              errors="replace") as fh:
                        text = fh.read(self.cfg.get("max_chars", 200_000))
                    if ext in (".srt", ".vtt"):
                        text = strip_vtt(text)
                except OSError as exc:
                    self._fail(rid, "TRANSCRIBE", "FILE_UNAVAILABLE",
                               f"source file unreadable: {exc!r}"[:200])
                    return
            else:
                asr = (self.cfg.get("asr_cmd") or "").strip()
                if not asr:
                    self._fail(rid, "TRANSCRIBE",
                               "RESOLVE_FAILED_EXTRACTOR",
                               "no transcript provider configured "
                               "(SOLIN_INGEST_ASR_CMD empty = v1 default); "
                               "no server-side ASR ships (§16.5)")
                    return
                text = self._run_asr(asr, path, rid)
        else:
            self._fail(rid, "RESOLVE", "RESOLVE_FAILED_NO_CHAIN",
                       f"unknown source kind {kind!r} reached the worker")
            return

        truncated = len(text) > self.cfg.get("max_chars", 200_000)
        text = text[: self.cfg.get("max_chars", 200_000)]
        if not text.strip():
            # resolved-but-no-usable-speech branch (422 reuse, §6)
            self._fail(rid, "TRANSCRIBE", "TRANSCRIBED_EMPTY",
                       f"{trigger}: source yielded no usable speech or "
                       "on-screen text")
            return
        self.store.set(rid, stage="EXTRACT", transcript=text,
                       transcript_truncated=truncated)

        # 3) EXTRACT stage → draft (or honest ingredient failure)
        ing = parse_ingredients(text)
        if not ing:
            self._fail(rid, "EXTRACT", "EXTRACT_FAILED",
                       "no ingredient line parsed (not a recipe-shaped "
                       "source, or parser adapter off)")
            return
        steps = parse_steps(text)
        trust = self.cfg.get("min_confidence", 0.55)
        doc = {
            "title": (first_line(text) or f"Draft {rid}")[:120],
            "description": first_line(text),
            "video_url": "",                      # §16.2 R2: never mint
            "transcript_url": None,               # a URL from source bytes
            "servings": 1,
            "ingredients": ing,
            "steps": steps,
            "nutrition": {"calories": 0},
            "status": "draft",
            "ingest": {"ingest_id": rid, "source_type": kind},
        }
        draft = {"recipe_json": doc, "trust": round(trust, 2)}
        status = "LOW_CONFIDENCE" if trust < self.cfg.get(
            "trust_threshold", 0.55) else "OK"
        self.store.set(rid, recipe_draft=draft)
        self._ok(rid, status)

    # -- plumbing ----------------------------------------------------------
    def _resolve_file(self, file_key: str) -> Optional[str]:
        """Containment-checked lookup inside the ingest-data root.
        Anything escaping the root or missing → None (FILE_UNAVAILABLE)."""
        root = os.path.realpath(self.cfg.get("data_root", ""))
        if not file_key or not root:
            return None
        path = os.path.realpath(os.path.join(root, file_key))
        if not (path == root or path.startswith(root + os.sep)):
            return None                          # traversal attempt
        return path if os.path.isfile(path) else None

    def _run_asr(self, asr_cmd: str, path: str, rid: str) -> str:
        """Operator-provided transcript command (never a default). The
        placeholder {path} carries the source file; stdout is the
        transcript. Empty/failed output is recorded honestly."""
        cmd = shlex.split(asr_cmd.replace("{path}", path))
        try:
            out = subprocess.run(
                cmd, capture_output=True, text=True,
                timeout=self.cfg.get("block_timeout_s", 180),
                shell=False, check=False)
            if out.returncode != 0:
                self._fail(rid, "TRANSCRIBE", "RESOLVE_FAILED_EXTRACTOR",
                           f"ASR provider command exited "
                           f"{out.returncode}: {out.stderr[:120]!r}")
                return ""
            return out.stdout or ""
        except subprocess.TimeoutExpired:
            self._fail(rid, "TRANSCRIBE", "TRANSCRIBED_EMPTY",
                       "ASR provider command timed out "
                       "(SOLIN_WORKER_BLOCK_TIMEOUT_S)")
            return ""
        except OSError as exc:
            self._fail(rid, "TRANSCRIBE", "RESOLVE_FAILED_EXTRACTOR",
                       f"ASR provider command failed: {exc!r}"[:200])
            return ""
