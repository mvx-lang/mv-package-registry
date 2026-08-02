// mv-package-registry — release webhook + artifact resolution (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// Updates are push-driven: a GitHub release webhook (HMAC-signed) re-indexes a
// package's version + external artifacts; the registry never polls.  This drives
// the real server on a throwaway registry dir:
//   - a signed `release` event indexes source + per-arch binary artifacts
//   - a bad signature is rejected 401; a `ping` is accepted; an unknown hook 404s
//   - GET /package/<name>?system=&arch= resolves to the best artifact (binary
//     else source), returned FLAT for the MV client
//   - POST /packages/refresh catches up a source with no webhook (owner-gated)
//
//   node --test test/webhook.test.js
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

function client(port, host) {
  const jar = new Map();
  const req = (method, urlPath, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { Host: host, ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, res => {
      for (const sc of res.headers['set-cookie'] || []) { const nv = sc.split(';')[0], i = nv.indexOf('='); jar.set(nv.slice(0, i), nv.slice(i + 1)); }
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject); if (body != null) r.write(body); r.end();
  });
  req.jar = jar; return req;
}

test('release webhook + artifact resolution', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvwh-'));

  // fixture manifest server (for the no-webhook Refresh test)
  const fixture = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ name: 'refscope/pkg', description: 'refreshed description', license: 'MIT' }));
  });
  await new Promise(r => fixture.listen(0, r));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/mvpkg.json`;

  // seed packages directly (no network) — a github-tracked one and a bare-manifest one
  const SECRET = 's3cr3t-webhook-key';
  const write = (name, meta) => { fs.mkdirSync(path.join(regdir, name), { recursive: true });
    fs.writeFileSync(path.join(regdir, name, 'meta.json'), JSON.stringify(meta, null, 2)); };
  write('demoscope/thing', { name: 'demoscope/thing', owner: 'alice', version: '', artifacts: [],
    tracking: { id: 'hook1', secret: SECRET, provider: 'github', ref: { repo: 'demoscope/thing' } } });
  write('refscope/pkg', { name: 'refscope/pkg', owner: 'alice', version: '', description: 'old', artifacts: [],
    tracking: { id: 'hook2', secret: SECRET, provider: 'manifest', ref: { url: fixtureUrl } } });

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir, MVPKG_ADMIN_USERS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; srv.stdout.on('data', d => logs.push('' + d)); srv.stderr.on('data', d => logs.push('' + d));
  const req = client(port, host);
  for (let i = 0; i < 100; i++) { try { if ((await req('GET', '/')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  t.after(() => { srv.kill(); try { fixture.close(); } catch {} try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  const sign = raw => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const releaseBody = () => JSON.stringify({ action: 'published', release: {
    tag_name: 'v1.2.0', name: 'v1.2.0', published_at: '2026-01-01T00:00:00Z',
    tarball_url: 'https://example/src', html_url: 'https://github.com/demoscope/thing/releases/tag/v1.2.0', prerelease: false,
    assets: [
      { name: 'demoscope_thing-1.2.0-source.tar.gz', browser_download_url: 'https://example/dl/source.tar.gz', size: 100 },
      { name: 'demoscope_thing-1.2.0-udt-linux-x86_64-le.tar.gz', browser_download_url: 'https://example/dl/udt.tar.gz', size: 200 },
    ] } });
  const wh = (raw, headers) => req('POST', '/webhook/hook1', { body: raw, headers: { 'Content-Type': 'application/json', ...headers } });

  await t.test('a signed release event indexes source + binary artifacts', async () => {
    const raw = releaseBody();
    const r = await wh(raw, { 'X-GitHub-Event': 'release', 'X-Hub-Signature-256': sign(raw) });
    assert.strictEqual(r.status, 200, logs.join(''));
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true });
    const meta = JSON.parse(fs.readFileSync(path.join(regdir, 'demoscope', 'thing', 'meta.json'), 'utf8'));
    assert.strictEqual(meta.version, '1.2.0');
    const kinds = meta.artifacts.map(a => a.kind).sort();
    assert.deepStrictEqual(kinds, ['binary', 'source']);
    const bin = meta.artifacts.find(a => a.kind === 'binary');
    assert.deepStrictEqual([bin.system, bin.os, bin.arch, bin.endian], ['udt', 'linux', 'x86_64', 'le']);
    assert.ok(meta.systems.includes('udt'));
  });

  await t.test('a bad signature is rejected 401 and does not index', async () => {
    const raw = releaseBody().replace('1.2.0', '9.9.9');
    const r = await wh(raw, { 'X-GitHub-Event': 'release', 'X-Hub-Signature-256': 'sha256=deadbeef' });
    assert.strictEqual(r.status, 401);
    const meta = JSON.parse(fs.readFileSync(path.join(regdir, 'demoscope', 'thing', 'meta.json'), 'utf8'));
    assert.strictEqual(meta.version, '1.2.0', 'unchanged by the forged event');
  });

  await t.test('a ping is accepted, an unknown hook 404s', async () => {
    const raw = JSON.stringify({ zen: 'hi' });
    const ping = await wh(raw, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sign(raw) });
    assert.strictEqual(ping.status, 200);
    const unknown = await req('POST', '/webhook/nope', { body: '{}', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'ping' } });
    assert.strictEqual(unknown.status, 404);
  });

  await t.test('GET /package resolves to the best artifact, flat', async () => {
    const bin = await req('GET', '/package/demoscope/thing?system=udt&os=linux&arch=x86_64&endian=le');
    const jb = JSON.parse(bin.body);
    assert.strictEqual(jb.tarball, 'https://example/dl/udt.tar.gz');
    assert.strictEqual(jb.selected, 'binary');
    assert.ok(!('artifacts' in jb), 'client view is flat (no artifacts[])');
    const src = await req('GET', '/package/demoscope/thing');           // no system -> source
    const js = JSON.parse(src.body);
    assert.strictEqual(js.tarball, 'https://example/dl/source.tar.gz');
    assert.strictEqual(js.selected, 'source');
    const other = await req('GET', '/package/demoscope/thing?system=udt&os=aix&arch=ppc64&endian=be');
    assert.strictEqual(JSON.parse(other.body).selected, 'source', 'no matching binary -> source');
  });

  // release channels: the default ("latest") version follows the STABLE series;
  // a pre-release is recorded and installable by exact version, but never
  // becomes the default that an unconstrained `MVPKG install` resolves.
  const readMeta = () => JSON.parse(fs.readFileSync(path.join(regdir, 'demoscope', 'thing', 'meta.json'), 'utf8'));
  const relOf = (ver, pre) => JSON.stringify({ action: 'published', release: {
    tag_name: 'v' + ver, name: 'v' + ver, published_at: '2026-02-01T00:00:00Z',
    tarball_url: 'https://example/src', html_url: 'https://github.com/demoscope/thing/releases/tag/v' + ver, prerelease: pre,
    assets: [{ name: `demoscope_thing-${ver}-source.tar.gz`, browser_download_url: `https://example/dl/${ver}-source.tar.gz`, size: 100 }] } });

  await t.test('a pre-release is recorded but does not become the default', async () => {
    const raw = relOf('1.3.0-beta.1', true);
    const r = await wh(raw, { 'X-GitHub-Event': 'release', 'X-Hub-Signature-256': sign(raw) });
    assert.strictEqual(r.status, 200, logs.join(''));
    const meta = readMeta();
    assert.strictEqual(meta.version, '1.2.0', 'default stays on the stable series');
    assert.ok(meta.versions.some(v => v.version === '1.3.0-beta.1'), 'beta recorded in history');
    const def = JSON.parse((await req('GET', '/package/demoscope/thing')).body);
    assert.strictEqual(def.version, '1.2.0', 'unconstrained resolution ignores the beta');
    const beta = JSON.parse((await req('GET', '/package/demoscope/thing?version=1.3.0-beta.1')).body);
    assert.strictEqual(beta.version, '1.3.0-beta.1', 'the beta is installable by exact version');
    assert.ok(beta.tarball.includes('1.3.0-beta.1'), 'resolves the beta artifact');
  });

  await t.test('a later stable release promotes the default forward', async () => {
    const raw = relOf('1.3.0', false);
    const r = await wh(raw, { 'X-GitHub-Event': 'release', 'X-Hub-Signature-256': sign(raw) });
    assert.strictEqual(r.status, 200, logs.join(''));
    assert.strictEqual(readMeta().version, '1.3.0', 'stable release becomes the new default');
    const def = JSON.parse((await req('GET', '/package/demoscope/thing')).body);
    assert.strictEqual(def.version, '1.3.0');
  });

  await t.test('Refresh catches up a no-webhook source (owner only)', async () => {
    // register alice (owns the seeded packages) and refresh the manifest-tracked one
    const alice = client(port, host);
    await alice('POST', '/register', { body: new URLSearchParams({ username: 'alice', email: 'a@b.co', password: 'correcthorse' }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const r = await alice('POST', '/packages/refresh', { body: new URLSearchParams({ name: 'refscope/pkg' }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(r.status, 200, logs.join(''));
    const meta = JSON.parse(fs.readFileSync(path.join(regdir, 'refscope', 'pkg', 'meta.json'), 'utf8'));
    assert.strictEqual(meta.description, 'refreshed description', 'metadata pulled from source');

    // a non-owner (bob, via token) may not refresh someone else's package
    const bob = client(port, host);
    await bob('POST', '/register', { body: new URLSearchParams({ username: 'bob', email: 'b@b.co', password: 'correcthorse2' }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const mk = await bob('POST', '/account/tokens', { body: new URLSearchParams({ name: 't' }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const btok = (mk.body.match(/mvp_[A-Za-z0-9_-]+/) || [])[0];
    const cli = client(port, host);
    const denied = await cli('POST', '/packages/refresh', { body: new URLSearchParams({ name: 'refscope/pkg' }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Token': btok } });
    assert.strictEqual(denied.status, 403);
  });
});
