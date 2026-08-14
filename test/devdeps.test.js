// mv-package-registry — `devDependencies` (build dependencies) (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// A package may declare `devDependencies` — what has to be PRESENT to package
// it.  It is mainly a record for whoever builds the package: the release
// pipeline reads it to prepare the build environment (mvpkg is the usual entry,
// since it provisions the account a build runs in).  Not needed to RUN the
// package, so a binary install ignores them, and `MVPKG install --source` —
// which compiles — installs them first.  The field rides along in /package.
//
// The client's JSON seam matches a key as "key" WITH its quotes, so
// "devDependencies" cannot be mistaken for "dependencies" — assert both are
// served, and distinctly.
//
//   node --test test/devdeps.test.js
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

test('devDependencies: build deps are served, and distinct from runtime deps', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvdev-'));
  // cmd needs getopt to RUN and mvpkg to BUILD (the shared PLATFORM.H).
  fs.mkdirSync(path.join(regdir, 'mvx-lang', 'cmd'), { recursive: true });
  fs.writeFileSync(path.join(regdir, 'mvx-lang', 'cmd', 'meta.json'), JSON.stringify({
    name: 'mvx-lang/cmd', owner: 'gordon', source: 'https://github.com/mvx-lang/mv_cmd',
    version: '1.3.0', tarball: 'https://example/dl/1.3.0/src.tar.gz',
    dependencies: 'mvx-lang/getopt',
    devDependencies: 'mvx-lang/mvpkg',
    artifacts: [{ kind: 'source', tarball: 'https://example/dl/1.3.0/src.tar.gz', external: true }],
    versions: [{ version: '1.3.0', tag: '1.3.0' }],
  }, null, 2));
  // a package with no build deps must report an empty string, never undefined
  fs.mkdirSync(path.join(regdir, 'mvx-lang', 'plain'), { recursive: true });
  fs.writeFileSync(path.join(regdir, 'mvx-lang', 'plain', 'meta.json'), JSON.stringify({
    name: 'mvx-lang/plain', owner: 'gordon', source: 'https://github.com/mvx-lang/plain',
    version: '1.0.0', tarball: 'https://example/dl/1.0.0/src.tar.gz',
    artifacts: [{ kind: 'source', tarball: 'https://example/dl/1.0.0/src.tar.gz', external: true }],
    versions: [{ version: '1.0.0', tag: '1.0.0' }],
  }, null, 2));

  fs.mkdirSync(path.join(regdir, 'mvx-lang', 'emptied'), { recursive: true });
  fs.writeFileSync(path.join(regdir, 'mvx-lang', 'emptied', 'meta.json'), JSON.stringify({
    name: 'mvx-lang/emptied', owner: 'gordon', source: 'https://github.com/mvx-lang/emptied',
    version: '1.0.0', tarball: 'https://example/dl/1.0.0/src.tar.gz',
    dependencies: '', devDependencies: 'mvx-lang/mvpkg',
    artifacts: [{ kind: 'source', tarball: 'https://example/dl/1.0.0/src.tar.gz', external: true }],
    versions: [{ version: '1.0.0', tag: '1.0.0' }],
  }, null, 2));

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) { try { if ((await get(port, host, '/')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  t.after(() => { srv.kill(); try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  await t.test('/package carries devDependencies alongside dependencies', async () => {
    const j = JSON.parse((await get(port, host, '/package/mvx-lang/cmd')).body);
    assert.strictEqual(j.dependencies, 'mvx-lang/getopt');
    assert.strictEqual(j.devDependencies, 'mvx-lang/mvpkg');
  });

  await t.test('a build dep is NOT reported as a runtime dependency', async () => {
    const j = JSON.parse((await get(port, host, '/package/mvx-lang/cmd')).body);
    assert.ok(!j.dependencies.includes('mvpkg'),
      'mvpkg is needed to build, not to run — it must not appear in dependencies');
  });

  await t.test('an exact prior version also carries them', async () => {
    const j = JSON.parse((await get(port, host, '/package/mvx-lang/cmd?version=1.3.0')).body);
    assert.strictEqual(j.devDependencies, 'mvx-lang/mvpkg');
  });

  await t.test('a package without build deps reports an empty string', async () => {
    const j = JSON.parse((await get(port, host, '/package/mvx-lang/plain')).body);
    assert.strictEqual(j.devDependencies, '');
  });

  await t.test('a package that moved its last runtime dep to devDependencies clears it', async () => {
    // getopt moved mvpkg from dependencies to devDependencies, leaving NO runtime
    // deps.  A refresh/add must be able to CLEAR the stored list — guarding on
    // truthiness would leave the stale runtime dependency behind for ever.
    const j = JSON.parse((await get(port, host, '/package/mvx-lang/emptied')).body);
    assert.strictEqual(j.dependencies, '');
    assert.strictEqual(j.devDependencies, 'mvx-lang/mvpkg');
  });

  await t.test('the index lists them too', async () => {
    const j = JSON.parse((await get(port, host, '/packages')).body);
    const cmd = j.packages.find(p => p.name === 'mvx-lang/cmd');
    assert.ok(cmd, 'cmd is indexed');
    assert.strictEqual(cmd.devDependencies, 'mvx-lang/mvpkg');
  });
});
