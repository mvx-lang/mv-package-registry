// mv_package registry — GitHub integration, dependency-free.
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
//
// Poll a repo for its latest release (unauthenticated works for public repos;
// set GITHUB_TOKEN for private repos / higher rate limits), and verify the
// HMAC signature on a GitHub webhook delivery.
'use strict';
const https = require('https');
const crypto = require('crypto');

function apiGet(apiPath, cb) {
  const headers = { 'User-Agent': 'mv-package-registry', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const r = https.request({ hostname: 'api.github.com', path: apiPath, headers }, resp => {
    let d = ''; resp.on('data', c => d += c);
    resp.on('end', () => { let body = null; try { body = JSON.parse(d); } catch {} cb(null, resp.statusCode, body); });
  });
  r.on('error', e => cb(e));
  r.setTimeout(8000, () => { r.destroy(); cb(new Error('timeout')); });
  r.end();
}

// cb(err, release|null) — null when the repo has no published release.
function latestRelease(repo, cb) {
  apiGet(`/repos/${repo}/releases/latest`, (err, code, body) => {
    if (err) return cb(err);
    if (code === 404) return cb(null, null);
    if (code !== 200) return cb(new Error('github ' + code + (body && body.message ? ': ' + body.message : '')));
    cb(null, releaseInfo(body));
  });
}
const releaseInfo = b => ({
  tag: b.tag_name, name: b.name || b.tag_name, at: b.published_at,
  tarball: b.tarball_url, html: b.html_url, prerelease: !!b.prerelease,
});

// Verify a GitHub webhook body against its X-Hub-Signature-256 header.
function verifyWebhook(secret, sigHeader, bodyBuf) {
  if (!secret || !sigHeader) return false;
  const mac = 'sha256=' + crypto.createHmac('sha256', secret).update(bodyBuf).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(String(sigHeader))); } catch { return false; }
}

const okRepo = r => /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(r));

module.exports = { latestRelease, verifyWebhook, releaseInfo, okRepo };
