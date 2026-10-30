"""Recipe video extractor service.

Extracts structured recipe data (title, description, servings, macros,
ingredients, steps) from downloaded video info and descriptions using
Ollama LLM (with robust regex fallback if Ollama is unavailable).
"""
from __future__ import annotations

import json
import logging
import re
import urllib.request
from typing import Any, Dict, List, Optional

from .photo_extractor import get_ollama_host

logger = logging.getLogger(__name__)


def _extract_via_regex(title: str, creator: str, description: str) -> Dict[str, Any]:
    """Fallback parser using regex heuristics on the video title & description."""
    text = f"{title}\n\n{description}".strip()

    # 1. Macros / Nutrition
    kcal_match = re.search(r"(\d+)\s*(?:kcal|kalória|calories?)\b", text, re.IGNORECASE)
    prot_match = re.search(r"(\d+(?:\.\d+)?)\s*g?\s*(?:protein|fehérje)\b", text, re.IGNORECASE) or re.search(r"(?:protein|fehérje)[:\s]+(\d+(?:\.\d+)?)\s*g?", text, re.IGNORECASE)
    carb_match = re.search(r"(\d+(?:\.\d+)?)\s*g?\s*(?:carbs?|szénhidrát)\b", text, re.IGNORECASE) or re.search(r"(?:carbs?|szénhidrát)[:\s]+(\d+(?:\.\d+)?)\s*g?", text, re.IGNORECASE)
    fat_match = re.search(r"(\d+(?:\.\d+)?)\s*g?\s*(?:fat|zsír)\b", text, re.IGNORECASE) or re.search(r"(?:fat|zsír)[:\s]+(\d+(?:\.\d+)?)\s*g?", text, re.IGNORECASE)

    macros = {
        "calories": float(kcal_match.group(1)) if kcal_match else 0,
        "protein": float(prot_match.group(1)) if prot_match else 0,
        "carbs": float(carb_match.group(1)) if carb_match else 0,
        "fat": float(fat_match.group(1)) if fat_match else 0,
    }

    # 2. Servings
    serv_match = re.search(r"(\d+)\s*(?:servings?|adag|portions?|total\s*servings?)\b", text, re.IGNORECASE) or re.search(r"(?:makes|adag|serves)[:\s]+(\d+)", text, re.IGNORECASE)
    servings = int(serv_match.group(1)) if serv_match else 1

    # 3. Clean Title
    clean_title = title.split("|")[0].split("#")[0].strip()
    if not clean_title or len(clean_title) < 3:
        clean_title = "Videó recept"

    # 4. Ingredients & Steps heuristic
    lines = [line.strip() for line in description.splitlines() if line.strip()]
    ingredients: List[Dict[str, Any]] = []
    steps: List[Dict[str, Any]] = []

    ing_unit_pattern = re.compile(
        r"\b(?:\d+[\d\./\s]*(?:g|kg|ml|l|dl|cl|tsp|tbsp|tk|ek|cup|cups|oz|lb|slices?|szelet|gerezd|cloves?|pcs|db|can|cans))\b",
        re.IGNORECASE,
    )

    in_ingredients = False
    in_steps = False

    for line in lines:
        lower = line.lower()
        if any(h in lower for h in ["ingredient", "hozzávaló", "what you need", "recipe:"]):
            in_ingredients = True
            in_steps = False
            continue
        if any(h in lower for h in ["instruction", "direction", "method", "elkészítés", "lépések", "how to make"]):
            in_ingredients = False
            in_steps = True
            continue

        # Check for hashtag line (skip)
        if line.startswith("#") and len(line.split()) > 2 and all(w.startswith("#") for w in line.split()):
            continue

        # Bullet or numbered
        cleaned_line = re.sub(r"^[\s*•\-–—\d\.\)]+\s*", "", line).strip()
        if not cleaned_line:
            continue

        step_match = re.match(r"^(\d+)[\.\)]\s*(.+)", line)
        if step_match:
            steps.append({
                "number": len(steps) + 1,
                "instruction": step_match.group(2).strip(),
                "t": 0,
            })
        elif in_ingredients or ing_unit_pattern.search(line):
            # Parse ingredient quantity and name
            qty_match = ing_unit_pattern.search(line)
            if qty_match:
                qty = qty_match.group(0).strip()
                name = line.replace(qty, "").strip(" -•–:,").strip()
            else:
                qty = ""
                name = cleaned_line

            if name:
                ingredients.append({
                    "name": name,
                    "qty": qty,
                    "note": "",
                })
        elif in_steps or len(cleaned_line) > 35:
            steps.append({
                "number": len(steps) + 1,
                "instruction": cleaned_line,
                "t": 0,
            })

    return {
        "title": clean_title,
        "description": description[:300].strip(),
        "servings": servings,
        "total_time_min": None,
        "cuisine": "unknown",
        "tags": [t.strip("#").strip() for t in re.findall(r"#\w+", text)],
        "dietary_info": [],
        "nutrition": macros,
        "ingredients": ingredients,
        "steps": steps,
    }


