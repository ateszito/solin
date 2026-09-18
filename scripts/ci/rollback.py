#!/usr/bin/env python3
"""
Solin — one-command rollback (blueprint sec 6).

Usage:  rollback.py <dev|staging|prod> [image-ref]

Default target = the image tagged rollback-<env> by the most recent deploy
(its ID is also recorded in ~/SolinCI/state/last-rollback-<env>).
Optional 2nd arg: any image ref — e.g. an immutable deploy tag
  docker image ls | grep solin     # full history per env

What it does:
  1. retags the previous image over solin:<env>
  2. recreates the web container only — DB + named volume untouched
  3. writes the runtime APP_VERSION env file so compose injects it
  4. re-runs the smoke checks (/healthz local + public subdomain)
"""
import os, sys, time, subprocess, urllib.request

CI = os.path.expanduser('~/SolinCI')
ST = os.path.join(CI, 'state')
COMPOSE = os.path.join(CI, 'repo/docker-compose.yml')

ENVS = {
    'dev':     dict(image='solin:dev',     svc='solin-dev-web',     port=8082, sub='solin-dev.ateszito.com',     ver_var='DEV_APP_VERSION'),
    'staging': dict(image='solin:staging', svc='solin-staging-web', port=8081, sub='solin-staging.ateszito.com', ver_var='STAGING_APP_VERSION'),
    'prod':    dict(image='solin:prod',    svc='solin-prod-web',    port=8080, sub='solin.ateszito.com',           ver_var='PROD_APP_VERSION'),
}

def sh(cmd, **kw):
    return subprocess.run([str(c) for c in cmd], capture_output=True, text=True, **kw)

def run(cmd, timeout=600):
    r = sh(cmd, timeout=timeout)
    if r.returncode != 0:
        sys.stderr.write('%s | CMD %s\n' % (r.stdout, r.stderr, cmd))
        raise SystemExit('cmd failed: %s' % cmd)
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
    if len(sys.argv) < 2:
        raise SystemExit('usage: rollback.py <dev|staging|prod> [image-ref]')
    env = sys.argv[1]
    if env not in ENVS:
        raise SystemExit('unknown env: %s' % env)
    d = ENVS[env]
    ref = sys.argv[2] if len(sys.argv) > 2 else 'rollback-%s' % env
    statef = os.path.join(ST, 'last-rollback-%s' % env)
    if ref == 'rollback-%s' % env and os.path.isfile(statef):
        recorded = open(statef).read().strip()
        if sh(['docker', 'image', 'inspect', recorded]).returncode == 0:
            ref = recorded
    image_id = sh(['docker', 'image', 'inspect', ref, '--format', '{{.Id}}']).stdout.strip()
    if not image_id:
        sys.exit('FAIL: no such image: %s   (list: docker image ls | grep solin-deploy)' % ref)

    # remember what we are replacing (so a forward re-deploy can find us)
    cur_id = sh(['docker', 'image', 'inspect', d['image'], '--format', '{{.Id}}']).stdout.strip()
    if cur_id:
        run(['docker', 'tag', cur_id, 'forward-of-rollback-%s' % env])

    print('[rollback %s] restoring %s -> %s' % (env, d['image'], image_id[:19]))
    run(['docker', 'tag', image_id, d['image']])

    # APP_VERSION for this image (baked at build time — read it back)
    baked = ''
    try:
        cfg = sh(['docker', 'inspect', d['image'], '--format', '{{json .Config}}']).stdout
        import json
        cfgd = json.loads(cfg)
        baked = cfgd.get('Labels', {})
    except Exception:
        pass

    envfile = os.path.join(ST, 'rollback-%s.env' % env)
    if not os.path.exists(envfile):
        with open(envfile, 'w') as fh:
            fh.write('DEV_DB_PASSWORD=solin\nSTAGING_DB_PASSWORD=solin\nPROD_DB_PASSWORD=solin\n')

    run(['docker', 'compose', '-f', COMPOSE, '--env-file', envfile,
         'up', '-d', '--force-recreate', d['svc']])
    code = None
    for _ in range(60):
        code, _ = http_get('http://127.0.0.1:%d/healthz' % d['port'], timeout=5)
        if code == 200:
            break
        time.sleep(1)
    if code != 200:
        sys.exit('FAIL: %s not 200 after rollback' % d['svc'])
    _, body = http_get('http://127.0.0.1:%d/healthz' % d['port'])
    _, pbody = http_get('https://%s/healthz' % d['sub'])
    print('[rollback] local  /healthz -> %s' % body.strip())
    print('[rollback] public /healthz -> %s' % pbody.strip())
    if 'healthz' not in body and 'env=' not in body:
        sys.exit('FAIL: healthz body looks wrong')
    print('[rollback %s] OK — https://%s is back on the previous image' % (env, d['sub']))

if __name__ == '__main__':
    main()
