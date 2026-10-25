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

// ---------------------------------------------------------------------------
// BRANCH DEV VERSIONS (mvx#364)
//
// The nightly used to move a tag called `dev`, and `dev` parsed as 0.0.0 with
// NO pre-release -- a *stable* version zero.  `isStable('dev')` was true, a
// bare `*` constraint admitted it, and for a package with no release yet
// shouldPromote made it the default.  Composer's answer is `1.4.x-dev`: the
// top of the 1.4 branch, above every release on it and below 1.5.0.
// ---------------------------------------------------------------------------
test('a bare branch name is not a version, and is not stable', () => {
  // What the old tag did, kept as a case so it cannot come back quietly.
  assert.equal(semver.isStable('dev'), true, 'historical: `dev` read as stable 0.0.0');
  assert.equal(semver.isStable('1.4.x-dev'), false, 'a branch dev version is a pre-release');
});

test('a branch dev version is the top of its branch', () => {
  assert.equal(semver.cmp('1.4.x-dev', '1.4.0'), 1, 'above the branch base');
  assert.equal(semver.cmp('1.4.x-dev', '1.4.99'), 1, 'above every release on the branch');
  assert.equal(semver.cmp('1.4.x-dev', '1.5.0'), -1, 'below the next minor');
  assert.equal(semver.cmp('1.4.x-dev', '1.4.0-beta.1'), 1, 'above a pre-release of the base');
  assert.equal(semver.cmp('1.x-dev', '1.99.99'), 1, 'a major branch covers its minors');
  assert.equal(semver.cmp('1.x-dev', '2.0.0'), -1, 'and stops at the next major');
});

test('the x is only a branch marker WITH a pre-release suffix, so constraints are untouched', () => {
  // `1.4.*` and `1.4.x` are CONSTRAINTS meaning "any 1.4 release" -- the other
  // end of the range from `1.4.x-dev`.  Requiring the dash is what keeps the
  // two apart; without it every wildcard constraint would become 1.4.9999999.
  for (const c of ['1.4.x', '1.4.*', '1.4']) {
    const p = semver.parse(c);
    assert.equal(p.pat, 0, `${c} must not pick up the branch sentinel`);
    assert.equal(semver.isStable(c), true, `${c} is not a pre-release`);
  }
});

test('a branch dev version never becomes a package default', () => {
  assert.equal(semver.shouldPromote('1.4.0', '1.4.x-dev'), false);
  assert.equal(semver.shouldPromote('1.4.0', '1.5.x-dev'), false);
  // and a real release still supersedes one that got in first
  assert.equal(semver.shouldPromote('1.4.x-dev', '1.4.1'), true);
});

test('build metadata on a branch dev version is still ignored for precedence', () => {
  assert.equal(semver.cmp('1.4.x-dev+gabc1234', '1.4.x-dev'), 0);
  assert.equal(semver.cmp('1.4.x-dev+gabc1234', '1.4.0'), 1);
});
