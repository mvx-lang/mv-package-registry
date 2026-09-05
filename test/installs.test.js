// mv-package-registry — install events (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// MVPKG reports install/update/remove so the registry can answer how many
// installations a package has and what environments they are on.  Insert-only:
// one JSON object appended per event, aggregated on read.
//
//   node --test test/installs.test.js
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
const post = (port, host, p, obj) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(obj));
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
    headers: { Host: host, 'Content-Type': 'application/json', 'Content-Length': data.length } },
    res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
  req.on('error', reject); req.end(data);
});

test('installs: record, aggregate, and refuse what should not be stored', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvinst-'));
  fs.mkdirSync(path.join(regdir, 'mvx-lang', 'getopt'), { recursive: true });
  fs.writeFileSync(path.join(regdir, 'mvx-lang', 'getopt', 'meta.json'), JSON.stringify({
    name: 'mvx-lang/getopt', owner: 'gordon', version: '1.1.0', provides: 'getopt',
    systems: ['mvx', 'udt', 'uv', 'jbase'], tarball: 'https://example/g.tar.gz',
    versions: [{ version: '1.1.0', tag: '1.1.0' }],
  }, null, 2));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) { try { if ((await get(port, host, '/')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  t.after(() => { srv.kill(); try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  const ev = (o) => post(port, host, '/installs/mvx-lang/getopt', o);
  const stats = async () => JSON.parse((await get(port, host, '/installs/mvx-lang/getopt')).body);

  await t.test('an unknown package is refused, not created', async () => {
    const r = await post(port, host, '/installs/mvx-lang/nope', { id: 'a', action: 'install' });
    assert.strictEqual(r.status, 404);
    assert.ok(!fs.existsSync(path.join(regdir, 'mvx-lang', 'nope')));
  });

  await t.test('installs from three environments count separately', async () => {
    await ev({ id: 'box1', action: 'install', version: '1.1.0', system: 'uv', os: 'linux', arch: 'x86_64', endian: 'le' });
    await ev({ id: 'box2', action: 'install', version: '1.1.0', system: 'udt', os: 'linux', arch: 'x86_64', endian: 'le' });
    await ev({ id: 'box3', action: 'install', version: '1.0', system: 'jbase', os: 'linux', arch: 'x86_64', endian: 'le' });
    const s = await stats();
    assert.strictEqual(s.installations, 3);
    assert.deepStrictEqual(s.bySystem, { uv: 1, udt: 1, jbase: 1 });
    assert.deepStrictEqual(s.byVersion, { '1.1.0': 2, '1.0': 1 });
  });

  await t.test('the same box installing twice is still one installation', async () => {
    await ev({ id: 'box1', action: 'install', version: '1.1.0', system: 'uv' });
    assert.strictEqual((await stats()).installations, 3);
  });

  await t.test('an update moves that box to the new version', async () => {
    await ev({ id: 'box3', action: 'update', version: '1.1.0', from: '1.0', system: 'jbase' });
    const s = await stats();
    assert.strictEqual(s.installations, 3);
    assert.deepStrictEqual(s.byVersion, { '1.1.0': 3 });
  });

  await t.test('a remove retires that box but the log keeps the history', async () => {
    const before = (await stats()).events;
    await ev({ id: 'box2', action: 'remove', version: '1.1.0', system: 'udt' });
    const s = await stats();
    assert.strictEqual(s.installations, 2);
    assert.strictEqual(s.bySystem.udt, undefined);
    assert.ok(s.events > before, 'the event log still grew');
  });

  await t.test('insert-only: one line per event, nothing rewritten', async () => {
    const log = fs.readFileSync(path.join(regdir, 'mvx-lang', 'getopt', 'installs.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    assert.strictEqual(log.length, 6);
    assert.strictEqual(JSON.parse(log[0]).id, 'box1');
    assert.strictEqual(JSON.parse(log[5]).action, 'remove');
  });

  await t.test('a bad action and a missing id are both refused', async () => {
    assert.strictEqual((await ev({ id: 'x', action: 'destroy' })).status, 400);
    assert.strictEqual((await ev({ action: 'install' })).status, 400);
  });

  await t.test('a field that does not fit is dropped, not stored badly', async () => {
    await ev({ id: 'box9', action: 'install', version: 'x'.repeat(200), system: 'uv; rm -rf /' });
    const s = await stats();
    assert.strictEqual(s.byVersion['x'.repeat(200)], undefined);
    assert.strictEqual(s.bySystem['uv; rm -rf /'], undefined);
    assert.strictEqual(s.installations, 3);          // it still counts as an install
  });
});
