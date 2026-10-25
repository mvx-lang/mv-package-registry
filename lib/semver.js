// mv-package-registry — minimal semver helpers for release-channel handling.
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// Just enough of the spec to (a) tell a stable version from a pre-release
// (alpha/beta/dev/rc — anything with a `-` suffix) and (b) order versions by
// precedence, including pre-release ordering (1.0.0-alpha < 1.0.0-beta.2 <
// 1.0.0).  Used to pick a package's DEFAULT ("latest") version as the newest
// STABLE release, so `MVPKG install <pkg>` follows the stable series while
// pre-releases stay installable by an explicit version or constraint.
'use strict';

// Composer's sentinel for "the top of this branch".  A branch dev version is
// not a pre-release of one particular patch -- it is every commit on that line
// that has not been released yet -- so it has to sort ABOVE every release on
// the branch and below the next one up.  Composer does that by normalising
// `1.4.x-dev` to `1.4.9999999.9999999-dev`; these three-component parsers put
// the sentinel in the components the `x` covers.
const BRANCH_TOP = 9999999;

// Parse "v1.2.3-beta.4+build" -> {maj,min,pat,pre:[...]} (build metadata,
// after '+', is ignored for precedence per semver).  Missing parts are 0/[].
//
// A BRANCH DEV VERSION is Composer's `1.4.x-dev` (mvx#364): an `x` in a
// numeric position, WITH a pre-release suffix, means that component and every
// one after it is the top of the branch.  So `1.4.x-dev` is newer than every
// 1.4.* release and older than 1.5.0, which is what a nightly built from a
// branch actually is.
//
// THE `-dev` IS REQUIRED, and that is what keeps constraints out of this.  A
// constraint writes the same idea without a suffix (`1.4.*`, `1.4.x`) and means
// "any 1.4 release" -- the opposite end of the range.  Needing the dash means
// no constraint can ever take this path.
function parse(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  const core = s.split('+')[0];
  const dash = core.indexOf('-');
  const nums = (dash < 0 ? core : core.slice(0, dash)).split('.');
  const pre = dash < 0 ? [] : core.slice(dash + 1).split('.').filter(x => x !== '');
  let branch = false;
  const n = nums.map(part => {
    if (pre.length && (branch || part === 'x' || part === 'X')) { branch = true; return BRANCH_TOP; }
    return parseInt(part, 10) || 0;
  });
  const rest = branch ? BRANCH_TOP : 0;   // components the `x` swallowed
  return {
    maj: n.length > 0 ? n[0] : 0,
    min: n.length > 1 ? n[1] : rest,
    pat: n.length > 2 ? n[2] : rest,
    pre,
  };
}

// A stable version has no pre-release suffix.
function isStable(v) {
  return parse(v).pre.length === 0;
}

// Semver precedence: -1 if a<b, 0 if equal, 1 if a>b.  A version with a
// pre-release ranks BELOW the same version without one; among pre-releases,
// identifiers compare numerically when both numeric, else lexically, and a
// larger set of identifiers wins when all the leading ones are equal.
function cmp(a, b) {
  const A = parse(a), B = parse(b);
  if (A.maj !== B.maj) return A.maj < B.maj ? -1 : 1;
  if (A.min !== B.min) return A.min < B.min ? -1 : 1;
  if (A.pat !== B.pat) return A.pat < B.pat ? -1 : 1;
  if (!A.pre.length && !B.pre.length) return 0;
  if (!A.pre.length) return 1;              // stable > pre-release
  if (!B.pre.length) return -1;
  const n = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < n; i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;         // fewer identifiers = lower
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) return d < 0 ? -1 : 1; }
    else if (xn) return -1;                 // numeric < alphanumeric
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Decide whether an incoming release `version` should become a package's
// default ("latest") version, given the current default `cur`.  The default
// follows the STABLE series: a pre-release (alpha/beta/dev/rc) is recorded in
// the version history but only becomes the default when there is no stable
// release yet (so a pre-release-only package is still installable); it never
// displaces an existing stable default, and a stable release only promotes when
// it is newer than the current stable (no regression on an out-of-order
// back-port).
function shouldPromote(cur, version) {
  if (!cur) return true;                // first release of any kind
  if (!isStable(version)) return false; // a pre-release never displaces a default
  if (!isStable(cur)) return true;      // first stable supersedes a pre-release default
  return cmp(version, cur) >= 0;        // newer (or equal) stable wins
}

module.exports = { parse, isStable, cmp, shouldPromote, BRANCH_TOP };
