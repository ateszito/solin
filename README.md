Solin — Recipe Platform

> Mobile-first recipe platform combining video tutorials with structured recipe data. ☆(◕‿◕)~ ♪

## Overview

Solin is a recipe platform designed around video-first cooking tutorials. Every recipe has structured ingredients, macros (calories, protein, carbs, fat), step-by-step instructions synced to video timestamps, and an interactive mobile-first UI.

## Project Structure

```
Solin/
├── README.md              ← you are here
├── .gitignore
├── docs/
│   ├── ARCHITECTURE_PLAN.md
│   ├── use-cases/
│   │   └── TIKTOK_STUDIO_RECIPES.md
│   ├── ENVIRONMENTS.md
│   └── DEV_ENVIRONMENT.md
├── schemas/
│   ├── recipe.schema.json (full JSON Schema)
│   └── database.sql (PostgreSQL + seed data)
├── design/
│   ├── ui_design_specs.md (mobile-first design system)
│   └── prototypes/
│       └── mobile-recipe-ui.html (interactive prototype)
├── components/
│   ├── VideoPlayer/
│   │   ├── VideoPlayer.jsx (React component)
│   │   └── VideoPlayer.css
│   └── index.js
├── tests/
├── backend/
├── frontend/
├── database/
├── notebooks/
├── scripts/
└── config/
```

## Key Files (quick links)

- Architecture: docs/ARCHITECTURE_PLAN.md
- Database schema: schemas/database.sql
- Data model: schemas/recipe.schema.json
- UI design: design/ui_design_specs.md
- Interactive prototype: design/prototypes/mobile-recipe-ui.html
- Video player component: components/VideoPlayer/VideoPlayer.jsx
- Use cases + test scenarios: docs/use-cases/TIKTOK_STUDIO_RECIPES.md
- Dev & Prod setup: docs/DEV_ENVIRONMENT.md

## Starter Videos

From iamvargacsaba's TikTok (https://vm.tiktok.com/ZN88s6bGY):
1. "Javítom magam" — Chicken & Sausage Pasta (850 kcal/serving, ★9.9)
2. "Diétás Boljognyai" — Diet Pasta (same recipe, video2.mp4)

## Getting Started

### 1. Setup Database
bash
cd ~/Documents/Solin
createdb solin_dev
psql solin_dev < schemas/database.sql
psql solin_dev -c "SELECT title, rating FROM recipes;"

### 2. Backend
cd ~/Documents/Solin/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

### 3. Frontend
cd ~/Documents/Solin/frontend
npm init
npm install react react-dom
npm run dev

### 4. Prototype
bash
open design/prototypes/mobile-recipe-ui.html

## Architecture

- Frontend: React Native (Expo) + Next.js
- Backend: FastAPI + PostgreSQL
- CDN: Cloudflare R2 for video
- Search: PostgreSQL GIN indexes
- Auth: Clerk / Supabase Auth
- Deploy: Fly.io (API) + Vercel (Web)

## Design System

- Primary: #FF6B6B
- Secondary: #2D3436
- Mobile-first: 320px+
- Responsive: mobile → tablet → desktop

## API

| Method | Endpoint | Description |
|--------|--|--|
| GET | /api/v1/recipes | List recipes |
| GET | /api/v1/recipes/{id} | Get recipe |
| POST | /api/v1/recipes | Create recipe |
| GET | /api/v1/search?q=QUERY | Search recipes |
| POST | /api/v1/videos/upload | Upload video |
