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

// Parse "v1.2.3-beta.4+build" -> {maj,min,pat,pre:[...]} (build metadata,
// after '+', is ignored for precedence per semver).  Missing parts are 0/[].
function parse(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  const core = s.split('+')[0];
  const dash = core.indexOf('-');
  const nums = (dash < 0 ? core : core.slice(0, dash)).split('.');
  const pre = dash < 0 ? [] : core.slice(dash + 1).split('.').filter(x => x !== '');
  return {
    maj: parseInt(nums[0], 10) || 0,
    min: parseInt(nums[1], 10) || 0,
    pat: parseInt(nums[2], 10) || 0,
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

module.exports = { parse, isStable, cmp, shouldPromote };
