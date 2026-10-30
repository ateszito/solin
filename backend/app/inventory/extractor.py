"""OCR and Nutrition/Ingredients Extraction Engine for Solin.

Extracts nutritional macros (C4 schema) and ingredients list from food packaging
images using server-side Pillow image preprocessing and Tesseract OCR with
Hungarian ('hun') and English ('eng') language models.
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageEnhance, ImageOps

# Find tesseract executable
TESSERACT_CMD = os.environ.get("TESSERACT_CMD") or shutil.which("tesseract") or "/usr/bin/tesseract"
if not os.path.exists(TESSERACT_CMD) and os.path.exists("/opt/homebrew/bin/tesseract"):
    TESSERACT_CMD = "/opt/homebrew/bin/tesseract"


def get_tesseract_languages() -> str:
    """Detect available languages in tesseract; preference is 'hun+eng', fallback to available."""
    try:
        proc = subprocess.run([TESSERACT_CMD, "--list-langs"], capture_output=True, text=True, timeout=3)
        langs = proc.stdout.lower()
        has_hun = "hun" in langs
        has_eng = "eng" in langs
        if has_hun and has_eng:
            return "hun+eng"
        if has_hun:
            return "hun"
        if has_eng:
            return "eng"
    except Exception:
        pass
    return "eng"


def preprocess_image(img_bytes: bytes) -> List[Image.Image]:
    """Generate preprocessed variations of the input image optimized for OCR."""
    orig = Image.open(io.BytesIO(img_bytes))
    orig = ImageOps.exif_transpose(orig)

    # Convert to RGB if needed
    if orig.mode != "RGB":
        orig = orig.convert("RGB")

    w, h = orig.size
    # Target character height optimization: ensure width is at least 1200px
    scale = max(1.0, min(3.0, 1800.0 / max(w, h)))
    new_w, new_h = int(w * scale), int(h * scale)

    # Variant 1: Enhanced Grayscale + Autocontrast + Sharpening
    gray = orig.convert("L").resize((new_w, new_h), Image.Resampling.LANCZOS)
    v1 = ImageOps.autocontrast(gray, cutoff=1)
    v1 = ImageEnhance.Sharpness(v1).enhance(1.8)

    # Variant 2: Adaptive Local Binarization (great for low contrast colored labels)
    # Simple high-contrast point binarization based on median luminance
    v2 = ImageOps.autocontrast(gray, cutoff=2)
    # Threshold around median
    fn = lambda p: 255 if p > 135 else 0
    v2 = v2.point(fn, mode="1")

    return [v1, v2]


def run_tesseract(img: Image.Image, lang: str = "hun+eng", psm: int = 6) -> str:
    """Run tesseract CLI on a PIL image and return recognized text."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png_bytes = buf.getvalue()

    cmd = [
        TESSERACT_CMD,
        "stdin",
        "stdout",
        "-l", lang,
        "--psm", str(psm),
    ]
    try:
        proc = subprocess.run(cmd, input=png_bytes, capture_output=True, timeout=12)
        return proc.stdout.decode("utf-8", errors="replace")
    except Exception as e:
        return ""


def clean_number(raw: str, max_val: float = 100.0) -> Optional[float]:
    """Parse a numeric string handling European comma decimals, dropped decimals,
    and OCR misreading of 'g' as '9' or dropped zero decimals."""
    if not raw:
        return None
    s = raw.strip().lower().replace("keal", "kcal").replace("kj", "kJ")
    # Handle dropped decimal point after leading 0: e.g. "02g" -> "0.2", "09g" -> "0.9"
    s = re.sub(r"\b0(\d)\s*(?:g|mg|9)?\b", r"0.\1", s)
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:g|mg|9)?", s)
    if not m:
        return None
    val_str = m.group(1).replace(",", ".")
    try:
        val = float(val_str)
    except ValueError:
        return None

    # Check if trailing '9' was OCR misread of 'g'
    if val > max_val and val_str.endswith("9") and "." not in val_str:
        try:
            trimmed = float(val_str[:-1])
            if trimmed <= max_val:
                val = trimmed
            elif trimmed <= max_val * 10:
                val = round(trimmed / 10.0, 2)
            elif trimmed <= max_val * 100:
                val = round(trimmed / 100.0, 2)
        except ValueError:
            pass

    # General dropped decimal recovery
    if val > max_val:
        if val <= max_val * 10:
            val = round(val / 10.0, 2)
        elif val <= max_val * 100:
            val = round(val / 100.0, 2)

    return val


