// mv-package-registry — auth + publish test suite (dependency-free).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// Runs the real server on a throwaway registry dir and drives it over HTTP:
//   - register / password login / signed-cookie session
//   - passkeys (WebAuthn): register + login, driven by a SOFTWARE
//     authenticator built here from Node crypto (an EC P-256 key, a hand-rolled
//     CBOR encoder for the attestation object and COSE key) — so the whole
//     ceremony is exercised with no browser and no external dependency
//   - publish (add a package by source URL): first publisher owns it, a second
//     user is refused, and only the owner (or admin) may remove it
//
//   node --test test/auth.test.js
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
const b64u = b => Buffer.from(b).toString('base64url');

// ---- a free port -----------------------------------------------------
function freePort() {
  return new Promise(res => { const s = require('node:net').createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}

// ---- minimal CBOR encoder (only the shapes WebAuthn needs) -----------
function cInt(n, mt = n < 0 ? 1 : 0) {           // uint / negint
  const v = n < 0 ? -1 - n : n, h = mt << 5;
  if (v < 24) return Buffer.from([h | v]);
  if (v < 256) return Buffer.from([h | 24, v]);
  if (v < 65536) return Buffer.from([h | 25, v >> 8, v & 0xff]);
  const b = Buffer.alloc(5); b[0] = h | 26; b.writeUInt32BE(v >>> 0, 1); return b;
}
const cBytes = buf => Buffer.concat([cInt(buf.length, 2), buf]);
const cText = s => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([cInt(b.length, 3), b]); };
const cMap = pairs => Buffer.concat([cInt(pairs.length, 5), ...pairs.flat()]);

// ---- a software WebAuthn authenticator -------------------------------
// One EC P-256 credential; produces attestation (register) and assertions
// (login) that lib/webauthn.js verifies.
function makeAuthenticator(rpId) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
  const credId = crypto.randomBytes(20);
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  const cosePub = cMap([                           // COSE_Key for ES256
    [cInt(1), cInt(2)],    // kty: EC2
    [cInt(3), cInt(-7)],   // alg: ES256
    [cInt(-1), cInt(1)],   // crv: P-256
    [cInt(-2), cBytes(x)], // x
    [cInt(-3), cBytes(y)], // y
  ]);
  const authData = (flags, counter, attested) => {
    const head = Buffer.alloc(37);
    rpIdHash.copy(head, 0); head[32] = flags; head.writeUInt32BE(counter, 33);
    if (!attested) return head;
    const cred = Buffer.concat([Buffer.alloc(16),   // aaguid
      Buffer.from([credId.length >> 8, credId.length & 0xff]), credId, cosePub]);
    return Buffer.concat([head, cred]);
  };
  return {
    credId: b64u(credId),
    // register: return { clientDataJSON, attestationObject } (base64url)
    attestation(challenge, origin, counter = 5) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      const att = cMap([[cText('fmt'), cText('none')], [cText('attStmt'), cMap([])],
        [cText('authData'), cBytes(authData(0x45, counter, true))]]);   // UP|UV|AT
      return { clientDataJSON: b64u(clientData), attestationObject: b64u(att) };
    },
    // login: return { clientDataJSON, authenticatorData, signature } (base64url)
    assertion(challenge, origin, counter = 6) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
      const ad = authData(0x05, counter, false);     // UP|UV
      const signed = Buffer.concat([ad, crypto.createHash('sha256').update(clientData).digest()]);
      const signature = crypto.sign('sha256', signed, { key: privateKey, dsaEncoding: 'der' });
      return { clientDataJSON: b64u(clientData), authenticatorData: b64u(ad), signature: b64u(signature) };
    },
  };
}

// ---- HTTP client with a cookie jar -----------------------------------
function makeClient(port, host) {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const req = function req(method, urlPath, { body, json, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      let payload = body;
      if (json !== undefined) { payload = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
      const h = { Host: host, ...headers };
      if (jar.size) h.Cookie = cookieHeader();
      if (payload != null) h['Content-Length'] = Buffer.byteLength(payload);
      const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, res => {
        for (const sc of res.headers['set-cookie'] || []) {
          const [nv] = sc.split(';'); const i = nv.indexOf('=');
          const name = nv.slice(0, i), val = nv.slice(i + 1);
          if (val === '' || /Max-Age=0/i.test(sc)) jar.delete(name); else jar.set(name, val);
        }
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d, jar }));
      });
      r.on('error', reject);
      if (payload != null) r.write(payload);
      r.end();
    });
  };
  req.jar = jar;
  return req;
}

