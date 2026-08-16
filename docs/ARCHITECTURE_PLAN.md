Solin — Recipe Platform Architecture

## Tech Stack

- Frontend: React Native (Expo) + Next.js for web
- Backend: FastAPI (Python) + PostgreSQL
- Video storage: Cloudflare R2 CDN
- Auth: Clerk / Supabase Auth
- Search: PostgreSQL full-text + GIN indexes
- Deployment: Fly.io + Vercel

## Key Files

- docs/ARCHITECTURE_PLAN.md — Full platform architecture and tech stack
- schemas/recipe.schema.json — Complete JSON Schema (Draft 2020-12)
- schemas/database.sql — PostgreSQL schema + seed data for 2 starter recipes
- design/ui_design_specs.md — Mobile-first UI design system
- design/prototypes/mobile-recipe-ui.html — Interactive HTML prototype
- components/VideoPlayer/ — React+CSS video player component
- components/index.js — Entry point

## Recipes

1. "Javítom magam" — Chicken & Sausage Pasta (850 kcal/serving, ★9.9)
   - Video: ~/Documents/VideoContent/video1.mp4
   - Source: iamvargacsaba on TikTok
   
2. "Diétás Boljognyai" — Diet Pasta (same recipe, video2.mp4)
   - Video: ~/Documents/VideoContent/video2.mp4
   - Source: iamvargacsaba on TikTok

## Mobile Design

- Colors: primary #FF6B6B, secondary #2D3436, background #FFFFFF
- Typography: Display 32px, Hero 24px, Body 16px
- Breakpoints: mobile 320-429px, tablet 768-1024px, desktop 1024px+
- All views designed for 320px mobile first

## Future Phases

Phase 2: Backend full CRUD (APIs, search, validation)
Phase 3: Frontend full app (Recipe feed, search, collections)
Phase 4: Integrations (TikTok downloader, auto-nutrition)
Phase 5: Polish & launch (auth, collections, deploy to prod)
