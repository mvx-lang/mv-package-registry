// mv-package-registry — version list + exact-version resolution (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// A client resolving a dependency version constraint reads the `versions` list
// from /package and asks for an exact version; the registry serves the current
// version's real artifact, or an older one's deterministic source asset URL.
//
//   node --test test/versions.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const freePort = () => new Promise(res => { const s = require('node:net').createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = (port, host, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  }).on('error', reject);
});

test('version list + exact-version resolution', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvver-'));
  // seed a package with a version history (current 2.0.0 + two older)
  fs.mkdirSync(path.join(regdir, 'demoscope', 'thing'), { recursive: true });
  fs.writeFileSync(path.join(regdir, 'demoscope', 'thing', 'meta.json'), JSON.stringify({
    name: 'demoscope/thing', owner: 'alice', source: 'https://github.com/demoscope/thing',
    version: '2.0.0', tarball: 'https://example/dl/2.0.0/demoscope_thing-2.0.0-source.tar.gz',
    artifacts: [{ kind: 'source', tarball: 'https://example/dl/2.0.0/demoscope_thing-2.0.0-source.tar.gz', external: true }],
    versions: [
      { version: '2.0.0', tag: '2.0.0' },
      { version: '1.3.0', tag: '1.3.0' },
      { version: '1.2.0', tag: 'v1.2.0' },
    ],
  }, null, 2));

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) { try { if ((await get(port, host, '/')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  t.after(() => { srv.kill(); try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  await t.test('/package returns the version list, newest first', async () => {
    const r = await get(port, host, '/package/demoscope/thing');
    const j = JSON.parse(r.body);
    assert.strictEqual(j.version, '2.0.0');
    assert.strictEqual(j.versions, '2.0.0 1.3.0 1.2.0');
  });

  await t.test('?version=<current> serves the real artifact', async () => {
    const j = JSON.parse((await get(port, host, '/package/demoscope/thing?version=2.0.0')).body);
    assert.strictEqual(j.version, '2.0.0');
    assert.strictEqual(j.tarball, 'https://example/dl/2.0.0/demoscope_thing-2.0.0-source.tar.gz');
  });

  await t.test('?version=<older> builds the source asset URL from the tag', async () => {
    const j = JSON.parse((await get(port, host, '/package/demoscope/thing?version=1.2.0')).body);
    assert.strictEqual(j.version, '1.2.0');
    // tag was v1.2.0; base = name with / -> _
    assert.strictEqual(j.tarball, 'https://github.com/demoscope/thing/releases/download/v1.2.0/demoscope_thing-1.2.0-source.tar.gz');
    assert.strictEqual(j.selected, 'source');
    assert.strictEqual(j.versions, '2.0.0 1.3.0 1.2.0');
  });

  await t.test('?version=<unknown> is 404', async () => {
    const r = await get(port, host, '/package/demoscope/thing?version=9.9.9');
    assert.strictEqual(r.status, 404);
  });
});
