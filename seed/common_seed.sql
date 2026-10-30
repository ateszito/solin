-- ============================================================
-- Solin — COMMON SEED (runs on first boot in ALL THREE envs)
-- Identical content per env (parity smoke-test requirement, blueprint
-- sec9 step 6). Invoked by Postgres initdb via
-- docker-entrypoint-initdb.d after schemas/database.sql creates tables.
-- ============================================================

INSERT INTO recipes (
    title,
    description,
    video_url,
    transcript_url,
    creator,
    creator_source,
    servings,
    prep_time_min,
    cook_time_min,
    total_time_min,
    difficulty,
    rating,
    cuisine,
    tags,
    dietary_info,
    nutrition,
    ingredients,
    steps,
    status
) VALUES (
    'Javítom magam - Chicken & Sausage Pasta',
    'High-protein chicken and sausage pasta dish — a delicious dinner that hits all the macros! 9.9/10 rating by the creator.',
    '~/Documents/VideoContent/video1.mp4',
    '~/Documents/VideoContent/video1_transcript.txt',
    'iamvargacsaba',
    'https://vm.tiktok.com/ZN88s6bGY',
    5,
    10,
    20,
    30,
    'easy',
    9.9,
    'hungarian',
    ARRAY['highprotein', 'quick', 'dinner', 'chicken', 'pasta', 'sauce'],
    ARRAY['high-protein'],
    '{
        "calories": 850,
        "protein": 45.2,
        "carbs": 48.0,
        "fat": 28.5,
        "fiber": 3.2,
        "sugar": 8.0,
        "sodium": 920
    }'::jsonb,
    '[
        {"name": "red onion", "amount": 200, "unit": "g", "prep": "chopped", "order": 1},
        {"name": "sausage", "amount": 50, "unit": "g", "prep": "diced", "order": 2},
        {"name": "chicken breast", "amount": 650, "unit": "g", "prep": "diced", "order": 3},
        {"name": "salt", "amount": 1, "unit": "pinch", "prep": "iodized", "order": 4},
        {"name": "chili", "amount": 1, "unit": "dash", "prep": "to taste", "order": 5},
        {"name": "smoked paprika", "amount": 1, "unit": "tsp", "prep": "", "order": 6},
        {"name": "black pepper", "amount": 1, "unit": "pinch", "prep": "freshly ground", "order": 7},
        {"name": "garlic", "amount": 3, "unit": "cloves", "prep": "minced", "order": 8},
        {"name": "tomato paste", "amount": 3, "unit": "tbsp", "prep": "", "order": 9},
        {"name": "cream or rice cream", "amount": 160, "unit": "g", "prep": "", "order": 10},
        {"name": "pasta", "amount": 240, "unit": "g", "prep": "cooked", "order": 11},
        {"name": "spinach", "amount": 80, "unit": "g", "prep": "optional", "order": 12},
        {"name": "parmesan", "amount": 40, "unit": "g", "prep": "grated", "order": 13}
    ]'::jsonb,
    '[
        {"number": 1, "instruction": "Chop 200g red onion and add to bowl, then add 50g diced sausage", "video_start": "00:06.720", "video_end": "00:11.600", "temperature": "medium heat"},
        {"number": 2, "instruction": "Dice 650g chicken breast and add to the pan", "video_start": "00:11.800", "video_end": "00:15.600"},
        {"number": 3, "instruction": "Season with iodized salt, chili, smoked paprika, black pepper, and minced garlic", "video_start": "00:20.200", "video_end": "00:25.760"},
        {"number": 4, "instruction": "Once the meat is cooked, add 3 tbsp tomato paste", "video_start": "00:31.840", "video_end": "00:34.960"},
        {"number": 5, "instruction": "Add 160g cream (or rice cream) and a splash of water", "video_start": "00:35.100", "video_end": "00:37.880"},
        {"number": 6, "instruction": "Add 240g cooked pasta to the sauce", "video_start": "00:41.200", "video_end": "00:43.240"},
        {"number": 7, "instruction": "Add 80g spinach (optional but recommended)", "video_start": "00:46.08", "video_end": "00:48.960"},
        {"number": 8, "instruction": "Top with 40g grated parmesan and serve", "video_start": "00:49.000", "video_end": "00:51.200", "tips": "Best served fresh and hot!"}
    ]'::jsonb,
    'published'
);




