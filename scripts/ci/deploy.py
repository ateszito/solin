#!/usr/bin/env python3
"""
Solin CI/CD — build + deploy one environment (blueprint sec 7, D5-D12).

Usage:  deploy.py <dev|staging|prod> <commit-sha>

Pipeline:
  1. build context at ~/SolinCI/build-ctx — app/ files + REAL video files
     (Docker COPY does not follow the repo's VideoContent symlink — D12)
  2. pre-deploy pg_dumpall snapshot for staging/prod (data safety)
  3. docker build with per-tier build-args → solin:<env> + immutable tag
     (bakes /healthz, /api/healthz.json, _solin.env.js: tier + version)
  4. rollback pointer: previous image tagged rollback-<env> + state file
  5. compose up -d --force-recreate <web service> ONLY — DB + named volume
     untouched → no data loss, no manual container restart ever
  6. smoke checks: local :<port>/healthz + /api/healthz.json + public
     subdomain must all report the correct tier (and the baked commit),
     else the deploy FAILS and the poller retries next tick

Runtime layout (all outside ~/Documents — launchd TCC):
  ~/SolinCI/repo        git clone of ateszito/solin (build source)
  ~/SolinCI/VideoContent symlink → ~/Documents/VideoContent (real mp4s)
  ~/SolinCI/state/      logs, last-seen markers, snapshots, env file
"""
import os, sys, time, shutil, subprocess, urllib.request, signal
from contextlib import contextmanager

CI  = os.path.expanduser('~/SolinCI')
ST  = os.path.join(CI, 'state')
REPO = os.path.join(CI, 'repo')
VC  = os.path.join(CI, 'VideoContent')
COMPOSE = os.path.join(REPO, 'docker-compose.yml')
COMPOSE_DIR = REPO          # compose resolves relative paths from CWD

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
                    db='solin-dev-db', ver_var='DEV_APP_VERSION',
                    version=lambda s: 'v%s-dev+%s' % (BASE, s), debug='true'),
    'staging': dict(tier='staging', image='solin:staging',
                    svc='solin-staging-web', port=8081, sub='solin-staging.ateszito.com',
                    db='solin-staging-db', ver_var='STAGING_APP_VERSION',
                    version=lambda s: 'v%s-rc1+%s' % (BASE, s), debug='false'),
    'prod':    dict(tier='production', image='solin:prod',
                    svc='solin-prod-web', port=8080, sub='solin.ateszito.com',
                    db='solin-prod-db', ver_var='PROD_APP_VERSION',
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

    # ---- 4. runtime env file for compose ---------------------------------------
    envfile = os.path.join(ST, 'deploy-%s.env' % env)
    with open(envfile, 'w') as fh:
        fh.write('%s=%s\n' % (d['ver_var'], version))
        fh.write('DEV_DB_PASSWORD=solin\nSTAGING_DB_PASSWORD=solin\nPROD_DB_PASSWORD=solin\n')
    L('[4] compose env file: %s (%s=%s)' % (os.path.basename(envfile), d['ver_var'], version))

    # ---- 5. recreate the WEB container only (data preserved) --------------------
    run(['docker', 'compose', '-f', COMPOSE, '--env-file', envfile, 'up', '-d', '--force-recreate', d['svc']], timeout=600)
    code = None
    for _ in range(60):
        code, _ = http_get('http://127.0.0.1:%d/healthz' % d['port'], timeout=5)
        if code == 200:
            break
        time.sleep(1)
    if code != 200:
        ps = sh(['docker', 'ps', '-a', '--filter', 'name=solin', '--format', '{{.Names}} {{.Status}}']).stdout
        L('[5] FAIL: %s did not serve 200 on :%d after 60s — %s' % (d['svc'], d['port'], ps))
        raise SystemExit(1)
    L('[5] %s serving 200 on :%d' % (d['svc'], d['port']))

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
    check('%s /healthz' % d['svc'], 'http://127.0.0.1:%d/healthz' % d['port'], [d['tier']])
    check('%s /api/healthz.json' % d['svc'], 'http://127.0.0.1:%d/api/healthz.json' % d['port'], [d['tier'], sha7])
    check('public https://%s/healthz' % d['sub'], 'https://%s/healthz' % d['sub'], [d['tier']])

    if failures:
        L('===== deploy %s FAILED — roll forward on next push, or roll back: '
          'rollback.py %s =====' % (env, env))
        raise SystemExit(1)

    with open(os.path.join(ST, 'last-successful-%s' % env), 'w') as fh:
        fh.write('sha=%s version=%s snapshot=%s at=%s\n'
                 % (sha, version, snap, time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
    L('===== deploy %s OK in %.0fs — https://%s now serves %s ====='
      % (env, time.time() - T0, d['sub'], version))
    L('     rollback if needed: python3 ~/SolinCI/rollback.py %s' % env)

if __name__ == '__main__':
    main()
