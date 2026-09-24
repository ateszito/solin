-- ============================================================
-- Solin — INVENTORY SEED (contract use_cases.md §5.1 / §7)
--
-- Canonical P1–P4 products for the worked-example macro reference
-- (use_cases.md §5.3) and the QA end-to-end suite (t_06d48239).
-- Values are NORMATIVE — do not edit without re-running §5.3.
--
-- The machine-readable source of truth is backend/app/inventory/
-- seed_data.py; tests (test_seed_sql_matches_seed_data) enforce parity.
-- Image slots for P1/P2 point at the seed image files the service
-- writes under <MEDIA_ROOT>/inventory/<id>/<slot>/ at seed time.
-- ============================================================

-- P1 — Chicken breast (cross-currency USD/EUR price pair, two image slots)
INSERT INTO inventory (
    id, name, brand, base_unit, serving_size, serving_label,
    macros_per_100, prices, images, created_at, updated_at
) VALUES (
    'p1',
    'Chicken breast',
    'Oyala',
    'g',
    150.0,
    '1 piece',
    '{"calories": 165.0, "protein": 31.0, "fat": 3.6, "carbs": 0.0, "fiber": 0.0, "sugar": 0.0, "sodium": 74.0}',
    '[
      {"id": "pr1", "amount": 2.99, "currency": "USD", "pack_size": 400.0, "source": "home", "captured_at": "2026-09-22T00:00:00Z"},
      {"id": "pr2", "amount": 3.49, "currency": "EUR", "pack_size": 500.0, "source": "Lidl", "captured_at": "2026-09-22T00:00:00Z"}
    ]',
    '{"product_photo": {"url": "/media/inventory/p1/product_photo/seed.jpg", "filename": "seed.jpg", "mime_type": "image/jpeg", "byte_size": 314, "original_name": "chicken-breast.jpg", "uploaded_at": "2026-09-22T00:00:00Z"}, "label_photo": {"url": "/media/inventory/p1/label_photo/seed.png", "filename": "seed.png", "mime_type": "image/png", "byte_size": 73, "original_name": "chicken-label.png", "uploaded_at": "2026-09-22T00:00:00Z"}}',
    '2026-09-22T00:00:00Z',
    '2026-09-22T00:00:00Z'
);

-- P2 — Basmati rice (single USD price, two image slots)
INSERT INTO inventory (
    id, name, brand, base_unit, serving_size, serving_label,
    macros_per_100, prices, images, created_at, updated_at
) VALUES (
    'p2',
    'Basmati rice',
    'TastyTime',
    'g',
    NULL,
    NULL,
    '{"calories": 349.0, "protein": 7.9, "fat": 0.9, "carbs": 78.8, "fiber": 2.1, "sugar": 0.1, "sodium": 2.0}',
    '[
      {"id": "pr3", "amount": 5.49, "currency": "USD", "pack_size": 1000.0, "source": "home", "captured_at": "2026-09-22T00:00:00Z"}
    ]',
    '{"product_photo": {"url": "/media/inventory/p2/product_photo/seed.jpg", "filename": "seed.jpg", "mime_type": "image/jpeg", "byte_size": 314, "original_name": "rice.jpg", "uploaded_at": "2026-09-22T00:00:00Z"}, "label_photo": {"url": "/media/inventory/p2/label_photo/seed.png", "filename": "seed.png", "mime_type": "image/png", "byte_size": 73, "original_name": "rice-label.png", "uploaded_at": "2026-09-22T00:00:00Z"}}',
    '2026-09-22T00:00:00Z',
    '2026-09-22T00:00:00Z'
);

-- P3 — Vegetable oil (zero-price case: QA "no prices" branch)
INSERT INTO inventory (
    id, name, brand, base_unit, serving_size, serving_label,
    macros_per_100, prices, images, created_at, updated_at
) VALUES (
    'p3',
    'Vegetable oil',
    NULL,
    'ml',
    NULL,
    NULL,
    '{"calories": 884.0, "protein": 0.0, "fat": 100.0, "carbs": 0.0, "fiber": 0.0, "sugar": 0.0, "sodium": 0.0}',
    '[]',
    '{"product_photo": NULL, "label_photo": NULL}',
    '2026-09-22T00:00:00Z',
    '2026-09-22T00:00:00Z'
);

-- P4 — Zero-calorie sparkling water (QA "zero calories" branch)
INSERT INTO inventory (
    id, name, brand, base_unit, serving_size, serving_label,
    macros_per_100, prices, images, created_at, updated_at
) VALUES (
    'p4',
    'Sparkling water',
    'AquaPure',
    'ml',
    330.0,
    '1 can (330 ml)',
    '{"calories": 0.0, "protein": 0.0, "fat": 0.0, "carbs": 0.0, "fiber": 0.0, "sugar": 0.0, "sodium": 10.0}',
    '[]',
    '{"product_photo": NULL, "label_photo": NULL}',
    '2026-09-22T00:00:00Z',
    '2026-09-22T00:00:00Z'
);