def parse_macros(text: str) -> Dict[str, float]:
    """Parse nutrition macros from OCR text (Hungarian & English labels).

    Returns a dict with all 7 C4 keys:
    calories, protein, fat, carbs, fiber, sugar, sodium.
    """
    res = {
        "calories": 0.0,
        "protein": 0.0,
        "fat": 0.0,
        "carbs": 0.0,
        "fiber": 0.0,
        "sugar": 0.0,
        "sodium": 0.0,
    }
    found = set()

    lines = [line.strip() for line in text.splitlines() if line.strip()]

    # 1. Calories / Energy lookup
    # Look for explicit kcal first (supports 'kcal', 'keal', 'kalória')
    kcal_m = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:k[ce]al|kalória)", text, re.IGNORECASE)
    if kcal_m:
        val = clean_number(kcal_m.group(1), max_val=9999.0)
        if val is not None and val > 0:
            res["calories"] = val
            found.add("calories")

    # If no explicit kcal, check Energia / Energy lines (look for kJ / kcal patterns)
    if "calories" not in found:
        for idx, line in enumerate(lines):
            if re.search(r"(?:energia|energy)", line, re.IGNORECASE):
                # Pattern like: 1986 kJ/481 kcal or 2523kJ / 567 kcal
                dual_m = re.search(r"(?:(?:[0-9]+)\s*k\s*j\s*[/|\\]\s*)?([0-9]+)\s*k[ce]al", line, re.IGNORECASE)
                if dual_m:
                    res["calories"] = float(dual_m.group(1))
                    found.add("calories")
                    break
                # Lookahead next line if split
                if idx + 1 < len(lines):
                    next_l = lines[idx + 1]
                    dual_next = re.search(r"(?:(?:[0-9]+)\s*k\s*j\s*[/|\\]\s*)?([0-9]+)\s*k[ce]al", next_l, re.IGNORECASE)
                    if dual_next:
                        res["calories"] = float(dual_next.group(1))
                        found.add("calories")
                        break

    # 2. Sequential / Tabular Macro extraction
    macro_patterns = [
        ("fat", r"(?:amelyből\s+telített|telített|saturated)", False),  # skip saturated for main fat
        ("fat", r"(?:^|\b)(?:zsír|fat)(?!\s*sav|\s*acid)", True),
        ("sugar", r"(?:amelyből\s+cukrok|cukrok|sugars|cukor)", True),
        ("carbs", r"(?:szénhidrát|carbohydrate|carbs)(?!\s*amelyből|\s*of\s*which)", True),
        ("fiber", r"(?:rost|fiber|fibre|élelmi\s*rost)", True),
        ("protein", r"(?:fehérje|protein)", True),
        ("salt", r"(?:só|salt)(?!\s*sav)", True),
    ]

    for key, pattern, is_target in macro_patterns:
        if not is_target:
            continue
        target_key = "sodium" if key == "salt" else key
        if target_key in found:
            continue

        for idx, line in enumerate(lines):
            m_label = re.search(pattern, line, re.IGNORECASE)
            if not m_label:
                continue

            # If looking for main fat, make sure it's not saturated fat
            if key == "fat" and re.search(r"telített|saturated", line, re.IGNORECASE):
                continue
            if key == "carbs" and re.search(r"cukor|sugar", line, re.IGNORECASE):
                continue

            # Look for number in current line (after label)
            after = line[m_label.end():]
            num_m = re.search(r"(\d+(?:[.,]\d+)?\s*(?:g|mg|9)?)", after)
            max_v = 15.0 if key == "salt" else 100.0
            val = clean_number(num_m.group(1), max_val=max_v) if num_m else None

            # If not in same line, look in next line (two-column / wrapped layout)
            if val is None and idx + 1 < len(lines):
                next_l = lines[idx + 1]
                # Avoid taking next line if it is itself another label
                if not any(re.search(p, next_l, re.IGNORECASE) for _, p, t in macro_patterns if t):
                    next_num = re.search(r"^(\d+(?:[.,]\d+)?\s*(?:g|mg|9)?)", next_l)
                    if next_num:
                        val = clean_number(next_num.group(1), max_val=max_v)

            if val is not None:
                if key == "salt":
                    # Convert salt grams to sodium mg: salt_g * 400
                    res["sodium"] = round(val * 400.0, 2)
                    found.add("sodium")
                else:
                    res[key] = round(val, 2)
                    found.add(key)
                break

    return res


