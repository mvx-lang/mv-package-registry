// mv-package-registry — the website's own domain (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// The website lives on packages.mvx-lang.org; the JSON API answers on the old
// host too, because clients installed before the move have that origin
// compiled in and GitHub holds release webhooks pointing at it.  A webhook
// delivery does not follow redirects, so the split has to hold precisely:
// pages move, the API does not, and nothing but GET/HEAD is ever redirected.
//
//   node --test test/domain.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB = 'https://packages.mvx-lang.org';
const OLD = 'mv-package.heydon.io';

const freePort = () => new Promise(res => { const s = require('node:net').createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const req = (port, host, p, method) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET',
    headers: { Host: host } },
    res => { let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, loc: res.headers.location, body: d })); });
  r.on('error', reject);
  if (method === 'POST') r.end('{}'); else r.end();
});

function start(port, regdir, env) {
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise(res => {
    const wait = () => req(port, OLD, '/packages').then(() => res(srv)).catch(() => setTimeout(wait, 40));
    setTimeout(wait, 60);
  });
}

function seed() {
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvdom-'));
  fs.mkdirSync(path.join(regdir, 'mvx-lang', 'getopt'), { recursive: true });
  fs.writeFileSync(path.join(regdir, 'mvx-lang', 'getopt', 'meta.json'), JSON.stringify({
    name: 'mvx-lang/getopt', owner: 'gordon', version: '1.1.0', provides: 'getopt',
    systems: ['mvx', 'udt', 'uv', 'jbase'], tarball: 'https://example/g.tar.gz',
    versions: [{ version: '1.1.0', tag: '1.1.0' }],
  }, null, 2));
  return regdir;
}

test('the old host sends a browser to the website and keeps serving the API', async (t) => {
  const port = await freePort();
  const regdir = seed();
  const srv = await start(port, regdir, { WEB_ORIGIN: WEB });
  t.after(() => { srv.kill(); fs.rmSync(regdir, { recursive: true, force: true }); });

  // --- pages move, carrying path and query ---
  for (const p of ['/', '/p/mvx-lang/getopt', '/login', '/register', '/account',
                   '/p/mvx-lang/getopt?v=1.1.0']) {
    const r = await req(port, OLD, p);
    assert.strictEqual(r.status, 301, `page ${p} should redirect`);
    assert.strictEqual(r.loc, WEB + p, `page ${p} should keep its path and query`);
  }

  // --- the API does NOT move, on the very same host ---
  for (const p of ['/packages', '/search?q=getopt', '/package/mvx-lang/getopt']) {
    const r = await req(port, OLD, p);
    assert.notStrictEqual(r.status, 301, `API ${p} must not redirect`);
    assert.strictEqual(r.status, 200, `API ${p} should answer`);
  }

  // --- a POST is never redirected: a 301 would turn it into a GET and lose
  //     the body, which for /webhook/<id> means releases stop silently ---
  for (const p of ['/webhook/nosuchid', '/installs/mvx-lang/getopt', '/packages', '/logout']) {
    const r = await req(port, OLD, p, 'POST');
    assert.notStrictEqual(r.status, 301, `POST ${p} must not redirect`);
  }

  // --- on the website's own host nothing is redirected ---
  for (const p of ['/', '/p/mvx-lang/getopt', '/packages']) {
    const r = await req(port, 'packages.mvx-lang.org', p);
    assert.notStrictEqual(r.status, 301, `${p} on the canonical host must not redirect`);
  }
});

test('with WEB_ORIGIN unset nothing redirects, so dev and old deploys are unchanged', async (t) => {
  const port = await freePort();
  const regdir = seed();
  const srv = await start(port, regdir, { WEB_ORIGIN: '' });
  t.after(() => { srv.kill(); fs.rmSync(regdir, { recursive: true, force: true }); });

  for (const p of ['/', '/login', '/packages']) {
    const r = await req(port, OLD, p);
    assert.notStrictEqual(r.status, 301, `${p} must not redirect when WEB_ORIGIN is unset`);
  }
});
