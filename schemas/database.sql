-- ============================================================
-- Solin Recipe Platform — PostgreSQL Schema
-- ============================================================
-- This script creates the recipes table with full-text search,
-- GIN indexes for tags/cuisine/dietary search, and seed data
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

-- NOTE: seed data lives in seed/common_seed.sql (all envs get the same
--       content, per the parity note); per-env overrides go in
--       seed/<env>_seed.sql. See the three-env blueprint section 9-step-6.
