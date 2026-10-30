"""Recipe photo extraction service using local Ollama Vision LLM.

Extracts complete recipe data (title, description, servings, macros,
ingredients, steps) from one or more photos (e.g. cookbooks, recipe cards).
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import urllib.request
import uuid
from typing import Any, Dict, List, Optional

from PIL import Image, ImageOps

logger = logging.getLogger(__name__)


def get_ollama_host() -> Optional[str]:
    """Find reachable Ollama API endpoint."""
    configured = os.environ.get("OLLAMA_HOST")
    candidates = []
    if configured:
        candidates.append(configured if configured.startswith("http") else f"http://{configured}")
    candidates.extend([
        "http://host.docker.internal:11434",
        "http://192.168.0.40:11434",
        "http://localhost:11434",
        "http://127.0.0.1:11434",
    ])
    for host in candidates:
        try:
            with urllib.request.urlopen(f"{host}/api/tags", timeout=1.5) as resp:
                if resp.status == 200:
                    return host
        except Exception:
            continue
    return None


def prepare_image(img_bytes: bytes, max_dim: int = 1000, quality: int = 80) -> tuple[str, str]:
    """Prepare image for Ollama Vision and return (b64_raw, data_url)."""
    orig = Image.open(io.BytesIO(img_bytes))
    orig = ImageOps.exif_transpose(orig)
    if orig.mode != "RGB":
        orig = orig.convert("RGB")

    w, h = orig.size
    if max(w, h) > max_dim:
        scale = max_dim / max(w, h)
        orig = orig.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    orig.save(buf, format="JPEG", quality=quality)
    raw_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    data_url = f"data:image/jpeg;base64,{raw_b64}"
    return raw_b64, data_url


def extract_recipe_from_images(
    images_bytes: List[bytes],
    target_lang: str = "auto",
    save_media: bool = True,
    media_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Extract structured recipe from one or multiple images using local Ollama Vision.

    Args:
        images_bytes: List of raw byte contents of the uploaded photos.
        target_lang: 'auto' (preserve text in image), 'hu' (Hungarian), or 'en' (English).
        save_media: Whether to save files to disk for static media serving.
        media_dir: Destination directory for media files.

    Returns:
        Structured recipe dictionary ready for frontend and backend consumption.
    """
    if not images_bytes:
        raise ValueError("At least one image is required for recipe extraction.")

    host = get_ollama_host()
    if not host:
        raise RuntimeError("Local Ollama Vision service is unreachable. Ensure Ollama is running.")

    model = os.environ.get("OLLAMA_VISION_MODEL") or os.environ.get("OLLAMA_MODEL") or "qwen3.5:9b"

    b64_images: List[str] = []
    data_urls: List[str] = []
    saved_urls: List[str] = []

    recipe_token = uuid.uuid4().hex[:10]

    for idx, b in enumerate(images_bytes):
        raw_b64, durl = prepare_image(b)
        b64_images.append(raw_b64)
        data_urls.append(durl)

        if save_media and media_dir:
            try:
                os.makedirs(media_dir, exist_ok=True)
                fn = f"recipe_{recipe_token}_{idx + 1}.jpg"
                fp = os.path.join(media_dir, fn)
                with open(fp, "wb") as f:
                    f.write(base64.b64decode(raw_b64))
                saved_urls.append(f"/media/recipes/{fn}")
            except Exception as e:
                logger.warning("Failed to save recipe image to disk: %s", e)

    lang_instruction = ""
    if target_lang == "hu":
        lang_instruction = "Translate recipe title, description, and instructions into Hungarian. Preserve original ingredient names where appropriate or translate cleanly.\n"
    elif target_lang == "en":
        lang_instruction = "Ensure recipe text is in English.\n"
    else:
        lang_instruction = "Preserve the original language printed in the recipe image(s) (e.g. English or Hungarian).\n"

    prompt = (
        f"You are an expert culinary AI. Analyze this recipe photo (or multiple photos if the recipe spans multiple pages/cards).\n"
        f"{lang_instruction}"
        "Extract every detail accurately into strict JSON format:\n"
        "- title: Clean recipe title (e.g. 'Creamy Garlic Chicken & Mashed Potatoes')\n"
        "- description: Short overview or teaser (1-2 sentences)\n"
        "- servings: Number of servings as integer (default to 1 if not stated)\n"
        "- servings_note: Notes on servings/portions if present (e.g. 'per serving - 4 total')\n"
        "- total_time_min: Total time in minutes (number or null)\n"
        "- prep_time_min: Preparation time in minutes (number or null)\n"
        "- cook_time_min: Cooking time in minutes (number or null)\n"
        "- difficulty: 'easy', 'medium', or 'hard'\n"
        "- cuisine: Cuisine style (e.g. 'american', 'italian', 'hungarian')\n"
        "- tags: Array of keyword tags (e.g. ['highprotein', 'chicken', 'dinner'])\n"
        "- dietary_info: Array of dietary tags (e.g. ['high-protein', 'low-carb'])\n"
        "- nutrition: Object with:\n"
        "    calories: kcal per serving (number or 0)\n"
        "    protein: grams protein per serving (number or 0)\n"
        "    carbs: grams carbs per serving (number or 0)\n"
        "    fat: grams fat per serving (number or 0)\n"
        "    fiber: grams fiber per serving (number or 0)\n"
        "    sugar: grams sugar per serving (number or 0)\n"
        "    sodium: mg sodium per serving (number or 0)\n"
        "- ingredients: Array of all ingredients in order, with objects:\n"
        "    name: Ingredient name (e.g. 'Blended Low Fat Cottage Cheese')\n"
        "    qty: Original quantity and unit as printed (e.g. '1.4KG', '300g', '1 Tsp')\n"
        "    amount: Numeric quantity parsed as float/int, or null\n"
        "    unit: Unit ('g', 'kg', 'tsp', 'tbsp', 'ml', 'cloves', 'pcs', etc.)\n"
        "    note: Note or brand specification (e.g. 'raw weight', 'minced', 'peeled and diced')\n"
        "- steps: Array of preparation and cooking instructions in order:\n"
        "    number: Step number (1, 2, 3...)\n"
        "    instruction: Full instruction text for this step verbatim\n\n"
        "STRICT REQUIREMENT: Do not include internal thoughts, preliminary explanations, or reasoning. Start directly with { and output ONLY the valid JSON object without markdown code fences."
    )

    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt, "images": b64_images}],
        "stream": True,
        "options": {"temperature": 0.1, "num_predict": 2500},
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{host}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    chunks: List[str] = []
    with urllib.request.urlopen(req, timeout=180) as resp:
        for raw_line in resp:
            if not raw_line:
                continue
            try:
                line_obj = json.loads(raw_line.decode("utf-8"))
                content = line_obj.get("message", {}).get("content", "")
                if content:
                    chunks.append(content)
                if line_obj.get("done"):
                    break
            except Exception:
                continue

    full_text = "".join(chunks).strip()
    m = re.search(r"\{.*\}", full_text, re.DOTALL)
    if not m:
        raise ValueError("Failed to parse JSON recipe from model response.")

    try:
        parsed = json.loads(m.group(0))
    except Exception as e:
        # Attempt fallback to repair minor json formatting
        sanitized = re.sub(r",\s*([\]}])", r"\1", m.group(0))
        parsed = json.loads(sanitized)

    # Normalize fields
    title = str(parsed.get("title") or "Új recept fotóból").strip()
    description = str(parsed.get("description") or "").strip()

    servings = 1
    try:
        servings = int(parsed.get("servings") or 1)
        if servings <= 0:
            servings = 1
    except (ValueError, TypeError):
        servings = 1

    servings_note = str(parsed.get("servings_note") or "")

    def to_opt_int(val: Any) -> Optional[int]:
        if val is None:
            return None
        try:
            v = int(val)
            return v if v > 0 else None
        except (ValueError, TypeError):
            return None

    total_min = to_opt_int(parsed.get("total_time_min"))
    prep_min = to_opt_int(parsed.get("prep_time_min"))
    cook_min = to_opt_int(parsed.get("cook_time_min"))
    if total_min is None and (prep_min is not None or cook_min is not None):
        total_min = (prep_min or 0) + (cook_min or 0)

    # Nutrition
    raw_nut = parsed.get("nutrition") or {}
    def parse_float(val: Any) -> float:
        if val is None:
            return 0.0
        try:
            return round(float(str(val).replace(",", ".").replace("g", "").replace("kcal", "").strip()), 2)
        except (ValueError, TypeError):
            return 0.0

    nut_cal = int(parse_float(raw_nut.get("calories") or parsed.get("calories")))
    nut_protein = parse_float(raw_nut.get("protein") or parsed.get("protein"))
    nut_carbs = parse_float(raw_nut.get("carbs") or parsed.get("carbs"))
    nut_fat = parse_float(raw_nut.get("fat") or parsed.get("fat"))
    nut_fiber = parse_float(raw_nut.get("fiber") or parsed.get("fiber"))
    nut_sugar = parse_float(raw_nut.get("sugar") or parsed.get("sugar"))
    nut_sodium = parse_float(raw_nut.get("sodium") or parsed.get("sodium"))

    # Also check if raw_nut was empty but macrosPerServing was provided
    if nut_cal == 0 and isinstance(parsed.get("macrosPerServing"), dict):
        mps = parsed["macrosPerServing"]
        nut_cal = int(parse_float(mps.get("kcal")))
        nut_protein = parse_float(mps.get("protein"))
        nut_carbs = parse_float(mps.get("carbs"))
        nut_fat = parse_float(mps.get("fat"))

    nutrition_dict = {
        "calories": nut_cal,
        "protein": nut_protein,
        "carbs": nut_carbs,
        "fat": nut_fat,
        "fiber": nut_fiber,
        "sugar": nut_sugar,
        "sodium": nut_sodium,
    }

    macros_per_serving = {
        "kcal": nut_cal,
        "protein": nut_protein,
        "carbs": nut_carbs,
        "fat": nut_fat,
    }

    # Ingredients normalization
    raw_ings = parsed.get("ingredients") or []
    ingredients: List[Dict[str, Any]] = []
    for raw_i in raw_ings:
        if isinstance(raw_i, str):
            ingredients.append({"name": raw_i.strip(), "qty": "", "note": ""})
            continue
        if not isinstance(raw_i, dict):
            continue
        iname = str(raw_i.get("name") or "").strip()
        if not iname:
            continue
        iqty = str(raw_i.get("qty") or "").strip()
        inote = str(raw_i.get("note") or "").strip()
        iamount = raw_i.get("amount")
        try:
            iamount = float(str(iamount).replace(",", ".")) if iamount is not None else None
        except (ValueError, TypeError):
            iamount = None
        iunit = str(raw_i.get("unit") or "").strip()

        if not iqty and iamount is not None:
            iqty = f"{iamount} {iunit}".strip()

        ingredients.append({
            "name": iname,
            "qty": iqty,
            "amount": iamount,
            "unit": iunit,
            "note": inote,
        })

    # Steps normalization
    raw_steps = parsed.get("steps") or []
    steps: List[Dict[str, Any]] = []
    for idx, raw_s in enumerate(raw_steps):
        if isinstance(raw_s, str):
            txt = raw_s.strip()
            if txt:
                steps.append({"number": idx + 1, "text": txt, "instruction": txt, "t": None})
            continue
        if not isinstance(raw_s, dict):
            continue
        txt = str(raw_s.get("instruction") or raw_s.get("text") or "").strip()
        if not txt:
            continue
        snum = raw_s.get("number") or (idx + 1)
        st = raw_s.get("t")
        try:
            st = float(st) if st is not None else None
        except (ValueError, TypeError):
            st = None
        steps.append({
            "number": int(snum),
            "text": txt,
            "instruction": txt,
            "t": st,
        })

    # Assemble images array
    # Primary images list contains saved URLs if available, otherwise data URLs
    images_list = []
    for i, durl in enumerate(data_urls):
        url = saved_urls[i] if i < len(saved_urls) else durl
        images_list.append({"url": url, "data_url": durl})

    primary_image = saved_urls[0] if saved_urls else (data_urls[0] if data_urls else None)

    return {
        "title": title,
        "title_hu": title if target_lang == "hu" else None,
        "description": description,
        "servings": servings,
        "servings_note": servings_note,
        "prep_time_min": prep_min,
        "cook_time_min": cook_min,
        "total_time_min": total_min,
        "difficulty": str(parsed.get("difficulty") or "easy"),
        "cuisine": str(parsed.get("cuisine") or "unknown"),
        "rating": 9.0,
        "tags": list(parsed.get("tags") or []),
        "dietary_info": list(parsed.get("dietary_info") or []),
        "nutrition": nutrition_dict,
        "macrosPerServing": macros_per_serving,
        "ingredients": ingredients,
        "steps": steps,
        "image": primary_image,
        "images": images_list,
        "data_urls": data_urls,
        "status": "draft",
    }
