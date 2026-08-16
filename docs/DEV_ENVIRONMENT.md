Solin — Recipe Platform Development Environment

## Setup

### 0. Create Virtual Environments

bash
cd ~/Documents/Solin/backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip

cd ~/Documents/Solin/frontend
npm init


### 1. Database

psql -h solin_dev -U solin -d solin_dev < ../schemas/database.sql


### 2. Backend (FastAPI)

bash
cd ~/Documents/Solin/backend
pip install fastapi uvicorn[standard] sqlalchemy psycopg2-binary
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000


### 3. Frontend (React/Next.js)

bash
cd ~/Documents/Solin/frontend
npm install
npm run dev

### 4. Test Prototype
bash
open design/prototypes/mobile-recipe-ui.html


## Environments

- Development: local Postgres, FastAPI dev, React dev
- Production: Fly.io + Heroku + Cloudflare R2

## Data

- Schema: schemas/recipe.schema.json
- SQL: schemas/database.sql
- Videos: ~/Documents/VideoContent/video1.mp4, ~/Documents/VideoContent/video2.mp4
