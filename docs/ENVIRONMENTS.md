# Solin — Dev & Production Environments

> Complete setup guide for both development and production environments. ☆(◕‿◕)~

---

## Development Environment

### Prerequisites

| Tool | Required Version | Purpose |
|------|--------|------|
| Python | 3.11+ | Backend runtime |
| Node.js | 18+ (LTS) | Frontend build |
| PostgreSQL | 16+ | Database |
| Git | Latest | Version control |
| Docker | 24+ | Optional: local Postgres |
| uvpip | Latest | Python package management |
| pip | 24+ | Node.js |

All available on the user's machine.

### Setup Steps

#### 0. Create Virtual Environments

```bash
# Python backend venv
cd ~/Documents/Solin/backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip

# Node.js frontend setup
cd ~/Documents/Solin/frontend
npm init
```

#### 1. Database

**Option A: Local PostgreSQL (Recommended)**
```bash
# Install PostgreSQL (if not already installed)
brew install postgresql   # macOS
brew services start postgresql

# Create database and user
psql -h 'your-host:port:username:password' -c "CREATE DATABASE solin_dev;"
psql -h solin_dev -c "CREATE USER solin WITH PASSWORD 'sol1nd3v!';"
psql -h solin_dev -c "GRANT ALL PRIVILEGES ON DATABASE solin_dev TO solin;"
```

**Option B: Docker PostgreSQL**
```bash
docker run --name solin-dev \
  -e POSTGRES_DB=solin_dev \
  -e POSTGRES_USER=solin \
  -e POSTGRES_PASSWORD='sol1nd3v!' \
  -p 5432:5432 -d postgres:16
```

#### 2. Run Schema & Seed Data

```bash
psql -h solin_dev -U solin -d solin_dev
psql -U solin -d solin_dev < ~/Documents/Solin/schemas/database.sql
```

Verify:
```bash
psql -U solin -d solin_dev -c "SELECT title, rating FROM recipes;"
```

Expected output should show both "Javítom magam" and "Diétás Boljognyai" entries.

#### 3. Backend (FastAPI)

```bash
cd ~/Documents/Solin/backend
pip install fastapi uvicorn[standard] sqlalchemy psycopg2-binary
```

```python
# backend/app/main.py (minimum viable)
from fastapi import FastAPI
from app.config import get_settings

app = FastAPI(title='Solin API', version='0.1.0')

@app.get('/health')
def health():
    return {'status': 'ok', 'platform': 'Solin', 'version': '0.1.0'}

@app.get('/api/v1/recipes')
def list_recipes():
    # Will connect to PostgreSQL → return recipes
    return {'recipes': []}
```

Start dev server:
```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Access at http://localhost:8000. Auto-generated API docs at http://localhost:8000/docs

#### 4. Frontend (React/Next.js)

```bash
cd ~/Documents/Solin/frontend
npm init -y
npm install react react-dom react-native-web @expo/next-adapter next
npm install --save-dev @types/react @types/react-dom typescript tailwindcss postcss autoprefixer
npx tailwindcss init
```

**File: `frontend/package.json`**

```json
{
  "name": "solin-frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint --ext .jsx,.js .",
    "test": "jest"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "next": "^14.2.0",
    "@expo/next-adapter": "^6.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.38",
    "autoprefixer": "^10.4.19",
    "@types/react": "^18.3.0",
    "@types/node": "^20.14.0"
  }
}
```

**File: `frontend/tailwind.config.js`**
```javascript
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: '#FF6B6B',
        'primary-dark': '#E55A5A',
        secondary: '#2D3436',
        text: {
          primary: '#2D2D2D',
          secondary: '#8E8E93',
        },
        card: '#F5F5F5',
        'card-accent': '#FFF3E0',
        success: '#4CAF50',
        warning: '#FFA726',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
```

```bash
npm run dev
# Opens at http://localhost:3000
```

#### 5. Video Files

Copy/verify the starter videos are in place:
```bash
ls -la ~/Documents/VideoContent/
# Should show: video1.mp4, video2.mp4, video1_desc.txt, video1_transcript.txt, etc.
```

---

## Production Environment

### Infrastructure Components

| Component | Service | Configuration |
|-----------|-----|
| API Server | Fly.io | 2 instances, US East/West regions |
| Database | Heroku Add-on | Hobby Basic (10GB) |
| CDN / Video Storage | Cloudflare R2 | 100 GB storage plan |
| Frontend | Vercel | Auto-deploy on `main` |
| Auth | Clerk | $0/month (up to 10k MAU) |
| Caching | Cloudflare Redis | Free tier (10MB) |

### Production Environment Variables

Create `solin/config/production.env`:
```bash
# === Database ===
DATABASE_URL=postgresql://solin:PASSWORD@host:5432/solin_prod
DATABASE_POOL_SIZE=5

# === Auth ===
CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...

# === Cloudflare R2 (video storage) ===
R2_ACCOUNT_ID=account_id
R2_ACCESS_KEY_ID=access_key
R2_SECRET_ACCESS_KEY=secret_key
R2_BUCKET=solin-videos