def extract_recipe_from_video_info(video_info: Dict[str, Any], target_lang: str = "auto") -> Dict[str, Any]:
    """Extract complete structured recipe from video information and caption/description."""
    title = str(video_info.get("title") or "").strip()
    creator = str(video_info.get("creator") or "").strip()
    description = str(video_info.get("description") or "").strip()
    video_url = video_info.get("video_url") or ""
    thumbnail_url = video_info.get("thumbnail_url") or ""

    host = get_ollama_host()
    parsed = None

    if host and (description or title):
        try:
            import os
            model = os.environ.get("OLLAMA_MODEL") or "qwen3.5:9b"
            lang_instruction = ""
            if target_lang == "hu":
                lang_instruction = "Translate recipe title, ingredients, and instructions into Hungarian.\n"
            elif target_lang == "en":
                lang_instruction = "Ensure all extracted fields are in English.\n"

            prompt = (
                f"You are an expert culinary AI. A user downloaded a cooking video recipe.\n"
                f"Video Title: {title}\n"
                f"Creator: {creator}\n"
                f"Caption / Description:\n{description}\n\n"
                f"{lang_instruction}"
                "Extract every detail accurately into strict JSON format:\n"
                "- title: Clean, attractive recipe title\n"
                "- description: Summary or teaser (1-2 sentences)\n"
                "- servings: Number of servings as integer (e.g. 1, 2, 4, default 1)\n"
                "- total_time_min: Total time in minutes (number or null)\n"
                "- cuisine: Cuisine style (e.g. 'american', 'italian', 'mexican')\n"
                "- tags: Array of keyword tags (e.g. ['highprotein', 'pizza'])\n"
                "- dietary_info: Array of dietary tags (e.g. ['high-protein', 'low-carb'])\n"
                "- nutrition: Object with calories, protein, carbs, fat per serving (all numbers)\n"
                "- ingredients: Array of objects with name, qty, note\n"
                "- steps: Array of objects with number, instruction, t (video timestamp in seconds or 0)\n\n"
                "STRICT REQUIREMENT: Output ONLY the valid JSON object starting with { and ending with }. No code fences."
            )

            payload = json.dumps({
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "think": False,
                "options": {"temperature": 0.1, "num_predict": 2500},
            }).encode("utf-8")

            req = urllib.request.Request(
                f"{host}/api/chat",
                data=payload,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp_data = json.loads(resp.read().decode("utf-8"))
                content = resp_data.get("message", {}).get("content", "").strip()
                m = re.search(r"\{.*\}", content, re.DOTALL)
                if m:
                    parsed = json.loads(m.group(0))
        except Exception as e:
            logger.warning("Ollama text recipe extraction failed: %s — falling back to regex parser", e)
            parsed = None

    if not parsed:
        parsed = _extract_via_regex(title, creator, description)

    nutrition = parsed.get("nutrition") or {}

    images = [thumbnail_url] if thumbnail_url else []

    return {
        "title": str(parsed.get("title") or title or "Új recept videóból").strip(),
        "description": str(parsed.get("description") or description or "").strip(),
        "creator": creator or str(parsed.get("creator") or ""),
        "source": video_info.get("source") or "",
        "servings": int(parsed.get("servings") or 1),
        "total_time_min": parsed.get("total_time_min"),
        "cuisine": str(parsed.get("cuisine") or "unknown").strip().lower(),
        "tags": parsed.get("tags") or [],
        "dietary": parsed.get("dietary_info") or [],
        "video": video_url,
        "video_url": video_url,
        "image": thumbnail_url or None,
        "images": images,
        "macrosPerServing": {
            "kcal": nutrition.get("calories"),
            "protein": nutrition.get("protein"),
            "carbs": nutrition.get("carbs"),
            "fat": nutrition.get("fat"),
        },
        "ingredients": [
            {
                "name": str(i.get("name") or "").strip(),
                "qty": str(i.get("qty") or "").strip(),
                "note": str(i.get("note") or "").strip(),
            }
            for i in (parsed.get("ingredients") or [])
            if str(i.get("name") or "").strip()
        ],
        "steps": [
            {
                "t": float(s.get("t") or 0),
                "instruction": str(s.get("instruction") or s.get("text") or "").strip(),
            }
            for s in (parsed.get("steps") or [])
            if str(s.get("instruction") or s.get("text") or "").strip()
        ],
    }
