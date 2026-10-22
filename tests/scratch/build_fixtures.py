"""Build QA fixtures for the §15 suite (t_b8c1daed re-anchor of t_fd20d685).

§15.4 harness caveat: the pre-§15 fixtures were STALE INPUTS — the 11 MB
"big.jpg" sat UNDER the new P1 gate (25 MiB) and, with junk bytes, died at
the SNIFF gate (415) instead of the 413 gate. F-413 needs a body strictly
ABOVE SOLIN_IMG_MAX_UPLOAD_BYTES whose magic bytes stay JPEG-plausible, so
the size gate — not the sniff — short-circuits.
"""
import os

OUT = "/tmp/qa_fixtures"
os.makedirs(OUT, exist_ok=True)

# F-413: > the 25 MiB P1 gate (default SOLIN_IMG_MAX_UPLOAD_BYTES).
with open(os.path.join(OUT, "big_413.jpg"), "wb") as f:
    f.write(b"\xff\xd8\xff\xe0" + b"\x00" * (26 * 1024 * 1024))

# F-2: text bytes shipped as image/jpeg must fail the sniff gate (415).
with open(os.path.join(OUT, "notes.txt"), "wb") as f:
    f.write(b"hello, I am a plain text file, definitely not an image\n")

# F-passthrough: valid JPEG-shaped body UNDER the 300 KiB target — stored
# byte-identical (P5), content-type stays image/jpeg (no decode attempt).
with open(os.path.join(OUT, "small_200.jpg"), "wb") as f:
    f.write(b"\xff\xd8\xff\xe0" + b"\x11" * (180 * 1024))

# F-phone (approx.): synthetic photo-like JPEG ~8 MB via Pillow if present,
# else a JPEG-magic body sized INTO the P1 gate for the 413-vs-200 split.
try:
    import io, random
    from PIL import Image
    rng = random.Random(19711010)
    data = bytes(rng.getrandbits(8) for _ in range(4032 * 3024 * 3))
    img = Image.frombytes("RGB", (4032, 3024), data)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=95)
    blob = buf.getvalue()
except Exception:
    blob = b"\xff\xd8\xff\xe0" + b"\x00" * (8 * 1024 * 1024)
with open(os.path.join(OUT, "phone_200.jpg"), "wb") as f:
    f.write(blob)

for n in ("big_413.jpg", "notes.txt", "small_200.jpg", "phone_200.jpg"):
    p = os.path.join(OUT, n)
    print(n, os.path.getsize(p), "bytes")