def parse_ingredients(text: str) -> Tuple[Optional[str], List[str]]:
    """Extract ingredients block and structured ingredients list from text."""
    if not text:
        return None, []

    # Look for start of ingredients section
    # Hungarian: Összetevők, Összetétel, Tartalom, Alapanyagok
    # English: Ingredients, Composition, Contains
    start_patterns = [
        r"(?:^|\n|\b)(?:összetevők|összetevő(?:k)?|összetétel|alapanyagok|tartalom)\s*[:\-–]?\s*",
        r"(?:^|\n|\b)(?:ingredients|composition|contains)\s*[:\-–]?\s*",
    ]

    start_idx = -1
    for p in start_patterns:
        m = re.search(p, text, re.IGNORECASE)
        if m:
            start_idx = m.end()
            break

    if start_idx == -1:
        return None, []

    sub = text[start_idx:].strip()

    # Look for end of ingredients section:
    # Common next sections: Tápérték, Minőségét megőrzi, Gyártja, Származási hely, Tárolás, Allergének, etc.
    end_patterns = [
        r"\n\s*(?:átlagos tápérték|tápérték|nutrition|minőségét megőrzi|best before)",
        r"\n\s*(?:gyártja|forgalmazza|származási hely|tárolás|nettó tömeg|net weight)",
        r"\n\s*(?:allergének|allergén információ|nyomokban tartalmazhat)",
        r"\n\s*\n",
    ]

    end_idx = len(sub)
    for p in end_patterns:
        m = re.search(p, sub, re.IGNORECASE)
        if m and m.start() < end_idx:
            end_idx = m.start()

    raw_block = sub[:end_idx].strip()
    # Clean up line breaks and multiple spaces
    cleaned = re.sub(r"\s+", " ", raw_block).strip(" .;:,–-")

    if not cleaned:
        return None, []

    # Split into structured items:
    # Split by comma or semicolon, but NOT if inside parentheses like "sertéshús (85%, víz, só)"
    items = []
    current: List[str] = []
    paren_depth = 0
    for char in cleaned:
        if char == "(":
            paren_depth += 1
        elif char == ")":
            paren_depth = max(0, paren_depth - 1)
        if (char == "," or char == ";") and paren_depth == 0:
            token = "".join(current).strip(" .")
            if token:
                items.append(token)
            current = []
        else:
            current.append(char)
    last_token = "".join(current).strip(" .")
    if last_token:
        items.append(last_token)

    return cleaned, items


def extract_from_image(img_bytes: bytes, target: str = "all") -> Dict[str, Any]:
    """Run full extraction pipeline on image bytes.

    target: 'all' | 'macros' | 'ingredients'
    Returns:
      {
        "macros": {...},
        "ingredients": str | None,
        "ingredients_list": List[str],
        "raw_text": str
      }
    """
    variants = preprocess_image(img_bytes)
    lang = get_tesseract_languages()

    combined_text = []

    # Run OCR on variants
    for var in variants:
        t_psm6 = run_tesseract(var, lang=lang, psm=6)
        t_psm4 = run_tesseract(var, lang=lang, psm=4)
        if t_psm6:
            combined_text.append(t_psm6)
        if t_psm4:
            combined_text.append(t_psm4)

    raw_text = "\n---\n".join(combined_text)

    # Macros parsing: test each OCR text block, select the one with most detected macros
    best_macros = {
        "calories": 0.0, "protein": 0.0, "fat": 0.0,
        "carbs": 0.0, "fiber": 0.0, "sugar": 0.0, "sodium": 0.0,
    }
    max_non_zero = -1

    for text in combined_text:
        m = parse_macros(text)
        non_zero = sum(1 for v in m.values() if v > 0)
        if non_zero > max_non_zero:
            max_non_zero = non_zero
            best_macros = m

    # Ingredients parsing
    ingredients_str, ingredients_list = None, []
    for text in combined_text:
        ing_s, ing_l = parse_ingredients(text)
        if ing_s and (not ingredients_str or len(ing_s) > len(ingredients_str)):
            ingredients_str = ing_s
            ingredients_list = ing_l

    return {
        "macros": best_macros,
        "ingredients": ingredients_str,
        "ingredients_list": ingredients_list,
        "raw_text": raw_text[:2000] if raw_text else "",
    }
