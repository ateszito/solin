"""Video upload and URL downloader service (yt-dlp + ffmpeg) for recipes."""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import uuid
from typing import Dict, Optional, Any

from ..inventory.media import media_root

logger = logging.getLogger("uvicorn.error")


def _get_videos_dir() -> str:
    vdir = os.path.join(media_root(), "videos")
    os.makedirs(vdir, exist_ok=True)
    return vdir


def _generate_thumbnail(video_path: str, thumb_path: str) -> bool:
    """Extract a frame at 1s using ffmpeg if available."""
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        return False
    try:
        cmd = [
            ffmpeg_bin,
            "-y",
            "-ss", "00:00:01",
            "-i", video_path,
            "-vframes", "1",
            "-q:v", "2",
            thumb_path,
        ]
        res = subprocess.run(cmd, capture_output=True, timeout=15)
        return res.returncode == 0 and os.path.exists(thumb_path)
    except Exception as e:
        logger.warning("Failed to generate video thumbnail: %s", e)
        return False


def _remux_to_web_mp4(src_path: str, dst_path: str) -> bool:
    """Remux/transcode video to web-optimized MP4 (H.264 / AAC with faststart)."""
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        return False
    try:
        cmd = [
            ffmpeg_bin,
            "-y",
            "-i", src_path,
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            dst_path,
        ]
        res = subprocess.run(cmd, capture_output=True, timeout=120)
        return res.returncode == 0 and os.path.exists(dst_path)
    except Exception as e:
        logger.warning("Failed to remux video with ffmpeg: %s", e)
        return False


def save_uploaded_video(
    file_bytes: bytes,
    original_filename: str,
    recipe_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Save an uploaded video file, converting to MP4 if needed, and generating a poster thumbnail."""
    if not file_bytes:
        raise ValueError("Empty video file.")

    ext = os.path.splitext(original_filename)[1].lower() or ".mp4"
    if ext not in [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"]:
        raise ValueError(f"Unsupported video format: {ext}")

    token = (recipe_id or uuid.uuid4().hex[:8]).replace("-", "_")
    unique_name = f"rec_{token}_{uuid.uuid4().hex[:6]}"
    vdir = _get_videos_dir()

    raw_path = os.path.join(vdir, f"{unique_name}_raw{ext}")
    final_mp4_name = f"{unique_name}.mp4"
    final_mp4_path = os.path.join(vdir, final_mp4_name)
    thumb_name = f"{unique_name}_thumb.jpg"
    thumb_path = os.path.join(vdir, thumb_name)

    with open(raw_path, "wb") as f:
        f.write(file_bytes)

    # Convert/remux to faststart MP4 if ffmpeg available
    converted = False
    if ext != ".mp4" or shutil.which("ffmpeg"):
        converted = _remux_to_web_mp4(raw_path, final_mp4_path)

    if not converted or not os.path.exists(final_mp4_path):
        # Fallback: rename raw to final
        os.replace(raw_path, final_mp4_path)
    else:
        # Clean up temporary raw file
        try:
            if os.path.exists(raw_path):
                os.remove(raw_path)
        except Exception:
            pass

    has_thumb = _generate_thumbnail(final_mp4_path, thumb_path)

    return {
        "video_url": f"/api/v1/media/videos/{final_mp4_name}",
        "filename": final_mp4_name,
        "thumbnail_url": f"/api/v1/media/videos/{thumb_name}" if has_thumb else None,
        "size_bytes": os.path.getsize(final_mp4_path),
    }


def download_video_from_url(
    url: str,
    recipe_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Download video from Instagram, TikTok, YouTube Shorts, etc. using yt-dlp."""
    if not url or not url.strip():
        raise ValueError("URL is required.")

    clean_url = url.strip()
    token = (recipe_id or uuid.uuid4().hex[:8]).replace("-", "_")
    unique_name = f"rec_{token}_{uuid.uuid4().hex[:6]}"
    vdir = _get_videos_dir()
    out_tmpl = os.path.join(vdir, f"{unique_name}.%(ext)s")

    try:
        import yt_dlp
    except ImportError:
        raise RuntimeError("yt-dlp is not installed on the system.")

    ydl_opts = {
        "outtmpl": out_tmpl,
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "merge_output_format": "mp4",
        "postprocessors": [{
            "key": "FFmpegVideoRemuxer",
            "preferedformat": "mp4",
        }] if shutil.which("ffmpeg") else [],
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(clean_url, download=True)
            target_fn = ydl.prepare_filename(info)
            if not target_fn.endswith(".mp4"):
                stem = os.path.splitext(target_fn)[0]
                if os.path.exists(f"{stem}.mp4"):
                    target_fn = f"{stem}.mp4"

            final_basename = os.path.basename(target_fn)
            final_path = os.path.join(vdir, final_basename)

            # Generate thumbnail
            thumb_name = f"{os.path.splitext(final_basename)[0]}_thumb.jpg"
            thumb_path = os.path.join(vdir, thumb_name)
            has_thumb = _generate_thumbnail(final_path, thumb_path)

            return {
                "video_url": f"/api/v1/media/videos/{final_basename}",
                "filename": final_basename,
                "thumbnail_url": f"/api/v1/media/videos/{thumb_name}" if has_thumb else (info.get("thumbnail")),
                "title": info.get("title"),
                "duration": info.get("duration"),
                "creator": info.get("uploader") or info.get("channel"),
                "size_bytes": os.path.getsize(final_path) if os.path.exists(final_path) else None,
            }
    except Exception as e:
        logger.exception("yt-dlp download failed for %s: %s", clean_url, e)
        raise RuntimeError(f"Nem sikerült letölteni a videót a linkről: {str(e)}")
