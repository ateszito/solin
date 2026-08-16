-- ============================================================
-- Solin Recipe Platform — PostgreSQL Schema
-- ============================================================
-- This script creates the recipes table with full-text search,
-- GIN indexes for tags/cuisine/dietary search, and seed data
-- for the 2 starter TikTok videos.
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create the recipes table
CREATE TABLE IF NOT EXISTS recipes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    video_url       VARCHAR(500),
    transcript_url  VARCHAR(500),
    creator         VARCHAR(255) DEFAULT 'unknown',
    creator_source  VARCHAR(500),
    servings        INTEGER DEFAULT 1,
    prep_time_min   INTEGER,
    cook_time_min   INTEGER,
    total_time_min  INTEGER,
    difficulty      VARCHAR(20) CHECK (difficulty IN ('easy', 'medium', 'hard')),
    rating          NUMERIC(3,1) CHECK (rating BETWEEN 0 AND 10),
    cuisine         VARCHAR(100),
    tags            TEXT[],
    dietary_info    TEXT[],
    ingredients     JSONB,
    steps           JSONB,
    nutrition       JSONB,
    images          JSONB[],
    status          VARCHAR(20) DEFAULT 'draft',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for fast search
CREATE INDEX idx_recipes_tags ON recipes USING GIN (tags);
CREATE INDEX idx_recipes_cuisine ON recipes USING GIN (cuisine);
CREATE INDEX idx_recipes_status ON recipes (status);
CREATE INDEX idx_recipes_nutrition ON recipes USING GIN (nutrition);
CREATE INDEX idx_recipes_title_tsv ON recipes USING GIN (to_tsvector('simple', title));

-- Seed data — starter TikTok videos

-- Video 1: Javítom magam - Chicken & Sausage Pasta
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
    'Diétás Boljognyai - Diet Pasta',
    'Diet-friendly pasta with chicken breast, sausage, onions, cream, spinach, and parmesan. High protein, great taste!',
    '~/Documents/VideoContent/video2.mp4',
    '~/Documents/VideoContent/video2_transcript.txt',
    'iamvargacsaba',
    'https://vm.tiktok.com/ZN88s6bGY',
    5,
    10,
    20,
    30,
    'easy',
    9.9,
    'hungarian',
    ARRAY['highprotein', 'diet', 'chicken', 'pasta', 'sauce', 'quick'],
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
        {"number": 5, "instruction": "Add 160g cream (or rice cream) and a splash of water", "video_start": "00:35.120", "video_end": "00:37.880"},
        {"number": 6, "instruction": "Add 240g cooked pasta to the sauce", "video_start": "00:41.200", "video_end": "00:43.240"},
        {"number": 7, "instruction": "Add 80g spinach (optional but recommended)", "video_start": "00:46.08", "video_end": "00:48.960"},
        {"number": 8, "instruction": "Top with 40g grated parmesan and serve", "video_start": "00:49.000", "video_end": "00:51.200", "tips": "Best served fresh and hot!"}
    ]'::jsonb,
    'published'
);