-- Video 2: Diétás Boljognyai — Diet Pasta (same recipe, different video)
INSERT INTO recipes (
    title,
    description,
    video_url,
    transcript_url,
    creator,
    creator_source,
    servings,
    prep_time_min,
    cook_time_min,
    total_time_min,
    difficulty,
    rating,
    cuisine,
    tags,
    dietary_info,
    nutrition,
    ingredients,
    steps,
    status
) VALUES (
    'Diétás Bolognai - Diet Bolognese',
    'High-protein diet-friendly bolognese with lean ground turkey, onions, carrots, celery, tomato passata, and light mozzarella.',
    '~/Documents/VideoContent/video2.mp4',
    '~/Documents/VideoContent/video2_transcript.txt',
    'iamvargacsaba',
    'https://vm.tiktok.com/ZN88s6bGY',
    4,
    10,
    25,
    35,
    'easy',
    9.2,
    'italian',
    ARRAY['highprotein', 'diet', 'turkey', 'pasta', 'bolognese', 'quick'],
    ARRAY['high-protein'],
    '{
        "calories": 488,
        "protein": 50.0,
        "carbs": 52.0,
        "fat": 9.0,
        "fiber": 4.5,
        "sugar": 7.0,
        "sodium": 780
    }'::jsonb,
    '[
        {"name": "cooking oil", "amount": 3, "unit": "g", "prep": "", "order": 1},
        {"name": "onion", "amount": 150, "unit": "g", "prep": "chopped", "order": 2},
        {"name": "carrots", "amount": 200, "unit": "g", "prep": "finely chopped or grated", "order": 3},
        {"name": "celery", "amount": 200, "unit": "g", "prep": "finely chopped or grated", "order": 4},
        {"name": "lean ground turkey", "amount": 500, "unit": "g", "prep": "", "order": 5},
        {"name": "tomato passata", "amount": 700, "unit": "g", "prep": "", "order": 6},
        {"name": "salt", "amount": 1, "unit": "pinch", "prep": "to taste", "order": 7},
        {"name": "black pepper", "amount": 1, "unit": "pinch", "prep": "to taste", "order": 8},
        {"name": "garlic", "amount": 2, "unit": "cloves", "prep": "minced or powdered", "order": 9},
        {"name": "pasta", "amount": 4, "unit": "servings", "prep": "cooked", "order": 10},
        {"name": "light shredded mozzarella", "amount": 60, "unit": "g", "prep": "15g per serving", "order": 11}
    ]'::jsonb,
    '[
        {"number": 1, "instruction": "Heat 3g oil in a pan and saute the chopped onion until translucent", "video_start": "00:07.240", "video_end": "00:12.760"},
        {"number": 2, "instruction": "Add 200g chopped carrots and 200g celery to the pan", "video_start": "00:15.500", "video_end": "00:18.840"},
        {"number": 3, "instruction": "Add 500g lean ground turkey and brown thoroughly", "video_start": "00:24.160", "video_end": "00:31.220"},
        {"number": 4, "instruction": "Pour in 700g tomato passata", "video_start": "00:31.220", "video_end": "00:33.220"},
        {"number": 5, "instruction": "Season with salt, black pepper, and garlic to taste", "video_start": "00:33.220", "video_end": "00:37.800"},
        {"number": 6, "instruction": "Let the bolognese simmer and thicken", "video_start": "00:52.340", "video_end": "00:54.640"},
        {"number": 7, "instruction": "Mix with cooked pasta and divide equally into 4 servings", "video_start": "00:54.640", "video_end": "01:00.320"},
        {"number": 8, "instruction": "Top each serving with 15g light grated mozzarella and serve (9.2/10)", "video_start": "01:00.320", "video_end": "01:05.920"}
    ]'::jsonb,
    'published'
);