# === API ===
API_HOST=0.0.0.0
API_PORT=8000
API_URL=https://api.solin.app
CORS_ORIGINS=https://app.solin.app,https://solin.app
JWT_SECRET_KEY=your-secret-key

# === App ===
APP_ENV=production
APP_NAME=Solin
APP_VERSION=0.1.0

# === Monitoring ===
SENTRY_DSN=https://sentry-key@sentry.io/project-id
LOG_LEVEL=info
```

### Production Deployment

**Fly.io (Backend):**

File: `fly.toml`
```toml
app = 'solin-api'
primary_region = 'sjc'

[build]

[env]
  APP_ENV = 'production'
  LOG_LEVEL = 'info'

[http_service]
  internal_port = 8000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 2

[[vm]]
  memory = '512mb'
  cpu_kind = 'shared'
  cpus = 1
```

Deploy:
```bash
flyctl deploy
flyctl status
flyctl logs --app solin-api
```

**Vercel (Frontend):**

```bash
npm i -g vercel
cd ~/Documents/Solin/frontend
vercel --prod
```

### Production Database

```bash
heroku addons:create heroku-postgresql:mini \
  --app solin-prod
heroku pg:psql --app solin-prod < ../solin/schemas/database.sql
heroku pg:info --app solin-prod
```

### Production CI/CD Pipeline

GitHub Actions workflow:
```yaml
# .github/workflows/ci.yml
name: Solin CI/CD

on:
  push:
    branches: [main, staging]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: solin_test
          POSTGRES_USER: solin
          POSTGRES_PASSWORD: solin_test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install backend deps
        run: |
          pip install -r backend/requirements.txt
          pip install pytest pytest-asyncio httpie

      - name: Run backend tests
        run: |
          export DATABASE_URL=postgresql://solin:solin_test@localhost:5432/solin_test
          cd backend
          pytest tests/ -v

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: frontend/package.json

      - name: Install frontend deps
        run: cd frontend && npm ci

      - name: Run frontend tests
        run: cd frontend && npm test

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint Python
        run: pip install ruff && ruff check backend/
      - name: Lint JS
        run: cd frontend && npx eslint src/

  deploy-staging:
    needs: [test, lint]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy staging
        run: |
          curl -X POST "${{ secrets.STAGING_WEBHOOK }}" \
            -H "Authorization: Bearer ${{ secrets.DEPLOY_TOKEN }}" \
            -H 'Content-Type: application/json'

  deploy-production:
    needs: [test, lint]
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - name: Fly.io deploy
        run: flyctl deploy --app solin-api --no-cache
      - name: Vercel deploy
        uses: amondnet/vercel-action@v26
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.ORG_ID }}
          vercel-project-id: ${{ secrets.PROJECT_ID }}
          vercel-args: '--prod'
```

### Monitoring & Alerting

| Metric | Tool | Alert Threshold |
|--------|------|-------------|
| API uptime | UptimeRobot | Failed 3 in a row |
| Response time | Cloudflare Analytics | p95 > 200ms |
| Error rate | Sentry | > 0.5% |
| DB connections | pg_stat_activity | > 50% pool |
| Storage | R2 console | > 80% used |
| Frontend errors | Sentry JS SDK | > 1% of page views |

---

## Dev vs. Production Differences

| Setting | Development | Production |
|---------|---------- |-------- |
| Database | Local PostgreSQL / Docker | Heroku managed Postgres |
| API | uvicorn (dev server) | Gunicorn (4 workers) on Fly.io |
| Frontend | Next.js dev (HMR) | Next.js production build on Vercel |
| Authentication | None / mock | Clerk (social login + magic links) |
| Video Storage | Local files | Cloudflare R2 CDN |
| Caching | None | Redis |
| CORS | * (all origins) | Whitelist domains |
| Logging | DEBUG level | INFO level (JSON structured) |
| Rate limiting | None | 100 req/min per IP |
| HTTPS | None (HTTP) | Enforced everywhere |
| Tests | run locally | GitHub Actions on every commit |
| Debug mode | Enabled | Disabled |

---

## Useful Commands Cheat Sheet

### Development

```bash
# Start backend
cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000

# Start frontend
cd frontend && npm run dev

# Run schema
psql -h solin_dev -U solin -d solin_dev < ../solin/schemas/database.sql

# Run tests
pytest backend/tests/
cd frontend && npm test

# Seed database (reset)
psql -h solin_dev -U solin -d solin_dev -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql -h solin_dev -U solin -d solin_dev < ../solin/schemas/database.sql

# Open prototye in browser
open design/prototypes/mobile-recipe-ui.html
```

### Production

```bash
# Fly.io
flyctl status
flyctl logs
flyctl ssh console
flyctl deploy

# Heroku Postgres
heroku pg:info
heroku pg:psql
heroku db:pull (backup)

# Vercel
vercel --prod
vercel ls
vercel logs

# Monitoring
# Sentry Dashboard: https://sentry.io/
# UptimeRobot: https://uptimerobot.com/
# Cloudflare Dashboard: https://dash.cloudflare.com/
```
