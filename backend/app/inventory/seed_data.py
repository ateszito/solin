"""Canonical inventory seed (contract §5.1 / §7).

This dict is the machine-readable source of truth for the seed data. The
human/DB-facing ``seed/inventory_seed.sql`` is kept in sync by hand, and
``tests/test_inventory_unit.py`` (test_seed_sql_matches_seed_data) enforces
the parity so the two can never drift silently.

Products P1–P4 are the canonical worked-example fixtures from use_cases.md
§5.1. P1 and P2 carry two image slots; the seed images are generated
(genuine 1×1 JPEG / PNG bytes) under ``<MEDIA_ROOT>/inventory/<id>/<slot>/``
so the §7 acceptance ("GET <image.url> returns the declared content-type
and a non-empty body") is reproducible end-to-end.
"""

# ---- generated image bytes -------------------------------------------------

#: A real, minimal 1x1 white JPEG (baseline). 126 bytes — enough for a
#: content sniff + a non-empty response body.
SEED_JPEG_BYTES = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000"
    "ffdb004300080606070605080707070909080a0c"
    "140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20"
    "242e2720222c231c1c2837292c30313434341f27"
    "393d38323c2e333432ffc0000b08000100010101"
    "1100ffc4001f0000010501010101010100000000"
    "000000000102030405060708090a0bffc400b510"
    "0002010303020403050504040000017d01020300"
    "041105122131410607225132611342718191a1b1"
    "c152d1f023334362728292a0838b1c2d2e2f1424"
    "345363738393a4445464748494a545556575859"
    "5a6465666768696a7475767778797a84858687"
    "88898a9495969798999aa4a5a6a7a8a9aab4b5"
    "b6b7b8b9bac4c5c6c7c8c9cad4d5d6d7d8d9da"
    "e1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9"
    "fa"
    "ffda0008010100003f00fbfa28a2803ffd9"
)

#: A real, minimal 1x1 white PNG (IHDR + IDAT + IEND, valid CRCs).
SEED_PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001"
    "0000000108060000001f15c4890000000d494441"
    "54789c626001000000ffff03000006000557bf"
    "c4c00000000049454e44ae426082"
)

#: Extension + mime per format (used when writing seed image files).
SEED_JPEG = {"bytes": SEED_JPEG_BYTES, "ext": "jpg", "mime": "image/jpeg"}
SEED_PNG = {"bytes": SEED_PNG_BYTES, "ext": "png", "mime": "image/png"}


def seed_products() -> list[dict]:
    """The P1–P4 product documents (contract §5.1), idempotent seed ids.

    Image slots reference the *seed* images the service layer writes on
    ``seed_inventory()`` — the URLs use the canonical
    ``/media/inventory/<id>/<slot>/<name>`` namespace (contract C7/§2).
    Timestamps are fixed so the store file is diffable.
    """
    ts = "2026-09-22T00:00:00Z"
    return [
        {
            # P1 — Chicken breast (cross-currency price pair: USD vs EUR)
            "id": "p1",
            "name": "Chicken breast",
            "brand": "Oyala",
            "base_unit": "g",
            "serving_size": 150.0,
            "serving_label": "1 piece",
            "macros_per_100": {
                "calories": 165.0, "protein": 31.0, "fat": 3.6,
                "carbs": 0.0, "fiber": 0.0, "sugar": 0.0, "sodium": 74.0,
            },
            "prices": [
                {"id": "pr1", "amount": 2.99, "currency": "USD",
                 "pack_size": 400.0, "source": "home", "captured_at": ts},
                {"id": "pr2", "amount": 3.49, "currency": "EUR",
                 "pack_size": 500.0, "source": "Lidl", "captured_at": ts},
            ],
            "images": {
                "product_photo": {
                    "url": "/media/inventory/p1/product_photo/seed.jpg",
                    "filename": "seed.jpg", "mime_type": "image/jpeg",
                    "byte_size": len(SEED_JPEG_BYTES),
                    "original_name": "chicken-breast.jpg",
                    "uploaded_at": ts,
                },
                "label_photo": {
                    "url": "/media/inventory/p1/label_photo/seed.png",
                    "filename": "seed.png", "mime_type": "image/png",
                    "byte_size": len(SEED_PNG_BYTES),
                    "original_name": "chicken-label.png",
                    "uploaded_at": ts,
                },
            },
            "created_at": ts,
            "updated_at": ts,
        },
        {
            # P2 — Basmati rice (single USD price)
            "id": "p2",
            "name": "Basmati rice",
            "brand": "TastyTime",
            "base_unit": "g",
            "serving_size": None,
            "serving_label": None,
            "macros_per_100": {
                "calories": 349.0, "protein": 7.9, "fat": 0.9,
                "carbs": 78.8, "fiber": 2.1, "sugar": 0.1, "sodium": 2.0,
            },
            "prices": [
                {"id": "pr3", "amount": 5.49, "currency": "USD",
                 "pack_size": 1000.0, "source": "home", "captured_at": ts},
            ],
            "images": {
                "product_photo": {
                    "url": "/media/inventory/p2/product_photo/seed.jpg",
                    "filename": "seed.jpg", "mime_type": "image/jpeg",
                    "byte_size": len(SEED_JPEG_BYTES),
                    "original_name": "rice.jpg",
                    "uploaded_at": ts,
                },
                "label_photo": {
                    "url": "/media/inventory/p2/label_photo/seed.png",
                    "filename": "seed.png", "mime_type": "image/png",
                    "byte_size": len(SEED_PNG_BYTES),
                    "original_name": "rice-label.png",
                    "uploaded_at": ts,
                },
            },
            "created_at": ts,
            "updated_at": ts,
        },
        {
            # P3 — Vegetable oil (zero-price case for the QA "no prices" branch)
            "id": "p3",
            "name": "Vegetable oil",
            "brand": None,
            "base_unit": "ml",
            "serving_size": None,
            "serving_label": None,
            "macros_per_100": {
                "calories": 884.0, "protein": 0.0, "fat": 100.0,
                "carbs": 0.0, "fiber": 0.0, "sugar": 0.0, "sodium": 0.0,
            },
            "prices": [],
            "images": {"product_photo": None, "label_photo": None},
            "created_at": ts,
            "updated_at": ts,
        },
        {
            # P4 — Zero-calorie sparkling water (QA "zero calories" branch)
            "id": "p4",
            "name": "Sparkling water",
            "brand": "AquaPure",
            "base_unit": "ml",
            "serving_size": 330.0,
            "serving_label": "1 can (330 ml)",
            "macros_per_100": {
                "calories": 0.0, "protein": 0.0, "fat": 0.0,
                "carbs": 0.0, "fiber": 0.0, "sugar": 0.0, "sodium": 10.0,
            },
            "prices": [],
            "images": {"product_photo": None, "label_photo": None},
            "created_at": ts,
            "updated_at": ts,
        },
    ]
