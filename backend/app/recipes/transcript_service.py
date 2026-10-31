"""Transcript extraction service for recipes.

Extracts spoken video transcripts using:
1. Direct subtitle/caption extraction from yt-dlp (TikTok / YouTube / Instagram VTT/SRT).
2. Local faster-whisper ASR fallback on the video audio if no subtitles are available.
"""
from __future__ import annotations

import glob
import logging
import os
import re
import urllib.request
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _time_str_to_seconds(t_str: str) -> int:
    """Convert '00:01:23.456' or '01:23,456' to integer seconds."""
    clean = t_str.replace(",", ".").strip()
    parts = clean.split(":")
    try:
        if len(parts) == 3:
            return int(float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2]))
        elif len(parts) == 2:
            return int(float(parts[0]) * 60 + float(parts[1]))
        return int(float(parts[0]))
    except Exception:
        return 0


def clean_vtt(vtt_str: str) -> str:
    """Parse WebVTT content into clean, timestamped text lines."""
    if not vtt_str or not vtt_str.strip():
        return ""

    cues = re.findall(
        r"(\d{1,2}:\d{2}(?::\d{2})?(?:[\.,]\d+)?)\s*-->\s*[\d:\.,]+\s*\n(.*?)(?=\n\s*\n|\n\d{1,2}:|\Z)",
        vtt_str,
        re.DOTALL,
    )
    lines: List[str] = []
    seen = set()

    for time_str, raw_text in cues:
        # Strip WebVTT formatting tags e.g. <c>, </c>, <v Speaker>
        text = re.sub(r"<[^>]+>", "", raw_text)
        text = text.replace("\r", " ").replace("\n", " ").strip()
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue

        sec = _time_str_to_seconds(time_str)
        # Deduplicate identical consecutive utterances
        norm_key = (sec // 2, text.lower())
        if norm_key in seen:
            continue
        seen.add(norm_key)

        lines.append(f"[{sec}s] {text}")

    return "\n".join(lines).strip()


def clean_srt(srt_str: str) -> str:
    """Parse SubRip (SRT) format into clean timestamped lines."""
    if not srt_str or not srt_str.strip():
        return ""

    blocks = re.split(r"\n\s*\n", srt_str.strip())
    lines: List[str] = []
    seen = set()

    for block in blocks:
        parts = block.strip().splitlines()
        if len(parts) >= 2:
            time_line = parts[1] if re.search(r"-->", parts[1]) else parts[0]
            m = re.search(r"(\d{1,2}:\d{2}(?::\d{2})?(?:[\.,]\d+)?)", time_line)
            if not m:
                continue
            sec = _time_str_to_seconds(m.group(1))
            text_lines = parts[2:] if time_line == parts[1] else parts[1:]
            raw_text = " ".join(text_lines).strip()
            text = re.sub(r"<[^>]+>", "", raw_text)
            text = re.sub(r"\s+", " ", text).strip()
            if not text:
                continue

            norm_key = (sec // 2, text.lower())
            if norm_key in seen:
                continue
            seen.add(norm_key)

            lines.append(f"[{sec}s] {text}")

    return "\n".join(lines).strip()


def find_and_parse_ytdlp_subtitles(info: Optional[Dict[str, Any]], video_path: str) -> Optional[str]:
    """Look for subtitles downloaded on disk or download them via subtitle URLs in info dict."""
    base_stem = os.path.splitext(video_path)[0]
    directory = os.path.dirname(video_path) or "."

    # 1. Check for files written to disk e.g. base_stem.*.vtt or base_stem.*.srt
    patterns = [
        f"{base_stem}.*.vtt",
        f"{base_stem}.*.srt",
        os.path.join(directory, f"*{os.path.basename(base_stem)}*.vtt"),
        os.path.join(directory, f"*{os.path.basename(base_stem)}*.srt"),
    ]
    for pat in patterns:
        matches = glob.glob(pat)
        # Sort so that preferred language (hu, en) comes first if present
        def lang_sort(fn: str) -> int:
            lfn = fn.lower()
            if "hu" in lfn:
                return 0
            if "en" in lfn:
                return 1
            return 2

        matches.sort(key=lang_sort)
        for fn in matches:
            try:
                with open(fn, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                cleaned = clean_vtt(content) if fn.endswith(".vtt") else clean_srt(content)
                if cleaned and len(cleaned) > 20:
                    logger.info("Loaded subtitles from disk: %s", fn)
                    return cleaned
            except Exception as e:
                logger.warning("Error reading subtitle file %s: %s", fn, e)

    # 2. Check info dict for subtitles / automatic_captions URLs
    if info:
        all_subs = {}
        if info.get("subtitles"):
            all_subs.update(info.get("subtitles") or {})
        if info.get("automatic_captions"):
            for k, v in (info.get("automatic_captions") or {}).items():
                if k not in all_subs:
                    all_subs[k] = v

        if all_subs:
            # Pick best language candidate
            preferred_keys = ["hun", "hu", "hun-HU", "eng", "en", "eng-US"]
            chosen_key = None
            for pk in preferred_keys:
                for k in all_subs:
                    if pk.lower() in k.lower():
                        chosen_key = k
                        break
                if chosen_key:
                    break
            if not chosen_key:
                chosen_key = next(iter(all_subs.keys()))

            sub_entries = all_subs.get(chosen_key) or []
            for entry in sub_entries:
                url = entry.get("url")
                ext = (entry.get("ext") or "vtt").lower()
                if not url:
                    continue
                try:
                    req = urllib.request.Request(
                        url,
                        headers={
                            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                        },
                    )
                    with urllib.request.urlopen(req, timeout=8) as resp:
                        content = resp.read().decode("utf-8", errors="ignore")
                    cleaned = clean_vtt(content) if ext == "vtt" else clean_srt(content)
                    if cleaned and len(cleaned) > 20:
                        logger.info("Downloaded subtitles via URL (%s): %d chars", chosen_key, len(cleaned))
                        return cleaned
                except Exception as e:
                    logger.warning("Failed to fetch subtitle from %s: %s", url, e)

    return None


def transcribe_audio_with_whisper(video_path: str, model_size: str = "tiny") -> Optional[str]:
    """Fallback local audio transcription using faster-whisper."""
    if not video_path or not os.path.exists(video_path):
        return None

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        logger.warning("faster-whisper is not installed; skipping ASR audio transcription.")
        return None

    # Persistent download directory in Docker volume or user cache
    download_root = "/srv/data/models" if os.path.isdir("/srv/data") else os.path.expanduser("~/.cache/solin_models")
    os.makedirs(download_root, exist_ok=True)

    try:
        logger.info("Running faster-whisper (%s) on %s...", model_size, video_path)
        model = WhisperModel(model_size, device="cpu", compute_type="int8", download_root=download_root)
        segments, info = model.transcribe(video_path, beam_size=1)
        lines: List[str] = []
        for segment in segments:
            text = segment.text.strip()
            if text:
                lines.append(f"[{int(segment.start)}s] {text}")
        res = "\n".join(lines).strip()
        if res:
            logger.info("Whisper transcribed %d lines (language: %s)", len(lines), getattr(info, "language", "unknown"))
            return res
    except Exception as e:
        logger.warning("faster-whisper transcription failed for %s: %s", video_path, e)

    return None


def extract_video_transcript(video_path: str, ytdlp_info: Optional[Dict[str, Any]] = None) -> str:
    """Extract transcript from video using subtitles or local whisper ASR."""
    # 1. Fast subtitle extraction (sub-second)
    sub = find_and_parse_ytdlp_subtitles(ytdlp_info, video_path)
    if sub and sub.strip():
        return sub.strip()

    # 2. Local Whisper ASR fallback
    asr = transcribe_audio_with_whisper(video_path, model_size="tiny")
    if asr and asr.strip():
        return asr.strip()

    return ""
