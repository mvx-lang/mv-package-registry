// mv-package-registry — central build dispatch (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// A connected repo that opts in to `build` and publishes a SOURCE release with
// native code (udt-callc/*.c) but no binary asset makes the registry fire a
// workflow_dispatch at the central build workflow (on the self-hosted runner).
// This drives the real server against a local GitHub-API stub (GITHUB_API_BASE):
//   - native source, no binary, build on  -> one dispatch, recorded in builds[]
//   - a duplicate webhook                 -> no second dispatch (deduped)
//   - a release that already ships a binary-> no dispatch
//   - build opt-in off                    -> no dispatch
//   - source without udt-callc/*.c        -> no dispatch
//   - the /packages/build toggle (admin token) flips the opt-in
//
//   node --test test/build.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = require('node:net').createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const post = (port, host, p, body, headers = {}) => new Promise((resolve, reject) => {
  const h = { Host: host, 'Content-Length': Buffer.byteLength(body), ...headers };
  const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: h }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  r.on('error', reject); r.write(body); r.end();
});

test('central build dispatch', async (t) => {
  // ---- GitHub API stub (the registry talks to this via GITHUB_API_BASE) ----
  const dispatched = [];       // recorded workflow_dispatch calls
  let nativeCode = true;       // what the git-trees endpoint reports
  const ghApi = http.createServer((rq, rs) => {
    let body = ''; rq.on('data', c => body += c); rq.on('end', () => {
      const u = new URL(rq.url, 'http://x');
      let m;
      if (rq.method === 'POST' && (m = u.pathname.match(/^\/repos\/(.+)\/actions\/workflows\/(.+)\/dispatches$/))) {
        dispatched.push({ repo: m[1], workflow: decodeURIComponent(m[2]), body: JSON.parse(body || '{}') });
        rs.writeHead(204); return rs.end();
      }
      if (rq.method === 'GET' && /\/git\/trees\//.test(u.pathname)) {
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        return rs.end(JSON.stringify({ tree: nativeCode
          ? [{ type: 'blob', path: 'udt-callc/thing.c' }, { type: 'blob', path: 'BP/THING' }]
          : [{ type: 'blob', path: 'BP/THING' }] }));
      }
      // everything else GitHub-ish -> empty/404 so refreshMeta() is quiet
      if (/\/releases\/latest$/.test(u.pathname)) { rs.writeHead(404); return rs.end('{}'); }
      if (/\/releases/.test(u.pathname)) { rs.writeHead(200, { 'Content-Type': 'application/json' }); return rs.end('[]'); }
      rs.writeHead(404, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ message: 'not found' }));
    });
  });
  await new Promise(r => ghApi.listen(0, r));
  const ghBase = `http://127.0.0.1:${ghApi.address().port}`;

  // ---- registry server ----
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvbuild-'));
  const SECRET = 'wh-secret', ADMIN = 'admin-tok';
  const metaFile = path.join(regdir, 'demoscope', 'thing', 'meta.json');
  fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  const readMeta = () => JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const writeMeta = m => fs.writeFileSync(metaFile, JSON.stringify(m, null, 2));
  writeMeta({ name: 'demoscope/thing', owner: 'alice', version: '', artifacts: [],
    source: 'https://github.com/demoscope/thing',
    tracking: { id: 'hookB', secret: SECRET, provider: 'github', ref: { repo: 'demoscope/thing' }, build: ['udt'] } });

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)], {
    env: { ...process.env, MVPKG_REGISTRY_DIR: regdir, MVPKG_ADMIN_USERS: '',
      MVPKG_PUBLISH_TOKEN: ADMIN, GITHUB_TOKEN: 'x', GITHUB_API_BASE: ghBase,
      BUILD_DISPATCH_REPO: 'mvx-lang/mv-package-registry', BUILD_DISPATCH_WORKFLOW: 'build-dispatch.yml', BUILD_DISPATCH_REF: 'main' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; srv.stdout.on('data', d => logs.push('' + d)); srv.stderr.on('data', d => logs.push('' + d));
  for (let i = 0; i < 100; i++) { try { const r = await post(port, host, '/nope', ''); if (r.status) break; } catch {} await sleep(50); }
  t.after(() => { srv.kill(); try { ghApi.close(); } catch {} try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  const sign = raw => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const wh = raw => post(port, host, '/webhook/hookB', raw,
    { 'Content-Type': 'application/json', 'X-GitHub-Event': 'release', 'X-Hub-Signature-256': sign(raw) });
  const srcAsset = v => ({ name: `demoscope_thing-${v}-source.tar.gz`, browser_download_url: `https://x/${v}/source.tar.gz`, size: 10 });
  const binAsset = v => ({ name: `demoscope_thing-${v}-udt-linux-x86_64-le.tar.gz`, browser_download_url: `https://x/${v}/udt.tar.gz`, size: 20 });
  const releaseBody = (v, assets) => JSON.stringify({ action: 'published', release: {
    tag_name: v, name: v, published_at: '2026-03-01T00:00:00Z', tarball_url: 'https://x/src',
    html_url: `https://github.com/demoscope/thing/releases/tag/${v}`, prerelease: false, assets } });
  const waitFor = async n => { for (let i = 0; i < 100; i++) { if (dispatched.length >= n) return; await sleep(30); } };

  await t.test('native source, no binary, build on -> one dispatch', async () => {
    const r = await wh(releaseBody('1.5.0', [srcAsset('1.5.0')]));
    assert.strictEqual(r.status, 200, logs.join(''));
    await waitFor(1);
    assert.strictEqual(dispatched.length, 1, logs.join(''));
    assert.strictEqual(dispatched[0].repo, 'mvx-lang/mv-package-registry');
    assert.strictEqual(dispatched[0].workflow, 'build-dispatch.yml');
    assert.strictEqual(dispatched[0].body.ref, 'main');
    assert.deepStrictEqual(dispatched[0].body.inputs, { package: 'demoscope/thing', repository: 'demoscope/thing', ref: '1.5.0' });
    assert.ok(readMeta().builds['1.5.0'].systems.includes('udt'), 'dispatch recorded in builds[]');
  });

  await t.test('a duplicate webhook does not dispatch again', async () => {
    await wh(releaseBody('1.5.0', [srcAsset('1.5.0')]));
    await sleep(200);
    assert.strictEqual(dispatched.length, 1, 'deduped by the builds[] record');
  });

  await t.test('a release that already ships a binary -> no dispatch', async () => {
    await wh(releaseBody('1.6.0', [srcAsset('1.6.0'), binAsset('1.6.0')]));
    await sleep(200);
    assert.strictEqual(dispatched.length, 1);
  });

  await t.test('build opt-in off -> no dispatch', async () => {
    const m = readMeta(); m.tracking.build = []; writeMeta(m);
    await wh(releaseBody('1.7.0', [srcAsset('1.7.0')]));
    await sleep(200);
    assert.strictEqual(dispatched.length, 1);
  });

  await t.test('source without udt-callc/*.c -> no dispatch', async () => {
    nativeCode = false;
    const m = readMeta(); m.tracking.build = ['udt']; writeMeta(m);
    await wh(releaseBody('1.8.0', [srcAsset('1.8.0')]));
    await sleep(300);
    assert.strictEqual(dispatched.length, 1);
    nativeCode = true;
  });

  await t.test('/packages/build toggles the opt-in (admin token)', async () => {
    const off = await post(port, host, '/packages/build', 'name=demoscope/thing&build=off',
      { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Token': ADMIN });
    assert.strictEqual(off.status, 200);
    assert.deepStrictEqual(readMeta().tracking.build, []);
    const on = await post(port, host, '/packages/build', 'name=demoscope/thing&build=udt',
      { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Token': ADMIN });
    assert.strictEqual(on.status, 200);
    assert.deepStrictEqual(readMeta().tracking.build, ['udt']);
  });
});
