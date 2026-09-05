// mv-package-registry — the release page walk (dependency-free, no network).
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// listReleases asked GitHub for ?per_page=30 and stopped, so a repo with more
// releases than that had a history that simply ended.  mvpkg has 51: after the
// per-version artifact indexing (#41) exactly the newest 30 of its 45 known
// versions had artifacts and the older 15 had none.  Those versions then fell
// back to a guessed URL, which is the thing #41 exists to stop.
//
//   node --test test/releasepages.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const gh = require('../lib/github.js');

// A fake GitHub holding `n` releases, answering RELPAGE at a time.  Records the
// pages actually asked for, because "did it stop at the right place" is half of
// what is being tested.
function fakeGithub(n, opts = {}) {
  const asked = [];
  const rel = i => ({ tag_name: `1.0.${i}`, name: `1.0.${i}`, published_at: 't',
                      tarball_url: `https://gh/${i}.tar.gz`, html_url: 'h',
                      assets: [], draft: !!(opts.draftAt && opts.draftAt(i)) });
  const all = Array.from({ length: n }, (_, i) => rel(i));
  const fetchPage = (p, cb) => {
    asked.push(p);
    if (opts.notFoundAt === p) return cb(null, 404, null);
    const start = (p - 1) * gh.RELPAGE;
    process.nextTick(() => cb(null, 200, all.slice(start, start + gh.RELPAGE)));
  };
  return { fetchPage, asked };
}
const walk = f => new Promise((res, rej) =>
  gh.walkReleasePages(f, (e, out) => e ? rej(e) : res(out)));

test('a repo with more releases than one page returns all of them', async () => {
  const g = fakeGithub(gh.RELPAGE * 2 + 7);
  const out = await walk(g.fetchPage);
  assert.equal(out.length, gh.RELPAGE * 2 + 7);
  assert.deepEqual(g.asked, [1, 2, 3]);           // stopped at the short page
  assert.equal(out[0].tag, '1.0.0');              // and kept them in order
  assert.equal(out[out.length - 1].tag, `1.0.${gh.RELPAGE * 2 + 6}`);
});

test('a repo that fits in one page costs one call', async () => {
  const g = fakeGithub(12);
  const out = await walk(g.fetchPage);
  assert.equal(out.length, 12);
  assert.deepEqual(g.asked, [1]);
});

test('an exactly-full page asks once more, and the empty page ends it', async () => {
  // The boundary the "short page" rule exists for: RELPAGE releases is not
  // evidence that there are no more.
  const g = fakeGithub(gh.RELPAGE);
  const out = await walk(g.fetchPage);
  assert.equal(out.length, gh.RELPAGE);
  assert.deepEqual(g.asked, [1, 2]);
});

test('a page of drafts does not end the walk early', async () => {
  // Drafts are dropped AFTER the length test.  Filtering first would make a
  // full page of drafts look short and silently truncate the history.
  const g = fakeGithub(gh.RELPAGE * 2, { draftAt: i => i < gh.RELPAGE });
  const out = await walk(g.fetchPage);
  assert.equal(out.length, gh.RELPAGE);           // the drafts are gone
  assert.deepEqual(g.asked, [1, 2, 3]);           // but page 2 was still read
});

test('the walk is capped, so one refresh cannot crawl forever', async () => {
  const g = fakeGithub(gh.RELPAGE * (gh.MAXPAGES + 5));
  const out = await walk(g.fetchPage);
  assert.equal(g.asked.length, gh.MAXPAGES);
  assert.equal(out.length, gh.RELPAGE * gh.MAXPAGES);
});

test('a 404 mid-walk keeps what was already read', async () => {
  const g = fakeGithub(gh.RELPAGE * 3, { notFoundAt: 3 });
  const out = await walk(g.fetchPage);
  assert.equal(out.length, gh.RELPAGE * 2);
});
