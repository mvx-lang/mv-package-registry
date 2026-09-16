// mv-package-registry — changing an account password (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// A password could be set once at registration and never again (#57).  The
// interesting part is not the form but what a change has to invalidate:
// sessions are stateless signed values with no server-side store, so unless
// the session carries something derived from the password, changing it leaves
// anyone who already holds a session exactly where they were.
//
//   node --test test/password.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const qs = require('node:querystring');

const ROOT = path.join(__dirname, '..');
const freePort = () => new Promise(res => { const s = require('node:net').createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

function makeClient(port, host) {
  const jar = new Map();
  const req = (method, urlPath, form) => new Promise((resolve, reject) => {
    const payload = form ? qs.stringify(form) : null;
    const h = { Host: host };
    if (jar.size) h.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (payload != null) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, res => {
      for (const sc of res.headers['set-cookie'] || []) {
        const [nv] = sc.split(';'); const i = nv.indexOf('=');
        const name = nv.slice(0, i), val = nv.slice(i + 1);
        if (val === '' || /Max-Age=0/i.test(sc)) jar.delete(name); else jar.set(name, val);
      }
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, jar }));
    });
    r.on('error', reject);
    if (payload != null) r.write(payload);
    r.end();
  });
  req.jar = jar;
  return req;
}

test('a password can be changed, and the change ends other sessions', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpw-'));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)],
    { env: { ...process.env, MVPKG_REGISTRY_DIR: regdir }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { srv.kill(); fs.rmSync(regdir, { recursive: true, force: true }); });

  const a = makeClient(port, host);
  for (let i = 0; i < 60; i++) {
    try { await a('GET', '/'); break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }

  // --- register, which signs the first client in ---
  let r = await a('POST', '/register', { username: 'ann', email: 'ann@example.com', password: 'correct horse' });
  assert.ok(a.jar.has('mvpkg_session'), 'registration signs in');

  // --- a SECOND client, signed in as the same user on the old password ---
  const b = makeClient(port, host);
  r = await b('POST', '/login', { username: 'ann', password: 'correct horse' });
  assert.ok(b.jar.has('mvpkg_session'), 'second session established');
  r = await b('GET', '/account');
  assert.strictEqual(r.status, 200, 'second session works before the change');

  // --- the change is refused when it should be ---
  for (const [form, why] of [
    [{ current: 'wrong', password: 'a new password', confirm: 'a new password' }, 'wrong current password'],
    [{ current: 'correct horse', password: 'short', confirm: 'short' }, 'too short'],
    [{ current: 'correct horse', password: 'a new password', confirm: 'mismatched' }, 'confirmation mismatch'],
    [{ current: 'correct horse', password: 'correct horse', confirm: 'correct horse' }, 'unchanged'],
  ]) {
    r = await a('POST', '/account/password', form);
    assert.strictEqual(r.status, 400, `should refuse: ${why}`);
  }
  // ...and none of those changed anything: the old password still logs in.
  const probe = makeClient(port, host);
  r = await probe('POST', '/login', { username: 'ann', password: 'correct horse' });
  assert.ok(probe.jar.has('mvpkg_session'), 'a refused change leaves the password alone');

  // --- the change succeeds ---
  r = await a('POST', '/account/password',
    { current: 'correct horse', password: 'a longer new one', confirm: 'a longer new one' });
  assert.strictEqual(r.status, 200, 'the change is accepted');

  // --- the new password works, the old one does not ---
  const c1 = makeClient(port, host);
  await c1('POST', '/login', { username: 'ann', password: 'a longer new one' });
  assert.ok(c1.jar.has('mvpkg_session'), 'the new password signs in');
  const c2 = makeClient(port, host);
  await c2('POST', '/login', { username: 'ann', password: 'correct horse' });
  assert.ok(!c2.jar.has('mvpkg_session'), 'the old password no longer signs in');

  // --- THE POINT: the other session is dead, and the changing one is not ---
  r = await b('GET', '/account');
  assert.notStrictEqual(r.status, 200, 'the other session must be ended by the change');
  r = await a('GET', '/account');
  assert.strictEqual(r.status, 200, 'the session that made the change stays signed in');
});
