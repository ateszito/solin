#!/usr/bin/env python3
"""
Solin CI/CD — build + deploy one environment (blueprint sec 7, D5-D12).

Usage:  deploy.py <dev|staging|prod> <commit-sha>

Pipeline:
  1. build context at ~/SolinCI/build-ctx — app/ files + REAL video files
     (Docker COPY does not follow the repo's VideoContent symlink — D12)
     + backend/ + requirements.txt + Dockerfile.api (dev API image, D2)
  2. pre-deploy pg_dumpall snapshot for staging/prod (data safety)
  3. docker build with per-tier build-args → solin:<env> + immutable tag
     (bakes /healthz, /api/healthz.json, _solin.env.js: tier + version)
     + (dev only) docker build -f Dockerfile.api → solin:dev-api + immutable
  4. rollback pointer: previous image tagged rollback-<env> + state file
  5. compose up -d --force-recreate <web service> ONLY — DB + named volume
     untouched → no data loss, no manual container restart ever
     (dev: web + api recreated together; api data volume survives)
  6. smoke checks: local :<port>/healthz + /api/healthz.json + public
     subdomain must all report the correct tier (and the baked commit),
     else the deploy FAILS and the poller retries next tick
     (dev: + live API probes — /api/v1/inventory 200 + seed image 200)

Runtime layout (all outside ~/Documents — launchd TCC):
  ~/SolinCI/repo        git clone of ateszito/solin (build source)
  ~/SolinCI/VideoContent symlink → ~/Documents/VideoContent (real mp4s)
  ~/SolinCI/state/      logs, last-seen markers, snapshots, env file
"""
import os, sys, time, json, shutil, subprocess, urllib.request, signal
from contextlib import contextmanager

CI = os.environ.get('SOLIN_CI_DIR', '/opt/solin' if os.path.isdir('/opt/solin') else os.path.expanduser('~/SolinCI'))
ST = os.path.join(CI, 'state')
REPO = os.environ.get('SOLIN_REPO_DIR', os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
VC = os.path.join(CI, 'VideoContent')
if not os.path.isdir(VC):
    VC = os.path.join(REPO, 'VideoContent')
COMPOSE = os.path.join(REPO, 'docker-compose.yml')
COMPOSE_DIR = REPO          # compose resolves relative paths from CWD
def _detect_docker_host():
    if os.environ.get('DOCKER_TARGET_HOST'):
        return os.environ['DOCKER_TARGET_HOST']
    try:
        r = subprocess.run(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
                           capture_output=True, text=True, timeout=5)
        ep = (r.stdout or '').strip()
        if ep.startswith('ssh://'):
            host = ep.split('ssh://', 1)[1].split('@')[-1].split('/')[0].split(':')[0]
            if host:
                return host
    except Exception:
        pass
    return '127.0.0.1'

HOST_IP = _detect_docker_host()

# Base semver, read from the repo's VERSION file (single number, like
# "0.1.1"). Each released cut just bumps that file. Per-tier suffix is
# added by deploy.py (dev→-dev, staging→-rc1, prod→"").
_VERSION_PATH = os.path.join(REPO, 'VERSION')
if os.path.isfile(_VERSION_PATH):
    BASE = open(_VERSION_PATH).read().strip().lstrip('v') or '0.1.0'
else:
    BASE = '0.1.0'

ENVS = {
    'dev':     dict(tier='development', image='solin:dev',
                    svc='solin-dev-web', port=8082, sub='solin-dev.ateszito.com',
                    api_svc='solin-dev-api', api_image='solin:dev-api',
                    db='solin-dev-db', db_name='solin_dev', ver_var='DEV_APP_VERSION',
                    version=lambda s: 'v%s-dev+%s' % (BASE, s), debug='true'),
    'staging': dict(tier='staging', image='solin:staging',
                    svc='solin-staging-web', port=8081, sub='solin-staging.ateszito.com',
                    api_svc='solin-staging-api', api_image='solin:staging-api',
                    db='solin-staging-db', db_name='solin_staging', ver_var='STAGING_APP_VERSION',
                    version=lambda s: 'v%s-rc1+%s' % (BASE, s), debug='false'),
    'prod':    dict(tier='production', image='solin:prod',
                    svc='solin-prod-web', port=8080, sub='solin.ateszito.com',
                    api_svc='solin-prod-api', api_image='solin:prod-api',
                    db='solin-prod-db', db_name='solin_prod', ver_var='PROD_APP_VERSION',
                    version=lambda s: 'v%s+%s' % (BASE, s), debug='false'),
}

def sh(cmd, **kw):
    return subprocess.run([str(c) for c in cmd], capture_output=True, text=True, **kw)

class TCCStall(Exception):
    pass

def _alarm(t):
    raise TCCStall('filesystem operation timed out after %ds — likely macOS TCC; run deploy from a GUI shell' % t)

@contextmanager
def stall_guard(seconds=60):
    old = signal.signal(signal.SIGALRM, _alarm)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)

