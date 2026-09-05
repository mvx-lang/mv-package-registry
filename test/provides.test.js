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

// Two packages can provide one virtual name, and they need not run on the same
// systems: `curl` is provided by curl-cmd (the OS command — udt, uv, jbase) and
// by curl (libcurl through CallC/DEFC — udt and jbase, never UniVerse, which has
// no in-process route to C).  Serving whichever was found first handed UniVerse
// a package it could not install, silently (#32).
test('provides: the requesting system picks among providers', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvprov2-'));
  const put = (name, meta) => {
    fs.mkdirSync(path.join(regdir, ...name.split('/')), { recursive: true });
    fs.writeFileSync(path.join(regdir, ...name.split('/'), 'meta.json'), JSON.stringify(meta, null, 2));
  };
  // sorts FIRST by name, so it is what the old code always returned
  put('mvx-lang/curl', {
    name: 'mvx-lang/curl', owner: 'gordon', version: '1.2.0',
    provides: 'curl', systems: ['mvx', 'udt', 'jbase'],
    tarball: 'https://example/curl-src.tar.gz',
    artifacts: [{ kind: 'source', tarball: 'https://example/curl-src.tar.gz' },
                { kind: 'binary', system: 'udt', os: 'linux', arch: 'x86_64', endian: 'le',
                  tarball: 'https://example/curl-udt.tar.gz' }],
    versions: [{ version: '1.2.0', tag: '1.2.0' }],
  });
  put('mvx-lang/curl-cmd', {
    name: 'mvx-lang/curl-cmd', owner: 'gordon', version: '1.1.0',
    provides: 'curl', systems: ['udt', 'uv', 'jbase'],
    tarball: 'https://example/cmd-src.tar.gz',
    artifacts: [{ kind: 'source', tarball: 'https://example/cmd-src.tar.gz' },
                { kind: 'binary', system: 'uv', os: 'any', arch: 'any', endian: 'le',
                  tarball: 'https://example/cmd-uv.tar.gz' }],
    versions: [{ version: '1.1.0', tag: '1.1.0' }],
  });
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) { try { if ((await get(port, host, '/')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  t.after(() => { srv.kill(); try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  const ask = async (q) => JSON.parse((await get(port, host, '/package/curl' + q)).body);

  await t.test('uv gets the provider that supports uv, not the first one', async () => {
    const j = await ask('?system=uv&os=linux&arch=x86_64&endian=le');
    assert.strictEqual(j.name, 'mvx-lang/curl-cmd');
    assert.strictEqual(j.selected, 'binary');          // and its uv artifact
  });

  await t.test('udt prefers the provider with a binary for this machine', async () => {
    const j = await ask('?system=udt&os=linux&arch=x86_64&endian=le');
    assert.strictEqual(j.name, 'mvx-lang/curl');
    assert.strictEqual(j.selected, 'binary');
  });

  await t.test('jbase: both declare it, neither has a binary — still resolves', async () => {
    const j = await ask('?system=jbase&os=linux&arch=x86_64&endian=le');
    assert.ok(['mvx-lang/curl', 'mvx-lang/curl-cmd'].includes(j.name));
    assert.strictEqual(j.selected, 'source');
  });

  await t.test('a system nobody declares still resolves, rather than 404', async () => {
    const j = await ask('?system=d3&os=linux&arch=x86_64&endian=le');
    assert.strictEqual(j.name, 'mvx-lang/curl');       // first provider, as before
  });

  await t.test('no system asked: unchanged, the first provider', async () => {
    const j = await ask('');
    assert.strictEqual(j.name, 'mvx-lang/curl');
  });
});
