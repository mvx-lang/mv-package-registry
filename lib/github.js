// mv_package registry — GitHub integration, dependency-free.
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
//
// Poll a repo for its latest release (unauthenticated works for public repos;
// set GITHUB_TOKEN for private repos / higher rate limits), and verify the
// HMAC signature on a GitHub webhook delivery.
'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// Parse whatever the user pasted into a connect target.  Accepts a GitHub repo
// URL, bare owner/repo, a blob/tree/raw URL, an SSH remote, or a plain http(s)
// URL to an mvpkg.json.  Returns { repo?: "owner/repo", github: bool,
// mvpkgUrl?: string } — repo set (github:true) means we can install a webhook.
function parseConnect(input) {
  const s = String(input || '').trim();
  let m;
  if ((m = s.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/(.+)$/i)))
    return { repo: `${m[1]}/${m[2]}`, github: true, file: m[3] };
  if ((m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(?:blob|tree)\/[^/]+\/(.+?))?(?:[#?].*)?$/i)))
    return { repo: `${m[1]}/${m[2]}`, github: true, file: m[3] || null };
  if ((m = s.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i)))
    return { repo: `${m[1]}/${m[2]}`, github: true };
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return { repo: s, github: true };   // bare owner/repo
  if (/^https?:\/\//i.test(s)) return { mvpkgUrl: s, github: false };   // a manifest URL elsewhere
  return {};
}

function apiSend(method, apiPath, bodyObj, cb) {
  const headers = { 'User-Agent': 'mv-package-registry', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const data = bodyObj ? JSON.stringify(bodyObj) : '';
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
  const r = https.request({ method, hostname: 'api.github.com', path: apiPath, headers }, resp => {
    let d = ''; resp.on('data', c => d += c);
    resp.on('end', () => { let body = null; try { body = JSON.parse(d); } catch {} cb(null, resp.statusCode, body); });
  });
  r.on('error', e => cb(e));
  r.setTimeout(8000, () => { r.destroy(); cb(new Error('timeout')); });
  if (data) r.write(data);
  r.end();
}
const apiGet = (apiPath, cb) => apiSend('GET', apiPath, null, cb);

// Install a release webhook on the repo so the registry is notified the moment
// a release is published (no manual GitHub setup).  cb(err, {id}) on success.
// Needs a GITHUB_TOKEN with admin:repo_hook (classic) or fine-grained
// "Webhooks: read and write" on the repo.
function createWebhook(repo, url, secret, cb) {
  if (!process.env.GITHUB_TOKEN) return cb(new Error('no GITHUB_TOKEN configured'));
  apiSend('POST', `/repos/${repo}/hooks`, {
    name: 'web', active: true, events: ['release'],
    config: { url, content_type: 'json', secret, insecure_ssl: '0' },
  }, (err, code, body) => {
    if (err) return cb(err);
    if (code === 201 && body && body.id) return cb(null, { id: body.id });
    // 422 with "Hook already exists" is a benign re-connect — treat as success.
    if (code === 422 && body && /already exists/i.test(body.message || '')) return cb(null, { id: null, existed: true });
    cb(new Error('github ' + code + (body && body.message ? ': ' + body.message : '')));
  });
}

// Remove a webhook we installed (best effort; 404 = already gone).
function deleteWebhook(repo, id, cb) {
  if (!process.env.GITHUB_TOKEN || !id) return cb(null);
  apiSend('DELETE', `/repos/${repo}/hooks/${id}`, null, (err, code) =>
    err ? cb(err) : cb(null, code === 204 || code === 404));
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
  // release assets the registry can index as external artifacts (it links the
  // URL; GitHub hosts the bytes).  name drives the artifact key; url is the
  // stable public download.
  assets: (b.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size })),
});

// Verify a GitHub webhook body against its X-Hub-Signature-256 header.
function verifyWebhook(secret, sigHeader, bodyBuf) {
  if (!secret || !sigHeader) return false;
  const mac = 'sha256=' + crypto.createHmac('sha256', secret).update(bodyBuf).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(String(sigHeader))); } catch { return false; }
}

const okRepo = r => /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(r));

// Read a file from a repo (default branch) via the contents API.
// cb(err, text|null) — null when the file is absent.
function repoFile(repo, filePath, cb) {
  apiSend('GET', `/repos/${repo}/contents/${filePath}`, null, (err, code, body) => {
    if (err) return cb(err);
    if (code === 404) return cb(null, null);
    if (code !== 200 || !body || body.content == null) return cb(new Error('github ' + code + (body && body.message ? ': ' + body.message : '')));
    try { cb(null, Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')); }
    catch (e) { cb(e); }
  });
}

// GET a small http(s) file (an mvpkg.json somewhere) -> cb(err, text).
// Follows a few redirects; caps the body at 1 MiB.
function fetchUrl(u, cb, depth) {
  let parsed; try { parsed = new URL(u); } catch { return cb(new Error('bad url')); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return cb(new Error('only http(s) URLs'));
  const mod = parsed.protocol === 'https:' ? https : http;
  const r = mod.get(u, { headers: { 'User-Agent': 'mv-package-registry' } }, resp => {
    if ([301, 302, 307, 308].includes(resp.statusCode) && resp.headers.location && (depth || 0) < 3) {
      resp.resume(); return fetchUrl(new URL(resp.headers.location, u).toString(), cb, (depth || 0) + 1);
    }
    if (resp.statusCode !== 200) { resp.resume(); return cb(new Error('http ' + resp.statusCode)); }
    let d = '', n = 0, over = false;
    resp.on('data', c => { n += c.length; if (n > (1 << 20)) { over = true; r.destroy(); } else d += c; });
    resp.on('end', () => over ? cb(new Error('too large')) : cb(null, d));
  });
  r.on('error', e => cb(e));
  r.setTimeout(8000, () => { r.destroy(); cb(new Error('timeout')); });
}

module.exports = { latestRelease, verifyWebhook, releaseInfo, okRepo, createWebhook, deleteWebhook, parseConnect, repoFile, fetchUrl };
