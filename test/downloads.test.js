// mv-package-registry — download counts (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// The registry indexes rather than hosts, so a download never passes through
// it: these are the provider's per-asset counts, carried onto each indexed
// artifact so the number sits with the platform it belongs to.
//
//   node --test test/downloads.test.js
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

test('downloads: per artifact, totalled, and grouped by platform', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvdl-'));
  fs.mkdirSync(path.join(regdir, 'mvx-lang', 'getopt'), { recursive: true });
  fs.writeFileSync(path.join(regdir, 'mvx-lang', 'getopt', 'meta.json'), JSON.stringify({
    name: 'mvx-lang/getopt', owner: 'gordon', version: '1.1.0',
    systems: ['uv', 'udt', 'jbase'], tarball: 'https://x/s.tar.gz',
    artifacts: [
      { kind: 'source', tarball: 'https://x/s.tar.gz', downloads: 1 },
      { kind: 'binary', system: 'uv', os: 'any', arch: 'any', endian: 'le', tarball: 'https://x/uv.tar.gz', downloads: 11 },
      { kind: 'binary', system: 'jbase', os: 'any', arch: 'any', endian: 'le', tarball: 'https://x/jb.tar.gz', downloads: 10 },
      { kind: 'binary', system: 'udt', os: 'any', arch: 'any', endian: 'le', tarball: 'https://x/udt.tar.gz', downloads: 2 },
    ],
    versions: [{ version: '1.1.0', tag: '1.1.0' }],
  }, null, 2));
  // a package whose artifacts predate this feature: no downloads key at all
  fs.mkdirSync(path.join(regdir, 'mvx-lang', 'old'), { recursive: true });
  fs.writeFileSync(path.join(regdir, 'mvx-lang', 'old', 'meta.json'), JSON.stringify({
    name: 'mvx-lang/old', owner: 'gordon', version: '1.0', tarball: 'https://x/o.tar.gz',
    artifacts: [{ kind: 'source', tarball: 'https://x/o.tar.gz' }],
    versions: [{ version: '1.0', tag: '1.0' }],
  }, null, 2));

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) { try { if ((await get(port, host, '/')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  t.after(() => { srv.kill(); try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  await t.test('the total is every artifact of the indexed release', async () => {
    const j = JSON.parse((await get(port, host, '/package/mvx-lang/getopt')).body);
    assert.strictEqual(j.downloads, 24);            // 1 + 11 + 10 + 2
  });

  await t.test('grouped by platform, which is the part that says something', async () => {
    const j = JSON.parse((await get(port, host, '/package/mvx-lang/getopt')).body);
    assert.deepStrictEqual(j.downloadsBy, { source: 1, uv: 11, jbase: 10, udt: 2 });
  });

  await t.test('a package indexed before this feature reads as zero, not broken', async () => {
    const j = JSON.parse((await get(port, host, '/package/mvx-lang/old')).body);
    assert.strictEqual(j.downloads, 0);
    assert.deepStrictEqual(j.downloadsBy, {});
  });

  await t.test('the page shows the count beside the artifact it belongs to', async () => {
    const html = (await get(port, host, '/p/mvx-lang/getopt')).body;
    assert.ok(html.includes('uv.tar.gz'), 'the uv artifact is linked');
    assert.ok(/11/.test(html), 'its count is rendered');
    assert.ok(html.includes('24'), 'and the total');
  });

  await t.test('artifact selection is untouched by the extra field', async () => {
    const j = JSON.parse((await get(port, host, '/package/mvx-lang/getopt?system=uv&os=linux&arch=x86_64&endian=le')).body);
    assert.strictEqual(j.selected, 'binary');
    assert.strictEqual(j.tarball, 'https://x/uv.tar.gz');
  });
});