// ---- the suite -------------------------------------------------------
test('auth + publish', async (t) => {
  const port = await freePort();
  const host = `localhost:${port}`;             // rpId=localhost, origin=http://localhost:port
  const origin = `http://${host}`;
  const regdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvreg-'));

  // fixture manifest server — the generic provider fetches a bare mvpkg.json
  const fixture = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ name: 'demoscope/thing', description: 'a fixture package', license: 'GPL-2.0-only' }));
  });
  await new Promise(r => fixture.listen(0, r));
  const source = `http://127.0.0.1:${fixture.address().port}/mvpkg.json`;

  // start the real server on the throwaway registry dir
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(port)], {
    env: { ...process.env, MVPKG_REGISTRY_DIR: regdir, MVPKG_ADMIN_USERS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  srv.stdout.on('data', d => logs.push(d.toString()));
  srv.stderr.on('data', d => logs.push(d.toString()));

  const req = makeClient(port, host);
  // wait for listen
  for (let i = 0; i < 100; i++) {
    try { const r = await req('GET', '/'); if (r.status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }

  t.after(() => { srv.kill(); try { fixture.close(); } catch {} try { fs.rmSync(regdir, { recursive: true, force: true }); } catch {} });

  const form = o => new URLSearchParams(o).toString();
  const post = (p, o, extra) => req('POST', p, { body: form(o), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, ...extra });

  await t.test('register creates an account and a session', async () => {
    const r = await post('/register', { username: 'alice', email: 'alice@example.com', password: 'correcthorse' });
    assert.strictEqual(r.status, 302, logs.join(''));
    assert.strictEqual(r.headers.location, '/account');
    assert.ok(r.jar.has('mvpkg_session'), 'session cookie set');
    const acct = await req('GET', '/account');
    assert.strictEqual(acct.status, 200);
    assert.match(acct.body, /alice/);
  });

  await t.test('password login: wrong rejected, right accepted', async () => {
    const anon = makeClient(port, host);
    const bad = await anon('POST', '/login', { body: form({ username: 'alice', password: 'nope' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(bad.status, 401);
    assert.ok(!bad.jar.has('mvpkg_session'));
    const good = await anon('POST', '/login', { body: form({ username: 'alice', password: 'correcthorse' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(good.status, 302);
    assert.ok(good.jar.has('mvpkg_session'));
  });

  const auth = makeAuthenticator('localhost');
  await t.test('passkey registration (WebAuthn)', async () => {
    const opts = await req('GET', '/webauthn/register/options');
    assert.strictEqual(opts.status, 200);
    const { challenge } = JSON.parse(opts.body);
    assert.ok(challenge);
    const cred = auth.attestation(challenge, origin, 5);
    const v = await req('POST', '/webauthn/register/verify', { json: { name: 'yubi', response: cred } });
    assert.strictEqual(v.status, 200, v.body);
    assert.deepStrictEqual(JSON.parse(v.body), { ok: true });
    const acct = await req('GET', '/account');
    assert.match(acct.body, /yubi/, 'passkey listed on the account page');
  });

  await t.test('passkey login from a fresh (no-session) client', async () => {
    const anon = makeClient(port, host);
    const opts = await anon('GET', '/webauthn/login/options?username=alice');
    assert.strictEqual(opts.status, 200);
    const { challenge } = JSON.parse(opts.body);
    const asr = auth.assertion(challenge, origin, 6);
    const v = await anon('POST', '/webauthn/login/verify', { json: { id: auth.credId, response: asr } });
    assert.strictEqual(v.status, 200, v.body);
    assert.strictEqual(JSON.parse(v.body).username, 'alice');
    assert.ok(anon.jar.has('mvpkg_session'), 'passkey login set a session');
  });

  await t.test('passkey login rejects a bad signature', async () => {
    const anon = makeClient(port, host);
    const opts = await anon('GET', '/webauthn/login/options?username=alice');
    const { challenge } = JSON.parse(opts.body);
    const asr = auth.assertion(challenge, origin, 7);
    asr.signature = b64u(crypto.randomBytes(64));      // corrupt it
    const v = await anon('POST', '/webauthn/login/verify', { json: { id: auth.credId, response: asr } });
    assert.strictEqual(v.status, 401, v.body);
    assert.ok(!anon.jar.has('mvpkg_session'));
  });

  await t.test('publish: first publisher owns the package', async () => {
    const r = await post('/packages', { source });   // alice is signed in
    assert.strictEqual(r.status, 200, logs.join(''));
    const meta = JSON.parse(fs.readFileSync(path.join(regdir, 'demoscope', 'thing', 'meta.json'), 'utf8'));
    assert.strictEqual(meta.owner, 'alice');
  });

  await t.test('publish: a different user cannot claim an owned package', async () => {
    const bob = makeClient(port, host);
    await bob('POST', '/register', { body: form({ username: 'bob', email: 'bob@example.com', password: 'correcthorse2' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const r = await bob('POST', '/packages', { body: form({ source }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /owned by alice/i);
    const meta = JSON.parse(fs.readFileSync(path.join(regdir, 'demoscope', 'thing', 'meta.json'), 'utf8'));
    assert.strictEqual(meta.owner, 'alice', 'owner unchanged');
  });

  await t.test('remove: non-owner cannot, owner can', async () => {
    const bob = makeClient(port, host);
    await bob('POST', '/login', { body: form({ username: 'bob', password: 'correcthorse2' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    await bob('POST', '/packages/remove', { body: form({ name: 'demoscope/thing' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.ok(fs.existsSync(path.join(regdir, 'demoscope', 'thing', 'meta.json')), 'bob could not remove');
    await post('/packages/remove', { name: 'demoscope/thing' });   // alice, the owner
    assert.ok(!fs.existsSync(path.join(regdir, 'demoscope', 'thing')), 'owner removed it');
  });

  await t.test('logout clears the session', async () => {
    const r = await post('/logout', {});
    assert.strictEqual(r.status, 302);
    const acct = await req('GET', '/account');
    assert.strictEqual(acct.status, 302);            // redirected to /login
    assert.match(acct.headers.location, /login/);
  });
});
