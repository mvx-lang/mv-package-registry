// mv-package-registry — semver helpers + release-channel promotion.
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// The registry's default ("latest") version follows the STABLE series so that
// an unconstrained `MVPKG install <pkg>` never lands on an alpha/beta/dev, while
// those pre-releases stay installable by an explicit version or constraint.
//
//   node --test test/semver.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const semver = require('../lib/semver');

test('isStable distinguishes releases from pre-releases', () => {
  for (const v of ['1.0.0', '2.3.4', 'v1.2.3', '10.0.0+build.7'])
    assert.equal(semver.isStable(v), true, `${v} should be stable`);
  for (const v of ['1.0.0-alpha', '1.0.0-beta.2', '2.0.0-dev', '1.2.0-rc.1'])
    assert.equal(semver.isStable(v), false, `${v} should be a pre-release`);
});

test('cmp orders by major.minor.patch', () => {
  assert.equal(semver.cmp('1.0.0', '2.0.0'), -1);
  assert.equal(semver.cmp('1.2.0', '1.1.9'), 1);
  assert.equal(semver.cmp('1.4.2', '1.4.2'), 0);
  assert.equal(semver.cmp('v1.4.0', '1.4.0'), 0);   // leading v ignored
});

test('cmp ranks a pre-release below its release', () => {
  assert.equal(semver.cmp('1.0.0-beta', '1.0.0'), -1);
  assert.equal(semver.cmp('1.0.0', '1.0.0-rc.1'), 1);
  // pre-release identifier precedence (semver spec example)
  assert.equal(semver.cmp('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(semver.cmp('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(semver.cmp('1.0.0-alpha.beta', '1.0.0-beta'), -1);
  assert.equal(semver.cmp('1.0.0-beta.2', '1.0.0-beta.11'), -1); // numeric, not lexical
});

test('a newest-first sort keeps stable ahead of an equal-core pre-release', () => {
  const vs = ['1.0.0-beta.1', '2.0.0', '1.4.2', '1.0.0', '1.0.0-alpha'];
  vs.sort((a, b) => semver.cmp(b, a));
  assert.deepEqual(vs, ['2.0.0', '1.4.2', '1.0.0', '1.0.0-beta.1', '1.0.0-alpha']);
});

test('shouldPromote: first release of any kind becomes the default', () => {
  assert.equal(semver.shouldPromote('', '1.0.0'), true);
  assert.equal(semver.shouldPromote('', '1.0.0-beta.1'), true); // beta-only pkg is installable
});

test('shouldPromote: a pre-release never displaces a default', () => {
  assert.equal(semver.shouldPromote('1.4.0', '2.0.0-beta.1'), false);
  assert.equal(semver.shouldPromote('1.4.0', '1.5.0-rc.1'), false);
});

test('shouldPromote: first stable supersedes a pre-release default', () => {
  assert.equal(semver.shouldPromote('2.0.0-beta.3', '1.4.0'), true);
});

test('shouldPromote: newer stable wins, older stable does not regress', () => {
  assert.equal(semver.shouldPromote('1.4.0', '1.5.0'), true);
  assert.equal(semver.shouldPromote('1.4.0', '1.4.0'), true);  // re-index of current
  assert.equal(semver.shouldPromote('1.4.0', '1.3.9'), false); // out-of-order back-port
});
