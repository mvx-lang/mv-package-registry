// GitHub App onboarding — the crypto-critical, network-free surface.
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const ghapp = require('../lib/ghapp');

test('buildManifest points its single webhook + redirect at us', () => {
  const m = ghapp.buildManifest('https://reg.example');
  assert.strictEqual(m.hook_attributes.url, 'https://reg.example/gh/app/hook');
  assert.strictEqual(m.redirect_url, 'https://reg.example/gh/app/created');
  assert.ok(m.default_events.includes('release'));
  // installation events are auto-delivered — GitHub rejects them in default_events
  assert.ok(!m.default_events.includes('installation'));
  assert.strictEqual(m.default_permissions.contents, 'read');   // required for release events
});

test('appJwt is a valid RS256 JWT the App public key verifies', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const jwt = ghapp.appJwt(424242, pem);
  const [h, p, s] = jwt.split('.');
  assert.strictEqual(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  const pay = JSON.parse(Buffer.from(p, 'base64url'));
  assert.strictEqual(pay.iss, '424242');
  assert.ok(pay.exp > pay.iat);
  assert.ok(crypto.createVerify('RSA-SHA256').update(h + '.' + p).verify(publicKey, Buffer.from(s, 'base64url')));
});

const SECRET = 'whsec_test';
const sign = b => 'sha256=' + crypto.createHmac('sha256', SECRET).update(b).digest('hex');

test('parseEvent accepts a correctly-signed release and keys it by repo', () => {
  const body = Buffer.from(JSON.stringify({
    action: 'published', repository: { full_name: 'mvx-lang/curl' },
    release: { tag_name: 'v1.2.0', published_at: '2026-08-08T00:00:00Z', html_url: 'https://h',
      assets: [{ name: 'a.tar.gz', browser_download_url: 'https://z', size: 10 }] },
  }));
  const v = ghapp.parseEvent(SECRET, { 'x-hub-signature-256': sign(body), 'x-github-event': 'release' }, body);
  assert.ok(v.valid && v.release);
  assert.strictEqual(v.release.repo, 'mvx-lang/curl');
  assert.strictEqual(v.release.release.version, '1.2.0');       // 'v' stripped
  assert.strictEqual(v.release.release.assets.length, 1);
});

test('parseEvent rejects a bad signature', () => {
  const body = Buffer.from(JSON.stringify({ action: 'published', repository: {}, release: {} }));
  assert.strictEqual(ghapp.parseEvent(SECRET, { 'x-hub-signature-256': 'sha256=bad', 'x-github-event': 'release' }, body).valid, false);
});

test('parseEvent recognises ping and installation events', () => {
  const ping = Buffer.from(JSON.stringify({ zen: 'hi' }));
  assert.ok(ghapp.parseEvent(SECRET, { 'x-hub-signature-256': sign(ping), 'x-github-event': 'ping' }, ping).ping);

  const inst = Buffer.from(JSON.stringify({
    action: 'created',
    installation: { id: 999, account: { login: 'mvx-lang' }, repository_selection: 'selected' },
    repositories: [{ full_name: 'mvx-lang/curl' }, { full_name: 'mvx-lang/json' }],
  }));
  const v = ghapp.parseEvent(SECRET, { 'x-hub-signature-256': sign(inst), 'x-github-event': 'installation' }, inst);
  assert.ok(v.install);
  assert.strictEqual(v.install.account, 'mvx-lang');
  assert.strictEqual(v.install.selection, 'selected');
  assert.deepStrictEqual(v.install.repos, ['mvx-lang/curl', 'mvx-lang/json']);
});
