// Source providers for the mv_package index.  A provider recognises a pasted
// source URL, reads the package's mvpkg.json, finds its releases, and — where
// the host supports it — installs push tracking (a release webhook).  The
// registry hosts nothing: it points at whatever the provider returns.
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
'use strict';
const https = require('https');
const gh = require('./github');

const relFromGh = rel => rel && {
  version: String(rel.tag || '').replace(/^v/, ''), tag: rel.tag, at: rel.at,
  html: rel.html, assets: rel.assets || [],
};

// ---- GitHub (full: manifest + releases + webhook) ---------------------
const github = {
  name: 'github',
  match(url) {
    const r = gh.parseConnect(url);
    return r && r.github && r.repo ? { repo: r.repo, file: r.file || null } : null;
  },
  sourceUrl: ref => `https://github.com/${ref.repo}`,
  fetchManifest(ref, cb) {
    gh.repoFile(ref.repo, (ref.file && /mvpkg\.json$/i.test(ref.file)) ? ref.file : 'mvpkg.json', cb);
  },
  fetchFile(ref, path, cb) { gh.repoFile(ref.repo, path, cb); },
  latestRelease(ref, cb) { gh.latestRelease(ref.repo, (e, rel) => e ? cb(e) : cb(null, relFromGh(rel))); },
  // release history, newest first: [{version, tag, at, html}, ...]
  listVersions(ref, cb) {
    gh.listReleases(ref.repo, (e, rels) => e ? cb(e)
      : cb(null, (rels || []).map(r => ({ version: String(r.tag || '').replace(/^v/, ''), tag: r.tag, at: r.at, html: r.html }))));
  },
  // dev version: the default branch's source archive, when there is no release.
  devVersion(ref, cb) {
    gh.defaultBranch(ref.repo, (e, branch) => {
      if (e || !branch) return cb(e || new Error('no default branch'));
      cb(null, { version: 'dev-' + branch, branch, tarball: `https://github.com/${ref.repo}/archive/refs/heads/${branch}.tar.gz` });
    });
  },
  supportsTracking: true,
  installTracking(ref, opts, cb) { gh.createWebhook(ref.repo, opts.hookUrl, opts.secret, cb); },
  removeTracking(ref, state, cb) { gh.deleteWebhook(ref.repo, state && state.hookId, cb); },
  // verifyEvent(secret, headers, rawBody) -> { valid, ping?, release? }
  verifyEvent(secret, headers, body) {
    if (!gh.verifyWebhook(secret, headers['x-hub-signature-256'], body)) return { valid: false };
    const event = headers['x-github-event'];
    if (event === 'ping') return { valid: true, ping: true };
    if (event !== 'release') return { valid: true };
    let p; try { p = JSON.parse(body.toString()); } catch { return { valid: true }; }
    if (p && p.release && ['published', 'released', 'created'].includes(p.action))
      return { valid: true, release: relFromGh(gh.releaseInfo(p.release)) };
    return { valid: true };
  },
};

// ---- GitLab (manifest + releases via the API; poll-based, no webhook yet) --
function glGet(apiPath, cb) {
  const headers = { 'User-Agent': 'mv-package-registry', Accept: 'application/json' };
  if (process.env.GITLAB_TOKEN) headers['PRIVATE-TOKEN'] = process.env.GITLAB_TOKEN;
  const r = https.request({ hostname: 'gitlab.com', path: '/api/v4' + apiPath, headers }, resp => {
    let d = ''; resp.on('data', c => d += c);
    resp.on('end', () => { let b = null; try { b = JSON.parse(d); } catch {} cb(null, resp.statusCode, b); });
  });
  r.on('error', e => cb(e));
  r.setTimeout(8000, () => { r.destroy(); cb(new Error('timeout')); });
  r.end();
}
const gitlab = {
  name: 'gitlab',
  match(url) {
    const m = String(url || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?gitlab\.com\/([\w][\w./-]*?)(?:\.git)?(?:\/-\/(?:blob|raw|tree)\/[^/]+\/(.+?))?(?:[#?].*)?$/i);
    return m ? { path: m[1].replace(/\/+$/, ''), file: m[2] || null } : null;
  },
  sourceUrl: ref => `https://gitlab.com/${ref.path}`,
  fetchManifest(ref, cb) {
    const f = (ref.file && /mvpkg\.json$/i.test(ref.file)) ? ref.file : 'mvpkg.json';
    gh.fetchUrl(`https://gitlab.com/${ref.path}/-/raw/HEAD/${f}`, cb);
  },
  fetchFile(ref, path, cb) { gh.fetchUrl(`https://gitlab.com/${ref.path}/-/raw/HEAD/${path}`, cb); },
  latestRelease(ref, cb) {
    glGet(`/projects/${encodeURIComponent(ref.path)}/releases?per_page=1`, (e, code, body) => {
      if (e) return cb(e);
      if (!Array.isArray(body) || !body.length) return cb(null, null);
      const r = body[0];
      const assets = ((r.assets && r.assets.links) || []).map(l => ({ name: l.name, url: l.direct_asset_url || l.url }));
      cb(null, { version: String(r.tag_name || '').replace(/^v/, ''), tag: r.tag_name, at: r.released_at, html: r._links && r._links.self, assets });
    });
  },
  devVersion(ref, cb) {
    glGet(`/projects/${encodeURIComponent(ref.path)}`, (e, code, body) => {
      if (e || code !== 200 || !body || !body.default_branch) return cb(e || new Error('gitlab ' + code));
      const branch = body.default_branch, name = ref.path.split('/').pop();
      cb(null, { version: 'dev-' + branch, branch, tarball: `https://gitlab.com/${ref.path}/-/archive/${branch}/${name}-${branch}.tar.gz` });
    });
  },
  listVersions(ref, cb) {
    glGet(`/projects/${encodeURIComponent(ref.path)}/releases?per_page=30`, (e, code, body) => {
      if (e || !Array.isArray(body)) return cb(null, []);
      cb(null, body.map(r => ({ version: String(r.tag_name || '').replace(/^v/, ''), tag: r.tag_name, at: r.released_at, html: r._links && r._links.self })));
    });
  },
  supportsTracking: false,
  verifyEvent() { return { valid: false }; },
};

// ---- generic manifest (fallback: a bare mvpkg.json URL, no release tracking) --
const manifest = {
  name: 'manifest',
  match(url) { const s = String(url || '').trim(); return /^https?:\/\//i.test(s) ? { url: s } : null; },
  sourceUrl: ref => ref.url,
  fetchManifest(ref, cb) { gh.fetchUrl(ref.url, cb); },
  latestRelease(ref, cb) { cb(null, null); },
  supportsTracking: false,
  verifyEvent() { return { valid: false }; },
};

const ALL = [github, gitlab, manifest];          // manifest is the catch-all — keep last
function resolve(url) {
  for (const p of ALL) { const ref = p.match(url); if (ref) return { provider: p, ref }; }
  return null;
}
module.exports = { resolve, byName: n => ALL.find(p => p.name === n) };