def run(cmd, timeout=1800):
    r = sh(cmd, timeout=timeout)
    if r.returncode != 0:
        sys.stderr.write('CMD: %s\n%s\n%s\n' % (cmd, r.stdout, r.stderr))
        raise SystemExit('command failed (rc=%d)' % r.returncode)
    return (r.stdout or '').strip()

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) SolinCI/1.0'

def http_get(url, timeout=20):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.getcode(), r.read().decode('utf-8', 'replace')
    except Exception as e:
        return None, repr(e)

def cf_purge_hostname(hostname):
    """Best-effort Cloudflare purge by hostname (t_01895707). Returns (ok:bool, msg).
    Never raises — a purge failure must NOT fail a deploy (the dev image already
    sends Cache-Control: no-store, so browsers revalidate regardless). Reads
    CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID from env (or falls back to the
    repo .env.development). Logs a clear reason when it cannot purge (e.g.
    token missing `zone.cache_purge` edit permission, currently 401)."""
    token = os.environ.get('CLOUDFLARE_API_TOKEN')
    zone  = os.environ.get('CLOUDFLARE_ZONE_ID')
    if not (token and zone):
        # Fallback 1: repo .env.development (any live, uncommented key).
        envfile = os.path.join(REPO, '.env.development')
        if os.path.isfile(envfile):
            for line in open(envfile):
                line = line.strip()
                if line.startswith('CLOUDFLARE_API_TOKEN='):
                    token = line.split('=', 1)[1].strip().strip('"\'')
                if line.startswith('CLOUDFLARE_ZONE_ID='):
                    zone = line.split('=', 1)[1].strip()
    if not (token and zone):
        # Fallback 2: ~/SolinCI/state/cf.env (mode 600, written by t_01895707
        # worker so the launchd-spawned deploy still has credentials).
        envfile2 = os.path.join(ST, 'cf.env')
        if os.path.isfile(envfile2):
            for line in open(envfile2):
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    k, v = line.split('=', 1)
                    if k == 'CLOUDFLARE_API_TOKEN' and not token:
                        token = v.strip()
                    if k == 'CLOUDFLARE_ZONE_ID' and not zone:
                        zone = v.strip()
    if not (token and zone):
        return False, 'no CLOUDFLARE_API_TOKEN/CLOUDFLARE_ZONE_ID — purge skipped'
    url = 'https://api.cloudflare.com/client/v4/zones/%s/purge_cache' % zone
    body = json.dumps({'purge_by_hostname': [hostname]}).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={'Authorization': 'Bearer ' + token,
                 'Content-Type': 'application/json',
                 'User-Agent': UA}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            resp = json.loads(r.read())
            if resp.get('success'):
                return True, 'purge requested for %s' % hostname
            return False, 'purge api success=false: %s' % json.dumps(resp)[:160]
    except Exception as e:
        return False, repr(e)[:180]

