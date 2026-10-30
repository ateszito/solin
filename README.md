Solin — Recipe Platform

> Mobile-first recipe platform combining video tutorials with structured recipe data. ☆(◕‿◕)~ ♪

## Overview

Solin is a Hungarian, video-first recipe app built around TikTok cooking videos. Every recipe has structured ingredients, macros (calories, protein, carbs, fat), and step-by-step instructions synced to video timestamps.

### Features

- **Browse & search** — recipe cards with lazy-loaded video previews, full-text search, tag filters; scroll position is kept when returning from a recipe.
- **Recipe detail** — video player with timestamped steps, ingredient checklist (persisted per recipe, with "Pipák törlése" + undo), substitutes from pantry and seed suggestions.
- **Cooking mode** — follow-along steps, keeps the screen awake (Wake Lock) while cooking.
- **Portion scaling** — client + `/api/v1/recipes/{id}/scale` with HALF_UP rounding.
- **Pantry matching** — "mit főzzek?" scoring of recipes against what you have at home.
- **Product pairing & macros** — pair ingredients with real inventory products, count real macros, per-portion values and total cost; quick-select and custom ("egyéb hozzávaló") items.
- **Food counter** — product inventory with nutrition details.
- **Add / edit recipes** — from a TikTok/Instagram link (ingestion pipeline, feature-flagged) or from scratch; unsaved new drafts are discarded automatically.
- **Light / dark theme** — follows the system setting; WCAG AA contrast palette.
- **Environments** — dev / staging / prod, Cloudflare Access credentials kept in session storage on the web unless "Megjegyzés ezen az eszközön" is ticked.

## Project Structure

```
solin/
├── app/                  ← the shipped frontend (vanilla JS SPA, no build step)
│   ├── index.html, styles.css
│   ├── core.js           routing (hash), tabs, history/back, toasts
│   ├── state.js          localStorage store (recipes, pantry, checks…)
│   ├── data.js           seed recipes
│   ├── browse.js, detail.js, edit.js, add.js, ingest.js, match.js
│   ├── pairing.js, pairing_ui.js, quickpick.js, fcapi.js, invsync.js
│   ├── foodcounter.js, inventory.js, scale.js, config.js
│   └── tests/            Node specs (npm run test:frontend)
├── backend/app/          FastAPI (recipes, scale, ingestion, inventory)
├── ios/                  Capacitor iOS shell
├── schemas/              recipe.schema.json, database.sql
├── seed/                 SQL seeds per environment
├── design/, docs/        design specs, architecture & environment docs
├── components/           legacy React VideoPlayer prototype (unused by app/)
├── scripts/              dev server, mobile env switch, CI/deploy
└── tests/                pytest suites for the backend
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
The app is plain HTML/CSS/JS — no build step:

```bash
cd app && python3 -m http.server 8765
# open http://127.0.0.1:8765
npm run test:frontend      # Node specs
```

iOS (Capacitor): `npm run cap:dev` (or `cap:staging` / `cap:prod`), then `npm run cap:sync && npm run cap:open`.

### 4. Prototype
bashvanilla JS single-page app (`app/`), hash routing, localStorage persistence
- Mobile: Capacitor 8 (iOS) wrapping the same `app/` bundle
- Backend: FastAPI (+ PostgreSQL schema in `schemas/database.sql`)
- Edge: Cloudflare (Access service tokens, `*.ateszito.com`)
- Deploy: Docker (`Dockerfile`, `Dockerfile.api`, `docker-compose.yml`), see DEPLOY.mdt.js
- Backend: FastAPI + PostgreSQL
- CDN: Cloudflare R2 for video
- Search: PostgreSQL GIN indexes
- Auth: Clerk / Supabase Auth
- Deploy: Fly.io (API) + Vercel (Web)

## Cloudflare (domain creation)

Cloudflare integration is **enabled**. The credentials are stored in
`.env` (root, gitignored) — do not hardcode them in source. Reference
these env vars from any code/script that talks to the Cloudflare API:

- `CLOUDFLARE_API_TOKEN` — verified active (2026-08-26 via
  `/client/v4/user/tokens/verify`)
- `CLOUDFLARE_ACCOUNT_ID` — account `8c4c2d3d…`
- `CLOUDFLARE_ZONE_ID` — zone `ateszito.com`

For the full production template (R2, Redis), see `docs/ENVIRONMENTS.md`.

## Design System

- Primary: #FF6B6B
- Secondary`#D63A3A` (text/buttons, AA contrast), accent `#FF6B6B`
- Dark mode via `prefers-color-scheme` (tokens in `app/styles.css`)
- Mobile-first: 320px+
- Responsive: mobile → tablet → desktop

## API

| Method | Endpoint | Description |
|--------|--|--|
| GET | /api/v1/recipes | List recipes |
| GET | /api/v1/recipes/search?q=QUERY | Search recipes |
| GET | /api/v1/recipes/trending | Trending recipes |
| GET | /api/v1/recipes/{id} | Get recipe |
| POST | /api/v1/recipes | Create recipe |
| DELETE | /api/v1/recipes/{id} | Delete recipe |
| POST | /api/v1/recipes/{id}/scale | Scale portions |
| POST | /api/v1/videos/upload | Upload video |
| POST | /api/v1/ingest | Submit a TikTok/IG link for ingestion (flagged) |
| GET | /api/v1/ingest/{id} | Poll ingestion status / draft |
| GET/POST | /api/v1/inventory | List / create products |
| GET/PUT | /api/v1/inventory/{product_id} | Get / update product |
| POST | /api/v1/inventory/macros/count | Count real macros + cost |
| GET | /api/env, /healthz | Environment info, health