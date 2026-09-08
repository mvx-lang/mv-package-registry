// mv-package-registry — assets that arrive after the release event (#52).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// A release is usually created before its per-system binaries finish uploading:
// GitHub fires `release`/published with only the source asset attached, and the
// binaries land minutes later as `release`/edited.  indexRelease must merge that
// second event onto the version it already knows.
//
// It did not, for any version that does not become the default — every
// pre-release (by design, a pre-release never promotes) and every superseded
// stable.  Those versions kept whatever the first event saw, so `MVPKG install
// <pkg>@rc` fell through to the source tarball on a machine that had a binary
// published.  On UniData that broke the box: the source tree carries no compiled
// CallC objects, so the install rebuilt the shared libu2callc.so without git's
// functions and every account lost the GIT verb.
//
//   node --test test/lateassets.test.js
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
const freePort = () => new Promise(res => { const s = require('node:net').createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const req = (port, host) => (method, urlPath, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const h = { Host: host, ...headers };
  if (body != null) h['Content-Length'] = Buffer.byteLength(body);
  const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  r.on('error', reject); if (body != null) r.write(body); r.end();
});

test('a release re-indexes when its assets arrive late', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvla-'));
  const SECRET = 's3cr3t-webhook-key';
  fs.mkdirSync(path.join(regdir, 'mvx-lang', 'git'), { recursive: true });
  fs.writeFileSync(path.join(regdir, 'mvx-lang', 'git', 'meta.json'), JSON.stringify({
    name: 'mvx-lang/git', artifact: 'mv_git', owner: 'alice', version: '', artifacts: [],
    source: 'https://github.com/mvx-lang/mv_git',
    tracking: { id: 'hook1', secret: SECRET, provider: 'github', ref: { repo: 'mvx-lang/mv_git' } },
  }, null, 2));

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir, MVPKG_ADMIN_USERS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; srv.stdout.on('data', d => logs.push('' + d)); srv.stderr.on('data', d => logs.push('' + d));
  const rq = req(port, host);
  for (let i = 0; i < 100; i++) { try { if ((await rq('GET', '/')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  t.after(() => { srv.kill(); try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  const sign = raw => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const readMeta = () => JSON.parse(fs.readFileSync(path.join(regdir, 'mvx-lang', 'git', 'meta.json'), 'utf8'));
  const artsOf = ver => ((readMeta().versions || []).find(v => v.version === ver) || {}).artifacts || [];

  // The asset names are mv_git-<ver>-..., not mvx-lang_git-... — the package
  // declares `artifact: mv_git`, as the real one does.
  const asset = (ver, suffix) => ({
    name: `mv_git-${ver}-${suffix}.tar.gz`,
    browser_download_url: `https://example/dl/${ver}/${suffix}.tar.gz`, size: 100,
  });
  const relOf = (ver, pre, suffixes, action) => JSON.stringify({ action, release: {
    tag_name: ver, name: ver, published_at: '2026-09-08T03:12:06Z',
    tarball_url: 'https://example/src',
    html_url: 'https://github.com/mvx-lang/mv_git/releases/tag/' + ver, prerelease: pre,
    assets: suffixes.map(s => asset(ver, s)) } });
  const send = (ver, pre, suffixes, action = 'published') => {
    const raw = relOf(ver, pre, suffixes, action);
    return rq('POST', '/webhook/hook1', { body: raw,
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'release', 'X-Hub-Signature-256': sign(raw) } });
  };

  // a stable release, so later versions have something to be superseded by
  await t.test('seed: a stable release indexes normally', async () => {
    const r = await send('2.0.3', false, ['source', 'udt-linux-x86_64-le']);
    assert.strictEqual(r.status, 200, logs.join(''));
    assert.strictEqual(readMeta().version, '2.0.3');
  });

  await t.test('a pre-release created before its binaries finish uploading', async () => {
    const r = await send('2.1.0-rc2', true, ['source']);
    assert.strictEqual(r.status, 200, logs.join(''));
    assert.deepStrictEqual(artsOf('2.1.0-rc2').map(a => a.kind), ['source'],
      'the first event saw only the source asset');
  });

  await t.test('the binaries land later and ARE merged onto it', async () => {
    const r = await send('2.1.0-rc2', true,
      ['source', 'udt-linux-x86_64-le', 'uv-linux-x86_64-le', 'jbase-linux-x86_64-le', 'mvx-linux-x86_64-le'], 'edited');
    assert.strictEqual(r.status, 200, logs.join(''));
    const arts = artsOf('2.1.0-rc2');
    assert.strictEqual(arts.length, 5, 'source + four binaries recorded on the version');
    const udt = arts.find(a => a.kind === 'binary' && a.system === 'udt');
    assert.ok(udt, 'the udt binary is indexed');
    assert.strictEqual(udt.tarball, 'https://example/dl/2.1.0-rc2/udt-linux-x86_64-le.tar.gz');
  });

  await t.test('and the client now resolves the binary, not the source tarball', async () => {
    const j = JSON.parse((await rq('GET',
      '/package/mvx-lang/git?version=2.1.0-rc2&system=udt&os=linux&arch=x86_64&endian=le')).body);
    assert.strictEqual(j.version, '2.1.0-rc2');
    assert.strictEqual(j.selected, 'binary', 'a source fallback here is what broke UniData');
    assert.strictEqual(j.tarball, 'https://example/dl/2.1.0-rc2/udt-linux-x86_64-le.tar.gz');
  });

  await t.test('the pre-release still does not become the default', async () => {
    assert.strictEqual(readMeta().version, '2.0.3', 'merging assets must not promote');
    assert.strictEqual(JSON.parse((await rq('GET', '/package/mvx-lang/git')).body).version, '2.0.3');
  });

  // Same defect, different door: an older stable does not promote either, so a
  // binary uploaded to a superseded release was dropped just as silently.
  await t.test('a superseded stable also accepts late assets', async () => {
    await send('2.0.2', false, ['source']);
    assert.deepStrictEqual(artsOf('2.0.2').map(a => a.kind), ['source']);
    await send('2.0.2', false, ['source', 'uv-linux-x86_64-le'], 'edited');
    assert.ok(artsOf('2.0.2').some(a => a.kind === 'binary' && a.system === 'uv'),
      'the late uv binary is merged onto the older release');
    assert.strictEqual(readMeta().version, '2.0.3', 'and the default did not move backwards');
  });

  await t.test('a repeat event with no change is still a no-op', async () => {
    const before = fs.readFileSync(path.join(regdir, 'mvx-lang', 'git', 'meta.json'), 'utf8');
    const at = JSON.parse(before).updated;
    await new Promise(r => setTimeout(r, 5));
    await send('2.1.0-rc2', true,
      ['source', 'udt-linux-x86_64-le', 'uv-linux-x86_64-le', 'jbase-linux-x86_64-le', 'mvx-linux-x86_64-le'], 'edited');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(regdir, 'mvx-lang', 'git', 'meta.json'), 'utf8')).updated, at,
      'an unchanged asset set must not rewrite the package file');
  });
});