def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: deploy.py <dev|staging|prod> <commit-sha>')
    env, sha = sys.argv[1], sys.argv[2]
    if env not in ENVS:
        raise SystemExit('unknown env: %s (want dev|staging|prod)' % env)
    d = ENVS[env]
    sha = sha[:40]
    sha7 = sha[:7]
    version = d['version'](sha7)
    immutable = 'solin-deploy-%s-%s' % (env, sha7)
    os.makedirs(ST, exist_ok=True)
    T0 = time.time()
    logf = open(os.path.join(ST, 'deploy-%s.log' % env), 'a')
    def L(m):
        print(m, flush=True)
        logf.write(m + '\n'); logf.flush()

    L('===== deploy %s  sha=%s  version=%s  %s ====='
      % (env, sha7, version, time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))

    # ---- 1. build context -----------------------------------------------------
    ctx = os.path.join(CI, 'build-ctx')
    if os.path.isdir(ctx):
        shutil.rmtree(ctx)
    app_ctx = os.path.join(ctx, 'app')
    os.makedirs(app_ctx)
    n_copied = 0
    for f in sorted(os.listdir(os.path.join(REPO, 'app'))):
        src = os.path.join(REPO, 'app', f)
        dst = os.path.join(app_ctx, f)
        if os.path.islink(src) or f == 'VideoContent':
            continue
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        n_copied += 1
    vdst = os.path.join(app_ctx, 'VideoContent')
    os.makedirs(vdst)
    # NOTE: vreal is a REAL directory (mirrored by refresh_videos.sh) — NOT a
    # symlink into ~/Documents, which launchd-spawned processes can't follow
    # under macOS TCC privacy rules.
    vreal = os.path.realpath(VC)
    nvid = 0
    with stall_guard(90):
        for f in sorted(os.listdir(vreal)):
            src = os.path.join(vreal, f)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(vdst, f))
                nvid += 1
    shutil.copy2(os.path.join(REPO, 'Dockerfile'), os.path.join(ctx, 'Dockerfile'))
    # --- API image context (dev-only, D2): backend code + deps + API dockerfile ---
    shutil.copytree(os.path.join(REPO, 'backend'), os.path.join(ctx, 'backend'),
                    ignore=shutil.ignore_patterns('__pycache__', 'media', '*.pyc'))
    shutil.copy2(os.path.join(REPO, 'requirements.txt'), os.path.join(ctx, 'requirements.txt'))
    shutil.copy2(os.path.join(REPO, 'Dockerfile.api'), os.path.join(ctx, 'Dockerfile.api'))
    ctx_kb = run(['du', '-sk', ctx]).split()
    L('[1] build context ready (%s files, %d videos, %s KB)'
      % (n_copied, nvid, ctx_kb[0] if ctx_kb else '?'))

    # ---- 2. pre-deploy DB snapshot (staging/prod) ------------------------------
    snap = 'none'
    db_up = sh(['docker', 'ps', '--filter', 'name=%s' % d['db'], '--format', '{{.Names}}']).stdout
    if db_up and d['db'] in db_up:
        snapf = os.path.join(ST, 'pre-deploy-%s-%s.sql' % (env, sha7))
        with open(snapf, 'wb') as fh:
            r = subprocess.run(['docker', 'exec', d['db'], 'pg_dumpall', '-U', 'solin'], stdout=fh)
            if r.returncode == 0:
                snap = snapf
                L('[2] db snapshot: %s (%s KB)'
                  % (os.path.basename(snapf), os.path.getsize(snapf) // 1024))
    else:
        L('[2] WARNING: %s not running — snapshot skipped' % d['db'])

    # ---- 3. rollback pointer + docker build ------------------------------------
    old_id = sh(['docker', 'image', 'inspect', d['image'], '--format', '{{.Id}}']).stdout.strip()
    if old_id:
        run(['docker', 'tag', old_id, 'rollback-%s' % env])
        open(os.path.join(ST, 'last-rollback-%s' % env), 'w').write(old_id + '\n')
        L('[3] rollback pointer: rollback-%s -> %s' % (env, old_id[:19]))
    else:
        L('[3] no previous %s image — first deploy' % env)

    L('[3] docker build (this can take a couple of minutes) ...')
    run(['docker', 'build', ctx,
         '--build-arg', 'SOLIN_ENV=%s' % d['tier'],
         '--build-arg', 'APP_VERSION=%s' % version,
         '--build-arg', 'API_BASE_URL=https://%s' % d['sub'],
         '--build-arg', 'PUBLIC_BASE_URL=https://%s' % d['sub'],
         '--build-arg', 'FEATURE_ALLOW_EDIT=true',
         '--build-arg', 'FEATURE_INVISIBILITY=true',
         '--build-arg', 'DEBUG=%s' % d['debug'],
         '-t', d['image'], '-t', immutable, '-t', 'solin-%s' % env])
    new_id = sh(['docker', 'image', 'inspect', d['image'], '--format', '{{.Id}}']).stdout.strip()
    L('[3] built %s -> %s (immutable: %s)' % (d['image'], new_id[:19], immutable))

    # ---- 3b. build the FastAPI backend image -------------
    api_svc = d.get('api_svc')
    api_image = d.get('api_image')
    if api_svc and api_image:
        api_rollback_file = os.path.join(ST, 'last-rollback-%s' % api_image.replace(':', '-'))
        old_api = sh(['docker', 'image', 'inspect', api_image, '--format', '{{.Id}}']).stdout.strip()
        if old_api:
            run(['docker', 'tag', old_api, 'rollback-%s-api' % env])
            open(api_rollback_file, 'w').write(old_api + '\n')
        run(['docker', 'build',
             '-f', os.path.join(ctx, 'Dockerfile.api'),
             '--build-arg', 'SOLIN_ENV=%s' % d['tier'],
             '--build-arg', 'APP_VERSION=%s' % version,
             '--build-arg', 'API_BASE_URL=https://%s' % d['sub'],
             '--build-arg', 'PUBLIC_BASE_URL=https://%s' % d['sub'],
             '--build-arg', 'CORS_ORIGINS=https://%s' % d['sub'],
             '--build-arg', 'JWT_SECRET_KEY=solin-%s-jwt-%s' % (env, version),
             '--build-arg', 'DATABASE_URL=postgresql://solin:solin@%s:5432/%s' % (d['db'], d['db_name']),
             '-t', api_image, '-t', 'solin-deploy-%s-api-%s' % (env, sha7),
             ctx])
        api_id = sh(['docker', 'image', 'inspect', api_image, '--format', '{{.Id}}']).stdout.strip()
        L('[3b] built %s -> %s (immutable: solin-%s-api-%s)' % (api_image, api_id[:19], env, sha7))

    # ---- 4. runtime env file for compose ---------------------------------------
    envfile = os.path.join(ST, 'deploy-%s.env' % env)
    with open(envfile, 'w') as fh:
        fh.write('%s=%s\n' % (d['ver_var'], version))
        fh.write('DEV_DB_PASSWORD=solin\nSTAGING_DB_PASSWORD=solin\nPROD_DB_PASSWORD=solin\n')
    L('[4] compose env file: %s (%s=%s)' % (os.path.basename(envfile), d['ver_var'], version))

    # ---- 5. recreate WEB container (+ api; data preserved) ---------------------
    if api_svc:
        run(['docker', 'compose', '-f', COMPOSE, '--env-file', envfile, 'up', '-d',
             '--force-recreate', api_svc], timeout=600)
        api_up = sh(['docker', 'inspect', '--format', '{{.State.Status}}', api_svc]).stdout
        L('[5] %s container state: %s' % (api_svc, api_up))
        api_code = None
        for _ in range(60):
            r = sh(['docker', 'exec', api_svc, 'python', '-c',
                    'import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('
                    '\'http://127.0.0.1:8000/api/v1/inventory/?limit=0\', timeout=3).status==200 else 1)'],
                   timeout=15)
            if r.returncode == 0:
                api_code = 200
                break
            time.sleep(1)
        if api_code != 200:
            logs = sh(['docker', 'logs', '--tail', '30', api_svc]).stdout
            L('[5] FAIL: %s did not become ready after 60s\n%s' % (api_svc, logs))
            raise SystemExit(1)
        L('[5] %s ready (200 on /api/v1/inventory inside container)' % api_svc)
    run(['docker', 'compose', '-f', COMPOSE, '--env-file', envfile, 'up', '-d',
         '--force-recreate', d['svc']], timeout=600)
    code = None
    for _ in range(60):
        code, _ = http_get('http://%s:%d/healthz' % (HOST_IP, d['port']), timeout=5)
        if code == 200:
            break
        time.sleep(1)
    if code != 200:
        ps = sh(['docker', 'ps', '-a', '--filter', 'name=solin', '--format', '{{.Names}} {{.Status}}']).stdout
        L('[5] FAIL: %s did not serve 200 on :%d after 60s — %s' % (d['svc'], d['port'], ps))
        raise SystemExit(1)
    L('[5] %s serving 200 on :%d' % (d['svc'], d['port']))
    if api_svc:
        api_code = None
        for _ in range(60):
            api_code, _ = http_get('http://%s:%d/api/v1/inventory?limit=1' % (HOST_IP, d['port']), timeout=5)
            if api_code == 200:
                break
            time.sleep(1)
        if api_code != 200:
            ps = sh(['docker', 'ps', '-a', '--filter', 'name=solin', '--format', '{{.Names}} {{.Status}}']).stdout
            L('[5] FAIL: %s did not serve /api/v1/inventory 200 after 60s — %s' % (api_svc, ps))
            raise SystemExit(1)
        L('[5] %s serving /api/v1/inventory 200 (through %s)' % (api_svc, d['svc']))

    # ---- 6. smoke checks --------------------------------------------------------
    failures = 0
    def check(name, url, needles):
        nonlocal failures
        code, body = http_get(url)
        if code != 200:
            failures += 1
            L('[6] FAIL %s (HTTP %s): %s' % (name, code, body[:200]))
            return
        missing = [n for n in needles if n not in body]
        if missing:
            failures += 1
            L('[6] FAIL %s: missing %r in body: %r' % (name, missing, body[:200]))
        else:
            L('[6] OK   %s: %s' % (name, body[:160].strip()))
    check('%s /healthz' % d['svc'], 'http://%s:%d/healthz' % (HOST_IP, d['port']), [d['tier']])
    check('%s /api/healthz.json' % d['svc'], 'http://%s:%d/api/healthz.json' % (HOST_IP, d['port']), [d['tier'], sha7])
    check('public https://%s/healthz' % d['sub'], 'https://%s/healthz' % d['sub'], [d['tier']])
    if api_svc:
        check('public https://%s/api/v1/inventory' % d['sub'],
              'https://%s/api/v1/inventory' % d['sub'], ['p1', 'Chicken'])
        code_img, img_body = http_get('https://%s/api/v1/media/inventory/p1/product_photo/seed.jpg' % d['sub'])
        if code_img != 200:
            failures += 1
            L('[6] FAIL seed image HTTP %s over https: %s' % (code_img, img_body[:120]))
        else:
            L('[6] OK   seed image returned 200 over https (%d chars of binary decoded)' % len(img_body))

    if failures:
        L('===== deploy %s FAILED — roll forward on next push, or roll back: '
          'rollback.py %s =====' % (env, env))
        raise SystemExit(1)

    with open(os.path.join(ST, 'last-successful-%s' % env), 'w') as fh:
        fh.write('sha=%s version=%s snapshot=%s at=%s\n'
                 % (sha, version, snap, time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
    # ---- 6b. best-effort Cloudflare edge purge (t_01895707) -----------
    # Belt & suspenders for the stale-4h app/*.js bug: the dev image now bakes
    # `Cache-Control: no-store` into the vhost so every browser revalidates with
    # the origin, but we ALSO kick a purge of the zone edge for this hostname
    # to clear any copies cached under the old max-age. Non-fatal on purpose:
    # the current token lacks `zone.cache_purge` edit permission (401), so log
    # the reason and keep going — the no-store header already guarantees
    # freshness for new visitors.
    ok, msg = cf_purge_hostname(d['sub'])
    if ok:
        L('[7] CF purge: %s' % msg)
    else:
        L('[7] CF purge skipped (non-fatal): %s' % msg)
    L('===== deploy %s OK in %.0fs — https://%s now serves %s ====='
      % (env, time.time() - T0, d['sub'], version))
    L('     rollback if needed: python3 ~/SolinCI/rollback.py %s' % env)

if __name__ == '__main__':
    main()
