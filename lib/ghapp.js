// mv_package registry — GitHub App onboarding, dependency-free.
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
//
// A GitHub App replaces the per-repo Personal Access Token: it is created once
// (via GitHub's App-manifest flow — one click, no token to paste), installed on
// an org, and then delivers `release` events for EVERY installed repo to a
// single App-level webhook.  So the registry never creates a per-repo hook (the
// old `admin:repo_hook` PAT need — and its 403s — disappear), and adding a
// package "just works" as long as the App is installed on that repo's owner.
//
// This module is the GitHub side only: build the creation manifest, exchange
// the temporary manifest code for the App's credentials, sign App JWTs, list
// installations, and verify + parse an App webhook delivery.  Storage and
// routing live in server.js.
'use strict';
const https = require('https');
const crypto = require('crypto');
const gh = require('./github');

const b64url = buf => Buffer.from(buf).toString('base64url');

// api.github.com request with an optional bearer auth (a JWT, an installation
// token, or none for the unauthenticated manifest conversion).  cb(err, status, body).
function api(method, apiPath, auth, bodyObj, cb) {
  const headers = { 'User-Agent': 'mv-package-registry', Accept: 'application/vnd.github+json' };
  if (auth) headers.Authorization = 'Bearer ' + auth;
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

// The App-creation manifest.  Posted (as a form field) to github.com's
// settings/apps/new; GitHub creates the App and redirects to redirect_url with
// a temporary ?code=.  contents:read is what makes GitHub deliver `release`
// events (and lets an installation token read mvpkg.json / releases later);
// metadata:read is mandatory.  One App-level webhook, all installed repos.
function buildManifest(baseUrl, name) {
  return {
    name: name || 'mvpkg-registry',
    url: baseUrl,
    hook_attributes: { url: baseUrl + '/gh/app/hook', active: true },
    redirect_url: baseUrl + '/gh/app/created',
    public: false,
    // Only subscribable events go here (`release` needs contents:read, below).
    // `installation` / `installation_repositories` are App-management events
    // GitHub always delivers to the App's webhook — they are NOT valid in
    // default_events (GitHub rejects the manifest), and parseEvent handles them
    // when they arrive regardless.
    default_events: ['release'],
    default_permissions: { metadata: 'read', contents: 'read' },
  };
}

// Exchange the one-time manifest code (valid ~1h) for the App's credentials.
// cb(err, { appId, slug, name, pem, webhookSecret, clientId, clientSecret, htmlUrl, owner }).
function convertManifest(code, cb) {
  api('POST', `/app-manifests/${encodeURIComponent(code)}/conversions`, null, {}, (err, status, body) => {
    if (err) return cb(err);
    if ((status === 200 || status === 201) && body && body.id)
      return cb(null, {
        appId: body.id, slug: body.slug, name: body.name, pem: body.pem,
        webhookSecret: body.webhook_secret, clientId: body.client_id,
        clientSecret: body.client_secret, htmlUrl: body.html_url,
        owner: body.owner && body.owner.login,
      });
    cb(new Error('github ' + status + (body && body.message ? ': ' + body.message : '')));
  });
}

// A short-lived App JWT (RS256, signed with the App private key) — authenticates
// as the App itself to list installations / mint installation tokens.
function appJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(pem);
  return head + '.' + body + '.' + b64url(sig);
}

// Where every account has installed the App, so the registry can (re)learn its
// coverage on demand — a safety net when an `installation` webhook was missed.
// cb(err, [{ id, account, selection }]).
function listInstallations(cfg, cb) {
  const jwt = appJwt(cfg.appId, cfg.pem);
  api('GET', '/app/installations?per_page=100', jwt, null, (err, status, body) => {
    if (err) return cb(err);
    if (status !== 200 || !Array.isArray(body)) return cb(new Error('github ' + status + (body && body.message ? ': ' + body.message : '')));
    cb(null, body.map(i => ({
      id: i.id,
      account: i.account && i.account.login,
      selection: i.repository_selection,           // 'all' | 'selected'
    })));
  });
}

// The repos a `selected` installation covers (an `all` install needs no list).
// cb(err, ["owner/name", ...]).
function installationRepos(cfg, installationId, cb) {
  const jwt = appJwt(cfg.appId, cfg.pem);
  api('POST', `/app/installations/${installationId}/access_tokens`, jwt, {}, (err, status, body) => {
    if (err) return cb(err);
    if (status !== 201 || !body || !body.token) return cb(new Error('github ' + status + (body && body.message ? ': ' + body.message : '')));
    api('GET', '/installation/repositories?per_page=100', body.token, null, (e2, s2, b2) => {
      if (e2) return cb(e2);
      if (s2 !== 200 || !b2 || !Array.isArray(b2.repositories)) return cb(new Error('github ' + s2));
      cb(null, b2.repositories.map(r => r.full_name));
    });
  });
}

// Verify + parse an App webhook delivery against the App's single webhook
// secret.  Returns a small tagged shape the router acts on:
//   { valid:false }                              bad signature
//   { valid:true, ping:true }                    a ping
//   { valid:true, event, action, ... }           anything else, with:
//     release:  { repo, release }                a published/edited release
//     install:  { action, account, selection, repos } (un)installed / repos changed
function parseEvent(secret, headers, rawBody) {
  if (!gh.verifyWebhook(secret, headers['x-hub-signature-256'], rawBody)) return { valid: false };
  const event = headers['x-github-event'];
  if (event === 'ping') return { valid: true, ping: true };
  let p; try { p = JSON.parse(rawBody.toString()); } catch { return { valid: true, event }; }

  if (event === 'release' && p.release && p.repository &&
      ['published', 'released', 'prereleased', 'created', 'edited'].includes(p.action)) {
    const r = gh.releaseInfo(p.release);
    return { valid: true, event, action: p.action, release: {
      repo: p.repository.full_name,
      release: { version: String(r.tag || '').replace(/^v/, ''), tag: r.tag, at: r.at, html: r.html, assets: r.assets || [] },
    } };
  }

  if (event === 'installation' || event === 'installation_repositories') {
    const acct = p.installation && p.installation.account && p.installation.account.login;
    const selection = p.installation && p.installation.repository_selection;
    // `installation`: repositories[] on create; `installation_repositories`:
    // repositories_added[] / _removed[].  full_name is "owner/name".
    const names = a => (a || []).map(r => r.full_name);
    return { valid: true, event, action: p.action, install: {
      action: p.action, account: acct, selection,
      installationId: p.installation && p.installation.id,
      repos: names(p.repositories || p.repositories_added),
      removed: names(p.repositories_removed),
    } };
  }
  return { valid: true, event };
}

module.exports = { buildManifest, convertManifest, appJwt, listInstallations, installationRepos, parseEvent };
