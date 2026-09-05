// mv-package-registry — per-version artifacts (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// Every version keeps its own artifacts, so asking for an earlier one serves a
// real URL — and a binary for this machine — rather than a guessed source
// tarball that 404s.
//
//   node --test test/versionartifacts.test.js
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

test('versions: each keeps its own artifacts', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvva-'));
  fs.mkdirSync(path.join(regdir, 'mvx-lang', 'cmd'), { recursive: true });
  // The package renamed its artifacts: assets are cmd-<v>-..., not mvx-lang_cmd-.
  // That rename is exactly what the old guess got wrong.
  fs.writeFileSync(path.join(regdir, 'mvx-lang', 'cmd', 'meta.json'), JSON.stringify({
    name: 'mvx-lang/cmd', artifact: 'cmd', owner: 'gordon', version: '1.4.1',
    source: 'https://github.com/mvx-lang/mv_cmd', systems: ['udt', 'uv', 'jbase'],
    tarball: 'https://gh/1.4.1/cmd-1.4.1-source.tar.gz',
    artifacts: [
      { kind: 'source', tarball: 'https://gh/1.4.1/cmd-1.4.1-source.tar.gz' },
      { kind: 'binary', system: 'uv', os: 'any', arch: 'any', endian: 'le', tarball: 'https://gh/1.4.1/cmd-1.4.1-uv-any-any-le.tar.gz' },
    ],
    versions: [
      { version: '1.4.1', tag: '1.4.1', prerelease: false },
      { version: '1.4.0-beta2', tag: '1.4.0-beta2', prerelease: true, artifacts: [
        { kind: 'source', tarball: 'https://gh/1.4.0-beta2/cmd-1.4.0-beta2-source.tar.gz' },
        { kind: 'binary', system: 'uv', os: 'any', arch: 'any', endian: 'le', tarball: 'https://gh/1.4.0-beta2/cmd-1.4.0-beta2-uv-any-any-le.tar.gz' },
      ] },
      { version: '1.3.0', tag: '1.3.0' },          // indexed before this existed
    ],
  }, null, 2));

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) { try { if ((await get(port, host, '/')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  t.after(() => { srv.kill(); try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  const ask = async (q) => JSON.parse((await get(port, host, '/package/mvx-lang/cmd' + q)).body);

  await t.test('an earlier version serves its OWN recorded binary', async () => {
    const j = await ask('?version=1.4.0-beta2&system=uv&os=linux&arch=x86_64&endian=le');
    assert.strictEqual(j.version, '1.4.0-beta2');
    assert.strictEqual(j.selected, 'binary');
    assert.strictEqual(j.tarball, 'https://gh/1.4.0-beta2/cmd-1.4.0-beta2-uv-any-any-le.tar.gz');
  });

  await t.test('and its source when the system has no binary', async () => {
    const j = await ask('?version=1.4.0-beta2&system=jbase&os=linux&arch=x86_64&endian=le');
    assert.strictEqual(j.selected, 'source');
    assert.strictEqual(j.tarball, 'https://gh/1.4.0-beta2/cmd-1.4.0-beta2-source.tar.gz');
  });

  await t.test('a version with nothing recorded falls back, using the artifact name', async () => {
    const j = await ask('?version=1.3.0&system=uv');
    // the old guess used the package name; it must now use `artifact`, or the
    // URL is the 404 this issue was about
    assert.ok(j.tarball.endsWith('/1.3.0/cmd-1.3.0-source.tar.gz'), j.tarball);
    assert.ok(!j.tarball.includes('mvx-lang_cmd'), 'not the pre-rename guess');
  });

  await t.test('the current version is unaffected', async () => {
    const j = await ask('?system=uv&os=linux&arch=x86_64&endian=le');
    assert.strictEqual(j.version, '1.4.1');
    assert.strictEqual(j.selected, 'binary');
  });

  await t.test('an unknown version is still 404', async () => {
    assert.strictEqual((await get(port, host, '/package/mvx-lang/cmd?version=9.9.9')).status, 404);
  });
});
