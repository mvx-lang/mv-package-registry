// mv-package-registry — `provides` (virtual package names) (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// A package may declare `provides` — virtual names it satisfies — so a rename
// resolves transparently: a request for the old name serves the provider, and
// the provides list rides along in /package so the client records it satisfied.
//
//   node --test test/provides.test.js
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

test('provides: field pass-through + virtual-name resolution', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvprov-'));
  // cursors is the renamed udt_curses; it provides the old name.
  fs.mkdirSync(path.join(regdir, 'mvx-lang', 'cursors'), { recursive: true });
  fs.writeFileSync(path.join(regdir, 'mvx-lang', 'cursors', 'meta.json'), JSON.stringify({
    name: 'mvx-lang/cursors', owner: 'gordon', source: 'https://github.com/mvx-lang/cursors',
    version: '2.0.0', tarball: 'https://example/dl/2.0.0/src.tar.gz',
    provides: 'udt_curses',
    artifacts: [{ kind: 'source', tarball: 'https://example/dl/2.0.0/src.tar.gz', external: true }],
    versions: [{ version: '2.0.0', tag: '2.0.0' }],
  }, null, 2));

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) { try { if ((await get(port, host, '/')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  t.after(() => { srv.kill(); try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  await t.test('/package of the real name carries its provides', async () => {
    const j = JSON.parse((await get(port, host, '/package/mvx-lang/cursors')).body);
    assert.strictEqual(j.name, 'mvx-lang/cursors');
    assert.strictEqual(j.provides, 'udt_curses');
  });

  await t.test('/package of the virtual name resolves to the provider', async () => {
    const r = await get(port, host, '/package/udt_curses');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.name, 'mvx-lang/cursors');   // served the provider
    assert.strictEqual(j.provides, 'udt_curses');
  });

  await t.test('an unprovided unknown name is still 404', async () => {
    assert.strictEqual((await get(port, host, '/package/no-such-thing')).status, 404);
  });
});
