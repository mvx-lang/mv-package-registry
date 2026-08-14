// mv_package registry — the packagist/npm-registry equivalent for MultiValue.
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see LICENSE).
//
// Dependency-free HTTP registry + website + accounts.
//
// An INDEX, not a host.  A package is added from its source URL (a repository,
// or a link to its mvpkg.json); a provider reads the manifest, tracks releases,
// and the registry records each release asset as an external download URL.  It
// stores no bytes.
//
// JSON API (the MVPKG client speaks this):
//   GET  /package/<name>   that package's metadata (tarball = external URL)
//   GET  /search?q=<term>  {"packages":[{name,version,description}, ...]}
//   GET  /packages         the full index
//
// Provider push:
//   POST /webhook/<id>     a release webhook; <id> is the package's tracking id
//
// Accounts + website:
//   GET  /               home            GET/POST /register   GET/POST /login
//   GET  /p/<name>       package page     POST /logout        GET /account
//   POST /packages (add by source URL)   POST /packages/remove
//
//   node server.js [port]        (default 8080; or $MVPKG_PORT)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
const webauthn = require('./lib/webauthn');
const providers = require('./lib/providers');
const semver = require('./lib/semver');
const ghapp = require('./lib/ghapp');

// Public base URL (for webhook URLs shown to the user); reuse the WebAuthn
// origin in production, derive nothing useful in dev.
const BASE_URL = process.env.PUBLIC_ORIGIN || process.env.WEBAUTHN_ORIGIN || '';

// Cloudflare Turnstile (CAPTCHA) on registration.  Off unless both keys are
// set; the sitekey is public (rendered in the form), the secret verifies the
// token server-side.
const TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
function verifyTurnstile(token, ip, cb) {
  if (!TURNSTILE_SECRET) return cb(true);           // CAPTCHA disabled
  const body = querystring.stringify({ secret: TURNSTILE_SECRET, response: token || '', remoteip: ip || '' });
  const r = https.request('https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
    resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { cb(!!JSON.parse(d).success); } catch { cb(false); } }); });
  r.on('error', () => cb(false));
  r.setTimeout(8000, () => { r.destroy(); cb(false); });
  r.write(body); r.end();
}

// WebAuthn relying-party identity.  Behind a TLS-terminating proxy the server
// sees http, so production sets these explicitly; local dev derives them.
function rpFor(req) {
  if (process.env.WEBAUTHN_RP_ID && process.env.WEBAUTHN_ORIGIN)
    return { rpId: process.env.WEBAUTHN_RP_ID, origin: process.env.WEBAUTHN_ORIGIN };
  const host = req.headers.host || 'localhost';
  return { rpId: host.split(':')[0], origin: 'http://' + host };
}

const REGDIR = process.env.MVPKG_REGISTRY_DIR || path.join(__dirname, 'registry');
const AUTHDIR = path.join(REGDIR, '_auth');       // no meta.json -> skipped as a package
const USERDIR = path.join(AUTHDIR, 'users');
const PORT = Number(process.argv[2] || process.env.MVPKG_PORT || 8080);
const ADMIN_TOKEN = process.env.MVPKG_PUBLISH_TOKEN || '';   // optional admin publish
// Config-driven admins: any registered user whose name is listed here is an
// admin (can publish to / manage any package).  Bootstraps the first admin
// without anyone having to set a password on their behalf.
const ADMIN_USERS = (process.env.MVPKG_ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const isAdminUser = u => !!u && (u.isAdmin === true || ADMIN_USERS.includes(String(u.username).toLowerCase()));
fs.mkdirSync(USERDIR, { recursive: true });

// Server secret for signing session cookies — generated once, persisted.
const SECRET = (() => {
  const f = path.join(AUTHDIR, 'secret');
  try { return fs.readFileSync(f); } catch {}
  const s = crypto.randomBytes(32);
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
})();

// ---- packages --------------------------------------------------------
function loadPackages() {
  const out = [];
  const scan = (rel) => {
    let names; try { names = fs.readdirSync(path.join(REGDIR, rel || '.')); } catch { return; }
    for (const n of names) {
      if (n[0] === '_' || n[0] === '.') continue;
      const full = rel ? rel + '/' + n : n;
      try {                                            // a package here?
        const meta = JSON.parse(fs.readFileSync(path.join(REGDIR, full, 'meta.json'), 'utf8'));
        if (meta && meta.name) { out.push(meta); continue; }
      } catch { /* not a package dir */ }
      if (!rel) { try { if (fs.statSync(path.join(REGDIR, full)).isDirectory()) scan(full); } catch {} }
    }
  };
  scan('');                                            // scope dirs recursed one level
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
function loadPackage(name) {
  try { return JSON.parse(fs.readFileSync(path.join(REGDIR, name, 'meta.json'), 'utf8')); }
  catch { return null; }
}
// A virtual name is satisfied by any package whose `provides` lists it, so a
// rename resolves transparently: a package udt_curses that is ported and
// renamed mvx-lang/cursors declares "provides": ["udt_curses"], and a request
// for the old name serves cursors — the client installs it and the dependency
// on udt_curses is met.
function findProvider(name) {
  for (const p of loadPackages()) {
    if (String(p.provides || '').trim().split(/\s+/).includes(name)) return p;
  }
  return null;
}
function savePackage(meta) {
  fs.mkdirSync(path.join(REGDIR, meta.name), { recursive: true });
  fs.writeFileSync(path.join(REGDIR, meta.name, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}
// A package owns its release-tracking state (source, provider, webhook secret);
// the webhook URL carries tracking.id, so find the package it belongs to.
function findPackageByHook(id) {
  for (const p of loadPackages()) if (p.tracking && p.tracking.id === id) return p;
  return null;
}
// The GitHub App delivers one webhook for every installed repo, so a `release`
// event is matched to its package by repo (owner/name), not a per-package id.
function findPackageByRepo(repo) {
  const r = String(repo || '').toLowerCase();
  for (const p of loadPackages())
    if (p.tracking && p.tracking.provider === 'github' && p.tracking.ref &&
        String(p.tracking.ref.repo || '').toLowerCase() === r) return p;
  return null;
}

// ---- GitHub App config (a single, registry-wide connection) ---------------
// Created once via the App-manifest flow and stored in _auth (skipped as a
// package — no meta.json).  Holds the App id + private key (JWT), the single
// webhook secret, and which accounts have installed it (learned from
// `installation` events, refreshable via /gh/app/sync).
const GHAPP_FILE = path.join(AUTHDIR, 'github-app.json');
function loadGhApp() { try { return JSON.parse(fs.readFileSync(GHAPP_FILE, 'utf8')); } catch { return null; } }
function saveGhApp(cfg) { fs.writeFileSync(GHAPP_FILE, JSON.stringify(cfg, null, 2) + '\n'); }
function ghAppInstallUrl(cfg) { return cfg && cfg.htmlUrl ? cfg.htmlUrl + '/installations/new' : null; }
// Does the connected App cover this repo (so its releases reach our webhook)?
function ghAppCoversRepo(cfg, repo) {
  if (!cfg || !cfg.installs) return false;
  const owner = String(repo).split('/')[0].toLowerCase();
  const inst = cfg.installs[owner];
  if (!inst) return false;
  return inst.selection === 'all' || !!(inst.repos && inst.repos[String(repo).toLowerCase()]);
}
// Fold an `installation` / `installation_repositories` webhook (or a /sync
// result) into the App's coverage map, keyed by owner login (lowercased).
function ghAppApplyInstall(cfg, ev) {
  if (!ev || !ev.account) return;
  const owner = String(ev.account).toLowerCase();
  cfg.installs = cfg.installs || {};
  if (ev.action === 'deleted') { delete cfg.installs[owner]; saveGhApp(cfg); return; }
  const inst = cfg.installs[owner] || { installationId: ev.installationId, selection: ev.selection || 'selected', repos: {} };
  if (ev.installationId) inst.installationId = ev.installationId;
  if (ev.selection) inst.selection = ev.selection;
  inst.repos = inst.repos || {};
  (ev.repos || []).forEach(r => { inst.repos[String(r).toLowerCase()] = true; });
  (ev.removed || []).forEach(r => { delete inst.repos[String(r).toLowerCase()]; });
  inst.updated = Date.now();
  cfg.installs[owner] = inst;
  saveGhApp(cfg);
}

// ---- users -----------------------------------------------------------
const userPath = u => path.join(USERDIR, String(u).toLowerCase() + '.json');
function loadUser(u) { try { return JSON.parse(fs.readFileSync(userPath(u), 'utf8')); } catch { return null; } }
function saveUser(user) { fs.writeFileSync(userPath(user.username), JSON.stringify(user, null, 2) + '\n'); }

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPw(pw, stored) {
  try {
    const [s, h] = String(stored).split(':');
    const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
    return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
  } catch { return false; }
}

const newToken = () => 'mvp_' + crypto.randomBytes(24).toString('base64url');
const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
function findUserByToken(tok) {
  if (!tok) return null;
  const h = tokenHash(tok);
  let files; try { files = fs.readdirSync(USERDIR); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const usr = JSON.parse(fs.readFileSync(path.join(USERDIR, f), 'utf8'));
      const hit = (usr.tokens || []).find(x => x.hash === h);
      if (hit) { hit.lastUsed = Date.now(); saveUser(usr); return usr; }
    } catch {}
  }
  return null;
}
// Resolve the actor for a write API call: an X-Auth-Token header (a per-user
// publish token, or the admin MVPKG_PUBLISH_TOKEN) authenticates a headless
// client (CLI/CI) the same way a signed-cookie session authenticates the
// browser.  Returns { user, viaToken } or null.  The admin token acts as an
// unowned admin (isAdmin) so it can publish to / manage any package.
function tokenActor(req) {
  const tok = req.headers['x-auth-token'];
  if (!tok) return null;
  if (ADMIN_TOKEN) {
    const a = Buffer.from(String(tok)), b = Buffer.from(ADMIN_TOKEN);
    if (a.length === b.length && crypto.timingSafeEqual(a, b))
      return { user: { username: null, isAdmin: true }, viaToken: true };
  }
  const u = findUserByToken(tok);
  return u ? { user: u, viaToken: true } : null;
}
const tokenAttempt = req => !!req.headers['x-auth-token'];

function findUserByCredId(credId) {
  let files; try { files = fs.readdirSync(USERDIR); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const usr = JSON.parse(fs.readFileSync(path.join(USERDIR, f), 'utf8'));
      const pk = (usr.passkeys || []).find(p => p.credId === credId);
      if (pk) return { user: usr, passkey: pk };
    } catch {}
  }
  return null;
}
// A stable opaque WebAuthn user handle (created once per user).
function waUserId(user) {
  if (!user.waId) { user.waId = crypto.randomBytes(16).toString('base64url'); saveUser(user); }
  return user.waId;
}

// ---- sessions (stateless signed cookie) ------------------------------
function makeSession(username) {
  const payload = Buffer.from(username).toString('base64url') + '.' + (Date.now() + 30 * 864e5);
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function sessionUser(req) {
  const m = /(?:^|;\s*)mvpkg_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const p = m[1].split('.');
  if (p.length !== 3) return null;
  const good = crypto.createHmac('sha256', SECRET).update(p[0] + '.' + p[1]).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(p[2]), Buffer.from(good))) return null; } catch { return null; }
  if (Date.now() > Number(p[1])) return null;
  return loadUser(Buffer.from(p[0], 'base64url').toString());
}
const sessionCookie = (req, username) => {
  const secure = !/^(localhost|127\.0\.0\.1)(:|$)/.test(req.headers.host || '');
  return `mvpkg_session=${makeSession(username)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 864e2}` + (secure ? '; Secure' : '');
};
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'mvpkg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// short-lived HMAC-signed value — used to remember a WebAuthn challenge
// between the /options and /verify steps without server-side state.
function signValue(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function readSigned(str) {
  const [payload, sig] = String(str || '').split('.');
  if (!payload || !sig) return null;
  const good = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null; } catch { return null; }
  try { const o = JSON.parse(Buffer.from(payload, 'base64url').toString()); return (o.exp && Date.now() > o.exp) ? null : o; } catch { return null; }
}
const waCookie = v => `mvpkg_wa=${signValue(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`;
const waChallenge = req => { const m = /(?:^|;\s*)mvpkg_wa=([^;]+)/.exec(req.headers.cookie || ''); return m ? readSigned(m[1]) : null; };

// ---- helpers ---------------------------------------------------------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendHTML(res, code, body, extraHeaders) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body) }, extraHeaders || {}));
  res.end(body);
}
function redirect(res, to, cookie) {
  const h = { Location: to }; if (cookie) h['Set-Cookie'] = cookie;
  res.writeHead(302, h); res.end();
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Package names may be scoped, Composer/npm style: <scope>/<name> (one level)
// or bare <name>.  Each segment starts alphanumeric (so _auth/.foo are out).
const NAMESEG = '[A-Za-z0-9][A-Za-z0-9._-]*';
const RE_NAME = new RegExp(`^(${NAMESEG}\\/)?${NAMESEG}$`);
const okName = n => RE_NAME.test(String(n));
const okUser = n => /^[a-z0-9][a-z0-9_-]{1,31}$/i.test(n);
const okEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
function readBody(req, cb) {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > 64 * 1024 * 1024) req.destroy(); else chunks.push(c); });
  req.on('end', () => cb(Buffer.concat(chunks)));
  req.on('error', () => cb(Buffer.alloc(0)));
}

// ---- website ---------------------------------------------------------
const CSS = `
:root{--bg:#f4f1e9;--card:#fffdf9;--line:#ddd5c4;--fg:#22303a;--mut:#6b7480;--acc:#0a558c;--code:#eef1f4;--ok:#1a7f37;--err:#b42318}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:820px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--line);padding:18px 0;margin-bottom:24px}
header .wrap{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
h1{font-size:20px;margin:0}h1 a{color:var(--fg)}.tag{color:var(--mut);font-size:13px}
.nav{margin-left:auto;font-size:14px;display:flex;gap:14px;align-items:baseline}
form{margin:0 0 22px}input,button{font:inherit}
input[type=search],input[type=text],input[type=email],input[type=password]{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:15px;margin:6px 0}
label{display:block;color:var(--mut);font-size:13px;margin-top:10px}
button{padding:9px 16px;border-radius:8px;border:1px solid var(--line);background:#efeadf;color:var(--fg);cursor:pointer}
button:hover{border-color:var(--acc)}button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
.card{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:14px 16px;margin:10px 0}
.card h3{margin:0 0 4px;font-size:16px}.card .v{color:var(--mut);font-weight:400;font-size:13px}.card p{margin:6px 0 0}
.badge{display:inline-block;font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:20px;padding:1px 8px;margin-left:6px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto}
.meta{color:var(--mut);font-size:13px;margin:2px 0}.meta b{color:var(--fg);font-weight:600}
.msg{border-radius:8px;padding:10px 12px;margin:0 0 16px}.msg.err{border:1px solid var(--err);background:#fdecea;color:#8a1c13}.msg.ok{border:1px solid var(--ok);background:#eaf6ec;color:#155724}
.tok{font-family:ui-monospace,monospace;background:var(--code);border:1px solid var(--ok);border-radius:8px;padding:12px;word-break:break-all}
footer{color:var(--mut);font-size:12px;border-top:1px solid var(--line);margin-top:34px;padding:18px 0}
.empty{color:var(--mut);padding:30px 0;text-align:center}
.wrap.wide{max-width:1040px}
.pkg{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:34px;align-items:start}
@media(max-width:760px){.pkg{grid-template-columns:1fr}}
.pkg-main h2{font-size:25px;margin:0 0 4px;word-break:break-word}.pkg-main h2 .v{font-size:15px}
.pkg-main .lead{color:var(--fg);font-size:17px;line-height:1.5;margin:6px 0 22px}
.pkg-main .lead .repo-link{font-size:14px;white-space:nowrap}
.pkg-side .vers{display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:13px;border-top:1px solid var(--line)}
.pkg-side .vers:first-child{border-top:0}.pkg-side .vers.cur{font-weight:600}
.pkg-side .vers .at{color:var(--mut);white-space:nowrap;font-size:12px}
.pkg-main h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:24px 0 8px}
.pkg-side .box{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:12px 15px;margin:0 0 14px}
.pkg-side .box>pre{margin:0}
.pkg-side h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut)}
.pkg-side .row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13px;border-top:1px solid var(--line)}
.pkg-side .row:first-child{border-top:0}
.pkg-side .row .k{color:var(--mut);white-space:nowrap}.pkg-side .row .val{text-align:right;word-break:break-word}
.pkg-side .dl{display:block;padding:6px 0;font-size:13px;border-top:1px solid var(--line)}.pkg-side .dl:first-child{border-top:0}
.pkg-side .box a{word-break:break-all}
.cmds{display:flex;flex-wrap:wrap;gap:5px}
.cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--code);border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--fg)}
.cmd.danger{border-color:var(--err);color:var(--err);background:#fbeceb}
.shellwarn{border:1px solid var(--err);background:#fbeceb;color:var(--err);border-radius:8px;padding:10px 14px;margin:0 0 22px;font-size:14px;line-height:1.5}
.shellwarn code{background:var(--card);border:1px solid var(--err);border-radius:4px;padding:0 4px;font-size:12px}
.warnbadge{font-size:10px;color:#fff;background:var(--err);border-radius:10px;padding:1px 7px;vertical-align:middle;font-weight:600;margin-left:4px}
.readme{line-height:1.6}
.readme h1,.readme h2,.readme h3,.readme h4,.readme h5{margin:22px 0 8px;line-height:1.3}
.readme h1{font-size:22px}.readme h2{font-size:19px}.readme h3{font-size:16px}.readme h4,.readme h5{font-size:14px}
.readme p{margin:10px 0}.readme ul,.readme ol{margin:10px 0;padding-left:22px}.readme li{margin:3px 0}
.readme pre{margin:12px 0}.readme :not(pre)>code{background:var(--code);padding:1px 5px;border-radius:5px;font-size:.92em}
.readme a{word-break:break-word}.readme table{border-collapse:collapse;margin:10px 0}.readme td,.readme th{border:1px solid var(--line);padding:4px 10px}`;

function page(title, inner, user, wide) {
  const nav = user
    ? `<a href="/account">${esc(user.username)}</a> <form method="post" action="/logout" style="margin:0;display:inline"><button style="padding:2px 10px">Sign out</button></form>`
    : `<a href="/login">Sign in</a> <a href="/register">Register</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><div class="wrap"><h1><a href="/">mv_package</a></h1><span class="tag">a package registry for MultiValue</span>
<span class="nav">${nav}</span></div></header>
<main class="wrap${wide ? ' wide' : ''}">${inner}</main>
<footer class="wrap">mv_package &middot; Composer/npm for the PICK world &middot; <code>MVPKG install &lt;name&gt;</code></footer>
<script src="/wa.js" defer></script></body></html>`;
}

function homePage(q, user) {
  const all = loadPackages();
  const ql = (q || '').toLowerCase();
  const list = all.filter(p => !ql || (p.name + ' ' + (p.description || '')).toLowerCase().includes(ql));
  const search = `<form method="get" action="/"><input type="search" name="q" placeholder="Search ${all.length} package${all.length === 1 ? '' : 's'}…" value="${esc(q || '')}" autofocus></form>`;
  if (!list.length)
    return page('mv_package', search + `<div class="empty">${all.length ? 'No packages match your search.' : 'No packages published yet.'}</div>`, user);
  const cards = list.map(p => {
    const sys = (p.systems && p.systems.length) ? p.systems.map(s => `<span class="badge">${esc(s)}</span>`).join('') : '';
    const lic = p.license ? `<span class="badge">${esc(p.license)}</span>` : '';
    return `<a class="card" href="/p/${esc(p.name)}" style="display:block"><h3>${esc(p.name)} <span class="v">${esc(p.version || '')}</span>${sys}${lic}</h3><p>${esc(p.description || '')}</p></a>`;
  }).join('');
  return page('mv_package', search + cards, user);
}

// Human label for a binary artifact: native -> "udt on linux/x86_64 (binary)";
// endian-locked (os/arch "any") -> "udt le, any OS/CPU (binary)".
function artLabel(a) {
  const native = a.arch && a.arch !== 'any';
  const where = native ? `${a.system} on ${a.os || '?'}/${a.arch}`
                       : `${a.system} ${a.endian || '?'}, any OS/CPU`;
  return `${where} (binary)`;
}

// Minimal, dependency-free Markdown -> HTML for rendering a package README.
// Escapes first (the README is source text), then a small subset: fenced code,
// ATX headings, un/ordered lists, inline code/bold/italic, and http(s) links.
function mdToHtml(md) {
  const e = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => e(s)
    .replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="nofollow">$1</a>');
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = []; let i = 0, inCode = false, code = [], list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      if (inCode) { out.push('<pre><code>' + e(code.join('\n')) + '</code></pre>'); code = []; inCode = false; }
      else { closeList(); inCode = true; }
      i++; continue;
    }
    if (inCode) { code.push(ln); i++; continue; }
    let m;
    if ((m = ln.match(/^(#{1,5})\s+(.*)/))) { closeList(); const l = Math.min(m[1].length + 1, 5); out.push(`<h${l}>${inline(m[2])}</h${l}>`); i++; continue; }
    if ((m = ln.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); i++; continue; }
    if ((m = ln.match(/^\s*\d+\.\s+(.*)/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); i++; continue; }
    if (/^\s*$/.test(ln)) { closeList(); i++; continue; }
    closeList();
    const para = [ln]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,5}\s|```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push('<p>' + inline(para.join('\n')) + '</p>');
  }
  if (inCode) out.push('<pre><code>' + e(code.join('\n')) + '</code></pre>');
  closeList();
  return out.join('\n');
}

function pkgPage(name, user) {
  const p = loadPackage(name);
  if (!p) return null;
  const row = (k, v) => `<div class="row"><span class="k">${k}</span><span class="val">${v}</span></div>`;
  const deps = String(p.dependencies || '').trim();
  const depLinks = s => s.split(/\s+/).map(d => `<a href="/p/${esc(d)}">${esc(d)}</a>`).join(', ');
  // Build dependencies are shown alongside, tagged: they are needed to COMPILE
  // the package (mvpkg provisions the shared PLATFORM.H), not to run it, so
  // only a --source install pulls them.
  const devDeps = String(p.devDependencies || '').trim();
  const depsHtml = (deps || devDeps)
    ? [deps ? depLinks(deps) : '', devDeps ? `<span class="meta">to build:</span> ${depLinks(devDeps)}` : '']
        .filter(Boolean).join('<br>')
    : '<span class="meta">none</span>';
  // Shell surface the package declares (mvpkg.json "shell").  A DECLARATION —
  // enforced only on mvx (the vendor OSEXEC permit); documentation everywhere
  // else.  The danger set is defined HERE (the site's authority), so a package
  // cannot self-declare a privileged command as safe.
  const DANGER = new Set(['sudo','su','doas','chown','chmod','chgrp','chattr','rm','rmdir','dd','mkfs','shred','mount','umount']);
  const shellArr = String(p.shell || '').trim() ? String(p.shell).trim().split(/\s+/) : [];
  const shellDanger = shellArr.filter(c => DANGER.has(c));
  const shellHtml = shellArr.length
    ? `<div class="cmds">${shellArr.map(c => `<code class="cmd${DANGER.has(c) ? ' danger" title="privileged / destructive' : ''}">${esc(c)}</code>`).join('')}</div>`
    : '<span class="meta">none declared</span>';
  const shellWarn = shellDanger.length
    ? `<div class="shellwarn">⚠ This package runs <b>privileged</b> shell commands on the host during install: ${shellDanger.map(c => `<code>${esc(c)}</code>`).join(' ')}. Review the source before installing.</div>`
    : '';
  const sys = (p.systems && p.systems.length) ? p.systems.map(s => `<span class="badge">${esc(s)}</span>`).join('') : '<span class="meta">any</span>';
  const hasSource = p.artifacts && p.artifacts.some(a => a.kind === 'source');
  const hasBinary = p.artifacts && p.artifacts.some(a => a.kind === 'binary');
  const binaryOnly = p.artifacts && p.artifacts.length && !hasSource;
  const distribution = binaryOnly ? 'binary only' : (hasBinary ? 'source + binary' : 'source');
  const isDev = p.artifacts && p.artifacts.some(a => a.dev);
  const downloads = (p.artifacts && p.artifacts.length)
    ? p.artifacts.map(a => `<a class="dl" href="${esc(a.tarball)}">${esc(a.kind === 'binary' ? artLabel(a) : (a.dev ? 'source (dev branch)' : 'source'))} &darr;</a>`).join('')
    : '<span class="meta">none yet</span>';

  // The git repository home: for a git-hosted package the provider maps its
  // tracking ref back to the repo URL (github/gitlab).  Distinct from p.source,
  // which is merely where it was indexed from (e.g. a raw mvpkg.json URL).
  const trk = p.tracking || {};
  const prov = providers.byName(trk.provider);
  const repoUrl = (prov && trk.ref && (trk.provider === 'github' || trk.provider === 'gitlab'))
    ? prov.sourceUrl(trk.ref) : null;
  const repoHost = repoUrl ? repoUrl.replace(/^https?:\/\/(www\.)?/, '') : '';

  const about = p.readme
    ? `<div class="readme">${mdToHtml(p.readme)}</div>`
    : `<p>${esc(p.description || 'No description provided.')}</p>`;
  const main = `<div class="pkg-main">
      <h2>${esc(p.name)} <span class="v badge">${esc(p.version || '—')}</span></h2>
      <p class="lead">${esc(p.description || '')}${repoUrl ? ` <a class="repo-link" href="${esc(repoUrl)}">repository &nearr;</a>` : ''}</p>
      <h3>Install</h3>
      <pre>MVPKG install ${esc(p.name)}</pre>
      ${shellWarn}
      <h3>About</h3>
      ${about}
      <p class="meta" style="margin-top:26px">Indexed from its source — the registry hosts nothing.${isDev ? ' No tagged release yet; tracking the default branch (a dev version).' : ''} &middot; <a href="/">all packages</a></p>
    </div>`;

  const ymd = at => { try { return new Date(at).toISOString().slice(0, 10); } catch { return ''; } };
  const vers = (p.versions && p.versions.length) ? p.versions : (p.version ? [{ version: p.version, at: p.updated }] : []);
  const versHtml = vers.length
    ? vers.map(v => {
        const cur = v.version === p.version;
        const label = v.html ? `<a href="${esc(v.html)}">${esc(v.version)}</a>` : esc(v.version);
        return `<div class="vers${cur ? ' cur' : ''}"><span>${label}</span><span class="at">${v.at ? esc(ymd(v.at)) : ''}</span></div>`;
      }).join('')
    : '<span class="meta">none yet</span>';

  const side = `<aside class="pkg-side">
      <div class="box">${
        row('Version', esc(p.version || '—')) +
        row('Licence', p.license ? esc(p.license) : '<span class="meta">unspecified</span>') +
        row('Systems', sys) +
        row('Distribution', distribution) +
        (p.owner ? row('Maintainer', esc(p.owner)) : '')
      }</div>
      <div class="box"><h4>Dependencies</h4>${depsHtml}</div>
      ${shellArr.length ? `<div class="box"><h4>Shell commands${shellDanger.length ? '<span class="warnbadge">privileged</span>' : ''}</h4>${shellHtml}<p class="meta" style="margin-top:8px">OS commands this package runs on the host. Enforced as a least-privilege allow-list on mvx; a declaration elsewhere.</p></div>` : ''}
      ${repoUrl ? `<div class="box"><h4>Repository</h4><a href="${esc(repoUrl)}">${esc(repoHost)}</a></div>` : ''}
      ${p.source && p.source !== repoUrl ? `<div class="box"><h4>Source</h4><a href="${esc(p.source)}">${esc(p.source.replace(/^https?:\/\//, ''))}</a></div>` : ''}
      <div class="box"><h4>Versions</h4>${versHtml}</div>
      <div class="box"><h4>Downloads</h4>${downloads}</div>
    </aside>`;

  return page(`${p.name} — mv_package`, `<div class="pkg">${main}${side}</div>`, user, true);
}

function authForm(kind, msg, values) {
  const isReg = kind === 'register';
  const err = msg ? `<div class="msg err">${esc(msg)}</div>` : '';
  return page(isReg ? 'Register — mv_package' : 'Sign in — mv_package',
    `<h3>${isReg ? 'Create an account' : 'Sign in'}</h3>${err}
     <form method="post" action="/${kind}">
       <label>Username</label><input type="text" name="username" value="${esc((values || {}).username || '')}" autocomplete="username" required>
       ${isReg ? '<label>Email</label><input type="email" name="email" value="' + esc((values || {}).email || '') + '" autocomplete="email" required>' : ''}
       <label>Password</label><input type="password" name="password" autocomplete="${isReg ? 'new-password' : 'current-password'}" required>
       ${isReg && TURNSTILE_SITEKEY ? `<div class="cf-turnstile" data-sitekey="${esc(TURNSTILE_SITEKEY)}" style="margin:14px 0"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ''}
       <div style="margin-top:14px"><button class="primary" type="submit">${isReg ? 'Register' : 'Sign in'}</button>
       ${isReg ? '' : ' <button type="button" onclick="loginPasskey()">Sign in with a passkey</button>'}</div>
     </form>
     <p class="meta">${isReg ? 'Already have an account? <a href="/login">Sign in</a>.' : 'New here? <a href="/register">Register</a>. After signing in, add a passkey on your account page.'}</p>`);
}

function accountPage(user, opts) {
  opts = opts || {};
  const mine = loadPackages().filter(p => p.owner === user.username);
  const pkgs = mine.length
    ? mine.map(p => {
        const t = p.tracking || {};
        const track = t.hookId ? 'auto-updating on release &#10003;' : (t.provider ? 'no webhook — use Refresh to catch up' : 'not tracked');
        return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div>
          <b><a href="/p/${esc(p.name)}">${esc(p.name)}</a></b> <span class="v">${esc(p.version || '—')}</span><br>
          <span class="meta">source: ${p.source ? '<a href="' + esc(p.source) + '">' + esc(p.source) + '</a>' : 'unknown'}</span><br>
          <span class="meta">releases: ${esc(track)}</span></div>
          <div style="display:flex;gap:6px">
          <form method="post" action="/packages/refresh" style="margin:0"><input type="hidden" name="name" value="${esc(p.name)}"><button style="padding:4px 12px" title="Check the source for new releases now">Refresh</button></form>
          <form method="post" action="/packages/remove" style="margin:0" onsubmit="return confirm('Remove ${esc(p.name)} from the index?')"><input type="hidden" name="name" value="${esc(p.name)}"><button style="padding:4px 12px">Remove</button></form></div></div></div>`;
      }).join('')
    : '<p class="meta">No packages yet — add one below by pasting its source URL.</p>';
  const adminBadge = isAdminUser(user) ? ' <span class="badge" style="border-color:var(--acc);color:var(--acc)">admin</span>' : '';
  const pks = (user.passkeys || []).length
    ? (user.passkeys || []).map(p => `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${esc(p.name || 'passkey')}</b> <span class="badge">${esc(p.kind || 'ec')}</span><br><span class="meta">added ${new Date(p.created).toISOString().slice(0, 10)}${p.lastUsed ? ' &middot; last used ' + new Date(p.lastUsed).toISOString().slice(0, 10) : ''}</span></div>
        <form method="post" action="/account/passkeys/revoke" style="margin:0"><input type="hidden" name="id" value="${esc(p.credId)}"><button style="padding:4px 12px">Remove</button></form></div>`).join('')
    : '<p class="meta">No passkeys yet.</p>';
  const toks = (user.tokens || []).length
    ? (user.tokens || []).map(t => `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${esc(t.name || 'token')}</b><br><span class="meta">created ${new Date(t.created).toISOString().slice(0, 10)}${t.lastUsed ? ' &middot; last used ' + new Date(t.lastUsed).toISOString().slice(0, 10) : ' &middot; never used'}</span></div>
        <form method="post" action="/account/tokens/revoke" style="margin:0"><input type="hidden" name="id" value="${esc(t.id)}"><button style="padding:4px 12px">Revoke</button></form></div>`).join('')
    : '<p class="meta">No tokens yet.</p>';
  const freshTok = opts.freshToken
    ? `<div class="msg ok">New token — copy it now, it is shown only once:<br><code>${esc(opts.freshToken)}</code><br>
       <span class="meta">Send it as the <code>X-Auth-Token</code> header to publish without signing in, e.g.<br>
       <code>curl -H "X-Auth-Token: ${esc(opts.freshToken)}" -d "source=https://&hellip;/your-package" ${esc(BASE_URL)}/packages</code></span></div>`
    : '';
  const a = opts.added;
  const addMsg = a
    ? `<div class="msg ok">Added <code>${esc(a.name)}</code>${a.installed ? ' — release tracking installed; new releases appear here automatically.' : (a.note ? ' — <span class="meta">' + esc(a.note) + '</span>' : '')}</div>`
    : '';
  const addErr = opts.addError ? `<div class="msg err">${esc(opts.addError)}</div>` : '';
  const refMsg = opts.refreshed ? `<div class="msg ok">Refreshed <code>${esc(opts.refreshed)}</code> from its source.</div>` : '';
  return page('Account — mv_package',
    `<h3>Signed in as ${esc(user.username)}${adminBadge}</h3>
     <h3 style="margin-top:24px">Passkeys</h3>${pks}
     <p><button class="primary" type="button" onclick="addPasskey()">+ Add a passkey</button></p>
     <h3 style="margin-top:24px">Your packages</h3>${addMsg}${addErr}${refMsg}${pkgs}
     <form method="post" action="/packages" style="margin-top:14px">
       <label>Add a package — paste its <b>source URL</b> (a repository, or a link to its <code>mvpkg.json</code>)</label>
       <input type="text" name="source" placeholder="https://&hellip;/your-package   &middot;   or a link to its mvpkg.json" required>
       <label>Package name <span class="meta">(optional &mdash; read from mvpkg.json)</span></label>
       <input type="text" name="package" placeholder="mvx-lang/git">
       <div style="margin-top:10px"><button class="primary" type="submit">Add package</button></div>
     </form>
     <p class="meta">The registry indexes your package and tracks its releases &mdash; it hosts nothing; downloads come from the source.</p>
     <h3 style="margin-top:24px">Publish tokens</h3>
     <p class="meta">Publish from a script or CI without signing in &mdash; send the token as the <code>X-Auth-Token</code> header.</p>
     ${freshTok}${toks}
     <form method="post" action="/account/tokens" style="margin-top:14px">
       <input type="text" name="name" placeholder="token name (e.g. ci)" style="max-width:280px">
       <button class="primary" type="submit">Create token</button>
     </form>
     ${isAdminUser(user) ? `<h3 style="margin-top:24px">GitHub connection</h3>
       <p class="meta">Connect a GitHub App once so packages track releases with no per-repo token.</p>
       <p><a class="primary" href="/gh/app" style="text-decoration:none;padding:8px 16px;display:inline-block">${loadGhApp() ? 'Manage GitHub App' : 'Connect GitHub'}</a></p>` : ''}`, user);
}

// The GitHub App connect/status page (admin).  Not configured -> a one-click
// create (App-manifest flow); configured -> the App, its installations, and
// install / sync / disconnect actions.
function ghAppPage(user, opts) {
  opts = opts || {};
  const app = loadGhApp();
  const msg = opts.error ? `<div class="msg err">${esc(opts.error)}</div>`
    : opts.created ? '<div class="msg ok">GitHub App created and connected. Now install it on your org (below) so its releases reach the registry.</div>'
    : opts.synced != null ? `<div class="msg ok">Synced — ${opts.synced} installation(s) refreshed.</div>` : '';
  let body;
  if (!app) {
    body = `<h3>Connect GitHub</h3>
      <p>Create a GitHub App <b>once</b> — no personal access token, ever. It gives the registry a single webhook that receives releases from every repo you install it on, so adding a package "just works," webhook and all.</p>
      <form method="get" action="/gh/app/create" style="margin-top:14px">
        <input type="text" name="org" placeholder="GitHub org (optional, e.g. mvx-lang)" style="max-width:320px">
        <div style="margin-top:10px"><button class="primary" type="submit">Create GitHub App</button></div>
      </form>
      <p class="meta">Leave the org blank to create it under your own account; you can still install it on any org afterwards.</p>`;
  } else {
    const installUrl = ghAppInstallUrl(app);
    const owners = Object.keys(app.installs || {});
    const instList = owners.length
      ? owners.map(o => { const i = app.installs[o]; const n = i.selection === 'all' ? 'all repos' : (Object.keys(i.repos || {}).length + ' repo(s)'); return `<li><b>${esc(o)}</b> &mdash; ${esc(n)}</li>`; }).join('')
      : '<li class="meta">No installations yet — install the App on your org below.</li>';
    body = `<h3>GitHub App connected</h3>
      <div class="card"><b>${esc(app.name || app.slug || 'app')}</b> <span class="badge">app id ${esc(String(app.appId))}</span>
      ${app.htmlUrl ? `<br><span class="meta"><a href="${esc(app.htmlUrl)}" target="_blank" rel="noreferrer">manage on GitHub</a></span>` : ''}</div>
      <h3 style="margin-top:20px">Installations</h3>
      <ul>${instList}</ul>
      <p style="margin-top:8px">
        ${installUrl ? `<a class="primary" href="${esc(installUrl)}" target="_blank" rel="noreferrer" style="text-decoration:none;padding:8px 16px;display:inline-block">Install / configure on GitHub</a>` : ''}
        <form method="post" action="/gh/app/sync" style="display:inline;margin-left:8px"><button type="submit">Sync installations</button></form>
        <form method="post" action="/gh/app/disconnect" style="display:inline;margin-left:8px" onsubmit="return confirm('Disconnect the GitHub App? Existing per-repo webhooks are unaffected.')"><button type="submit">Disconnect</button></form>
      </p>
      <p class="meta">After installing on an org, releases from its repos auto-index. If an install isn't showing, click Sync.</p>`;
  }
  return page('GitHub App — mv_package', msg + body, user);
}

// ---- packages: a source-tracked index (no hosting) ------------------
// A package is added from a source URL; a provider reads its mvpkg.json and
// finds its releases, whose assets are recorded as external artifact URLs.
// Release assets follow `<base>-<version>-<suffix>.tar.gz` (base = name with
// '/'->'_', suffix "source" or "<system>-<os>-<arch>-<endian>").

// Record a version in the package's release history (newest first, deduped by
// version).  Keeps a bounded, source-of-truth list for the "Versions" sidebar.
function mergeVersion(pkg, v) {
  if (!v || !v.version) return;
  pkg.versions = (pkg.versions || []).filter(x => x.version !== v.version);
  pkg.versions.unshift({ version: v.version, tag: v.tag || null, at: v.at || null, html: v.html || null });
  // Newest-first by semver precedence (pre-releases rank below their release),
  // which is the order the client walks to pick the newest version satisfying a
  // dependency constraint; fall back to date when versions compare equal.
  pkg.versions.sort((a, b) => semver.cmp(b.version, a.version) ||
    ((b.at ? Date.parse(b.at) || 0 : 0) - (a.at ? Date.parse(a.at) || 0 : 0)));
  if (pkg.versions.length > 50) pkg.versions.length = 50;
}

// Recognisable release assets -> external artifacts.  Assets follow
// `<base>-<ver>-<suffix>.tar.gz` (base = name '/'->'_'); suffix "source" or a
// 4-part "<system>-<os>-<arch>-<endian>" binary key.
function artifactsFromRelease(pkg, rel) {
  const prefix = `${pkg.name.replace(/\//g, '_')}-${rel.version}-`;
  const arts = [];
  for (const asset of (rel.assets || [])) {
    const an = asset.name || '';
    if (!asset.url || !an.endsWith('.tar.gz') || !an.startsWith(prefix)) continue;
    const suffix = an.slice(prefix.length, -'.tar.gz'.length);
    if (suffix === 'source') arts.push({ kind: 'source', tarball: asset.url, external: true });
    else {
      const p = suffix.split('-');
      if (p.length === 4) arts.push({ kind: 'binary', system: p[0], os: p[1], arch: p[2], endian: p[3], tarball: asset.url, external: true });
    }
  }
  return arts;
}

// Index a release's assets onto a package: refresh version + artifacts (all
// external), keep source/tracking/owner.  Idempotent and change-aware — writes
// only when the version or the asset set actually changed, so it is safe to
// call on every webhook or refresh (release assets can arrive AFTER the first
// event, e.g. a binary built by a later CI job the "published" webhook missed).
// Returns the artifact count when it (re)indexed, else 0.
function indexRelease(pkg, rel) {
  if (!rel || !rel.version) return 0;
  const version = rel.version;
  const arts = artifactsFromRelease(pkg, rel);
  if (!arts.length) return 0;                          // nothing recognisable in this release
  const promote = semver.shouldPromote(pkg.version, version); // default only if stable-newest
  const key = a => a.map(x => x.tarball).sort().join('|');
  const known = (pkg.versions || []).some(x => x.version === version);
  const artsSame = pkg.version === version && key(pkg.artifacts || []) === key(arts);
  // Idempotent: nothing new to record and no promotion (or the promoted set is
  // already current) means this webhook/refresh is a no-op.
  if (known && (!promote || artsSame)) return 0;
  if (promote) {
    pkg.version = version;
    pkg.artifacts = arts;
    const src = arts.find(a => a.kind === 'source');
    pkg.tarball = src ? src.tarball : (arts[0] ? arts[0].tarball : '');
    pkg.systems = [...new Set([...(pkg.systems || []), ...arts.filter(a => a.kind === 'binary').map(a => a.system)])];
  }
  pkg.updated = Date.now();
  // tracking.latest records the newest release SEEN (any channel), which is what
  // drives push-tracking freshness — distinct from the stable default above.
  if (pkg.tracking) pkg.tracking.latest = { version, tag: rel.tag, at: rel.at, html: rel.html, seenAt: Date.now() };
  mergeVersion(pkg, { version, tag: rel.tag, at: rel.at, html: rel.html });
  savePackage(pkg);
  return arts.length;
}

// Index a "dev" version — the source of the default branch — for a package
// with no release yet.  A single external source artifact (the branch archive).
function indexDev(pkg, dev) {
  pkg.version = dev.version;
  pkg.artifacts = [{ kind: 'source', tarball: dev.tarball, external: true, dev: true }];
  pkg.tarball = dev.tarball;
  pkg.updated = Date.now();
  if (pkg.tracking) pkg.tracking.latest = { version: dev.version, tag: dev.branch, seenAt: Date.now() };
  savePackage(pkg);
  return 1;
}

// Add or refresh a package from a pasted source URL: resolve the provider, read
// mvpkg.json for the name + metadata, record the source, install push tracking
// where supported (a webhook), and index the current release.
// cb(err, { name, installed, note }).
function addPackage(user, source, pkgOverride, cb) {
  const resolved = providers.resolve(String(source || '').trim());
  if (!resolved) return cb(new Error('Unrecognised source — paste a repository URL or a link to an mvpkg.json.'));
  const { provider, ref } = resolved;
  provider.fetchManifest(ref, (e, manifestText) => {
    let name = String(pkgOverride || '').trim();
    let man = {};
    if (manifestText) { try {
      const j = JSON.parse(manifestText);
      if (!name && j.name) name = String(j.name);
      man = { description: j.description || '', license: j.license || '',
        dependencies: Array.isArray(j.dependencies) ? j.dependencies.join(' ') : (j.dependencies || ''),
        // BUILD dependencies: needed to COMPILE the package, never to run it
        // (mvpkg provisions the shared PLATFORM.H managed packages $INCLUDE).
        // Only a --source install pulls them; a binary install ships compiled.
        devDependencies: Array.isArray(j.devDependencies) ? j.devDependencies.join(' ') : (j.devDependencies || ''),
        provides: Array.isArray(j.provides) ? j.provides.join(' ') : (j.provides || ''),
        clibs: Array.isArray(j.clibs) ? j.clibs.join(' ') : (j.clibs || ''),
        shell: Array.isArray(j.shell) ? j.shell.join(' ') : (j.shell || ''),
        systems: Array.isArray(j.systems) ? j.systems : [] };
    } catch {} }
    if (!name || !okName(name))
      return cb(new Error('Could not read the package name — the source needs an mvpkg.json with a "name", or specify the name.'));
    const existing = loadPackage(name);
    if (existing && existing.owner && existing.owner !== user.username && !isAdminUser(user))
      return cb(new Error(`package "${name}" is owned by ${existing.owner}`));

    const meta = existing || { name, owner: user.username, artifacts: [], version: '', added: Date.now() };
    meta.owner = meta.owner || user.username;
    meta.source = provider.sourceUrl(ref);
    if (man.description) meta.description = man.description;
    if (man.license) meta.license = man.license;
    if (man.dependencies) meta.dependencies = man.dependencies;
    if (man.devDependencies !== undefined) meta.devDependencies = man.devDependencies;
    if (man.provides !== undefined) meta.provides = man.provides;
    if (man.clibs !== undefined) meta.clibs = man.clibs;
    if (man.shell !== undefined) meta.shell = man.shell;
    if (man.systems && man.systems.length) meta.systems = [...new Set([...(meta.systems || []), ...man.systems])];
    meta.tracking = meta.tracking || { id: crypto.randomBytes(6).toString('hex'), secret: crypto.randomBytes(24).toString('base64url'), hookId: null, latest: null };
    meta.tracking.provider = provider.name;
    meta.tracking.ref = ref;
    meta.updated = Date.now();
    savePackage(meta);

    // Best-effort README for the package page's About section (before indexing,
    // so the fresh loads below include it — no lost-update race).
    const withReadme = (next) => {
      if (!provider.fetchFile) return next();
      provider.fetchFile(ref, 'README.md', (er, readme) => {
        if (readme) { meta.readme = readme; savePackage(meta); }
        next();
      });
    };

    // Backfill the full release history (newest first) for the Versions sidebar.
    const withVersions = (next) => {
      if (!provider.listVersions) return next();
      provider.listVersions(ref, (er, vers) => {
        if (!er && vers && vers.length) {
          const fresh = loadPackage(name) || meta;
          vers.forEach(v => mergeVersion(fresh, v));
          savePackage(fresh);
        }
        next();
      });
    };

    // Index the current release; if there is no tagged release with matching
    // assets, fall back to the source of the default branch (a "dev" version),
    // so a package can be added before it cuts a release.
    const indexLatest = (installed, note) => provider.latestRelease(ref, (e2, rel) => {
      let fresh = loadPackage(name);
      // A real release exists: index it and keep it as the default.  indexRelease
      // is idempotent — a 0 return means "already current", NOT "no release" — so
      // the dev-branch fallback must key on the package actually lacking a release
      // version, not on indexRelease's return (re-adding an up-to-date package
      // used to clobber its default to dev-<branch>).
      if (fresh && !e2 && rel && rel.assets && rel.assets.length) {
        indexRelease(fresh, rel);
        fresh = loadPackage(name);
      }
      if (fresh && fresh.version && !/^dev-/.test(fresh.version))
        return cb(null, { name, installed, note });
      if (fresh && provider.devVersion) {
        return provider.devVersion(ref, (e3, dev) => {
          const f2 = loadPackage(name);
          if (f2 && !e3 && dev) indexDev(f2, dev);
          cb(null, { name, installed, note: note || (dev ? 'no release yet — tracking the ' + dev.version + ' branch' : note) });
        });
      }
      cb(null, { name, installed, note });
    });

    withReadme(() => withVersions(() => {
      const repo = provider.name === 'github' ? ref.repo : null;
      const app = loadGhApp();
      // When a GitHub App is connected it is the source of truth for github
      // tracking: its single org-wide webhook already delivers this repo's
      // releases (no per-repo hook, no PAT), or the App just needs installing on
      // the owner (one click) — never fall back to a token that may 403.
      if (repo && app) {
        if (ghAppCoversRepo(app, repo)) {
          const fresh = loadPackage(name);
          if (fresh) { fresh.tracking = fresh.tracking || {}; fresh.tracking.viaApp = true; fresh.tracking.hookId = null; savePackage(fresh); }
          return indexLatest(true, null);
        }
        return indexLatest(false, `the GitHub App is not installed on "${repo.split('/')[0]}" — install it (one click) to auto-track releases: ${ghAppInstallUrl(app)}`);
      }
      // No App connected — legacy per-repo webhook via GITHUB_TOKEN (or none).
      if (provider.supportsTracking) {
        provider.installTracking(ref, { hookUrl: `${BASE_URL}/webhook/${meta.tracking.id}`, secret: meta.tracking.secret }, (herr, hook) => {
          if (hook) { const fresh = loadPackage(name); if (fresh && fresh.tracking) { fresh.tracking.hookId = hook.id || null; savePackage(fresh); } }
          indexLatest(!herr && !!hook, herr ? herr.message : null);
        });
      } else {
        indexLatest(false, 'This source has no push webhook — use Refresh to pick up new releases.');
      }
    }));
  });
}

// Return meta with `tarball` resolved to the artifact best matching the
// caller's system+arch: a matching binary, else the source.
// Resolve /package to a FLAT client view.  The MVPKG client's JSON decoder is
// flat (it takes the first matching key), so this response must not carry a
// nested artifacts[] — each artifact's own "tarball" would shadow the resolved
// one.  Return the selected tarball first, no artifacts array; the rich
// per-artifact listing lives on the website page (/p/<name>), which reads the
// raw meta.  With a system+arch that matches a binary, serve it; otherwise the
// source tar.
function selectArtifact(meta, system, os, arch, endian) {
  let tarball = meta.tarball, selected = 'source';
  if (system && meta.artifacts && meta.artifacts.length) {
    // A binary is eligible when it matches on every dimension it pins down: for
    // each of os/arch/endian, "any" matches anything, otherwise the caller must
    // supply that exact value (so a native os/arch binary is never handed to an
    // unknown or mismatched host).  Prefer a native binary (real os+arch) over
    // an endian-locked one (os/arch "any").
    const dimOk = (av, cv) => !av || av === 'any' || (!!cv && av === cv);
    const bins = meta.artifacts.filter(a => a.kind === 'binary' && a.system === system
      && dimOk(a.os, os) && dimOk(a.arch, arch) && dimOk(a.endian, endian));
    const native = bins.find(a => a.arch && a.arch !== 'any' && a.os && a.os !== 'any');
    const chosen = native || bins[0] || meta.artifacts.find(a => a.kind === 'source');
    if (chosen) { tarball = chosen.tarball; selected = chosen.kind; }
  }
  // binary-only = this version ships no source artifact (the commercial case).
  const sourceIncluded = !meta.artifacts || !meta.artifacts.length
    || meta.artifacts.some(a => a.kind === 'source');
  return {
    name: meta.name, version: meta.version, tarball,
    description: meta.description || '', dependencies: meta.dependencies || '',
    devDependencies: meta.devDependencies || '',   // needed to BUILD (--source only)
    license: meta.license || '', sourceIncluded,
    systems: meta.systems || [], owner: meta.owner, selected,
    versions: (meta.versions || []).map(v => v.version).join(' '),
    provides: meta.provides || '',
    clibs: meta.clibs || '',                   // OS C libraries the CallC needs
    shell: meta.shell || '',                   // OS commands the package shells out
    // repo URL — MVPKG --source clones it.  Named srcrepo (not "source") because
    // the client's JSON decoder prefix-matches keys, and "source" collides with
    // "sourceIncluded" above.
    srcrepo: meta.source || '',
  };
}

// Resolve /package to an EXACT prior version: the client picks a version from
// the `versions` list (per its dependency constraint) and asks for it.  The
// current version returns its real resolved artifact; an older one is served as
// its source asset, whose URL is deterministic — <source>/releases/download/
// <tag>/<base>-<version>-source.tar.gz (base = name '/'->'_').  Returns null if
// the version is unknown.
function resolveExactVersion(meta, version, system, os, arch, endian) {
  if (meta.version === version)
    return selectArtifact(meta, system, os, arch, endian);
  const v = (meta.versions || []).find(x => x.version === version);
  if (!v) return null;
  const base = meta.name.replace(/\//g, '_');
  const tarball = `${meta.source}/releases/download/${v.tag || version}/${base}-${version}-source.tar.gz`;
  return {
    name: meta.name, version, tarball,
    description: meta.description || '', dependencies: meta.dependencies || '',
    devDependencies: meta.devDependencies || '',   // needed to BUILD (--source only)
    license: meta.license || '', sourceIncluded: true,
    systems: meta.systems || [], owner: meta.owner, selected: 'source',
    versions: (meta.versions || []).map(x => x.version).join(' '),
    provides: meta.provides || '',
    clibs: meta.clibs || '',
    shell: meta.shell || '',
    srcrepo: meta.source || '',
  };
}

// ---- account POST handlers ------------------------------------------
function handleRegister(req, res, form) {
  verifyTurnstile(form['cf-turnstile-response'], req.socket.remoteAddress || '', ok => {
    if (!ok) return sendHTML(res, 400, authForm('register', 'CAPTCHA check failed — please try again.', form));
    const username = (form.username || '').trim(), email = (form.email || '').trim(), password = form.password || '';
    if (!okUser(username)) return sendHTML(res, 400, authForm('register', 'Username: 2–32 chars, letters/digits/-/_ , starting alphanumeric.', form));
    if (!okEmail(email)) return sendHTML(res, 400, authForm('register', 'Please enter a valid email.', form));
    if (password.length < 8) return sendHTML(res, 400, authForm('register', 'Password must be at least 8 characters.', form));
    if (loadUser(username)) return sendHTML(res, 409, authForm('register', 'That username is taken.', form));
    saveUser({ username, email, pw: hashPw(password), created: Date.now(), tokens: [], passkeys: [] });
    redirect(res, '/account', sessionCookie(req, username));
  });
}
function handleLogin(req, res, form) {
  const usr = loadUser((form.username || '').trim());
  if (!usr || !usr.pw || !verifyPw(form.password || '', usr.pw))
    return sendHTML(res, 401, authForm('login', 'Wrong username or password.', form));
  redirect(res, '/account', sessionCookie(req, usr.username));
}

// ---- routing ---------------------------------------------------------
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const parts = u.pathname.split('/').filter(Boolean);
  const user = sessionUser(req);

  if (req.method === 'POST') {
    return readBody(req, buf => {
      // Provider push (release webhook) — the URL carries the package's
      // tracking id; the provider verifies the signature and parses the event.
      if (parts[0] === 'webhook' && parts[1]) {
        const pkg = findPackageByHook(parts[1]);
        if (!pkg || !pkg.tracking) { res.writeHead(404); return res.end('unknown hook'); }
        const prov = providers.byName(pkg.tracking.provider);
        if (!prov) { res.writeHead(404); return res.end('unknown provider'); }
        const v = prov.verifyEvent(pkg.tracking.secret, req.headers, buf);
        if (!v.valid) { res.writeHead(401); return res.end('bad signature'); }
        if (v.ping) return sendJSON(res, 200, { ok: true });
        if (v.release) {
          const fresh = loadPackage(pkg.name);
          const n = fresh ? indexRelease(fresh, v.release) : 0;
          console.log(`webhook: ${pkg.name} <- ${prov.name} release ${v.release.tag} (indexed ${n})`);
          // A release is exactly when the manifest may have changed (description,
          // deps, README) — refresh it here (push-driven), so we never poll.
          refreshMeta(pkg, () => {});                     // fire-and-forget
        }
        return sendJSON(res, 200, { ok: true });
      }
      // GitHub App push — ONE webhook for every installed repo (no per-repo
      // hook, no PAT).  Verified with the App's single secret; `release` events
      // index by repo, `installation` events (un)register the App's coverage.
      if (parts[0] === 'gh' && parts[1] === 'app' && parts[2] === 'hook') {
        const app = loadGhApp();
        if (!app) { res.writeHead(404); return res.end('no app configured'); }
        const v = ghapp.parseEvent(app.webhookSecret, req.headers, buf);
        if (!v.valid) { res.writeHead(401); return res.end('bad signature'); }
        if (v.ping) return sendJSON(res, 200, { ok: true });
        if (v.release) {
          const pkg = findPackageByRepo(v.release.repo);
          if (pkg) {
            const fresh = loadPackage(pkg.name);
            const n = fresh ? indexRelease(fresh, v.release.release) : 0;
            console.log(`gh-app: ${pkg.name} <- release ${v.release.release.tag} (indexed ${n})`);
            refreshMeta(pkg, () => {});                    // push-driven manifest refresh
          } else {
            console.log(`gh-app: release for ${v.release.repo} — no matching package`);
          }
        } else if (v.install) {
          ghAppApplyInstall(app, v.install);
          console.log(`gh-app: installation ${v.install.action} for ${v.install.account}`);
        }
        return sendJSON(res, 200, { ok: true });
      }
      // WebAuthn verify endpoints take a JSON body
      if (u.pathname === '/webauthn/register/verify' || u.pathname === '/webauthn/login/verify') {
        let body; try { body = JSON.parse(buf.toString()); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
        const { rpId, origin } = rpFor(req);
        const wa = waChallenge(req);
        if (u.pathname === '/webauthn/register/verify') {
          if (!user) return sendJSON(res, 401, { error: 'sign in first' });
          if (!wa || wa.purpose !== 'register' || wa.username !== user.username) return sendJSON(res, 400, { error: 'no or expired challenge' });
          try {
            const r = webauthn.verifyRegistration({ clientDataJSON: body.response.clientDataJSON, attestationObject: body.response.attestationObject }, { challenge: wa.challenge, origin, rpId });
            user.passkeys = user.passkeys || [];
            if (user.passkeys.some(p => p.credId === r.credId)) return sendJSON(res, 409, { error: 'passkey already registered' });
            user.passkeys.push({ credId: r.credId, publicKeyPem: r.publicKeyPem, kind: r.kind, counter: r.counter, name: (body.name || 'passkey').slice(0, 40), created: Date.now() });
            saveUser(user);
            return sendJSON(res, 200, { ok: true });
          } catch (e) { return sendJSON(res, 400, { error: e.message }); }
        }
        if (!wa || wa.purpose !== 'login') return sendJSON(res, 400, { error: 'no or expired challenge' });
        const found = findUserByCredId(body.id);
        if (!found) return sendJSON(res, 401, { error: 'unknown passkey' });
        try {
          const r = webauthn.verifyAssertion({ clientDataJSON: body.response.clientDataJSON, authenticatorData: body.response.authenticatorData, signature: body.response.signature }, found.passkey, { challenge: wa.challenge, origin, rpId });
          found.passkey.counter = r.newCounter; found.passkey.lastUsed = Date.now(); saveUser(found.user);
          res.setHeader('Set-Cookie', sessionCookie(req, found.user.username));
          return sendJSON(res, 200, { ok: true, username: found.user.username });
        } catch (e) { return sendJSON(res, 401, { error: e.message }); }
      }
      const form = querystring.parse(buf.toString());
      if (u.pathname === '/account/passkeys/revoke') {
        if (!user) return redirect(res, '/login');
        user.passkeys = (user.passkeys || []).filter(p => p.credId !== form.id);
        saveUser(user); return redirect(res, '/account');
      }
      // Add a package by its source URL (repo or mvpkg.json).  The provider
      // reads the manifest, records the source, installs release tracking where
      // it can, and indexes the current release.  Authenticated by a browser
      // session (HTML response) OR an X-Auth-Token header (JSON response) so a
      // headless client — CLI/CI — can publish non-interactively.
      if (u.pathname === '/packages') {
        const actor = user ? { user, viaToken: false } : tokenActor(req);
        if (!actor) return tokenAttempt(req) ? sendJSON(res, 401, { error: 'bad or missing token' }) : redirect(res, '/login');
        addPackage(actor.user, form.source, form.package, (err, r) => {
          if (actor.viaToken) return err ? sendJSON(res, 400, { error: err.message }) : sendJSON(res, 200, r);
          if (err) return sendHTML(res, 400, accountPage(actor.user, { addError: err.message }));
          return sendHTML(res, 200, accountPage(loadUser(actor.user.username), { added: r }));
        });
        return;                                          // response sent asynchronously
      }
      if (u.pathname === '/packages/remove') {
        const actor = user ? { user, viaToken: false } : tokenActor(req);
        if (!actor) return tokenAttempt(req) ? sendJSON(res, 401, { error: 'bad or missing token' }) : redirect(res, '/login');
        const pkg = loadPackage(String(form.name || '').trim());
        const allowed = pkg && (pkg.owner === actor.user.username || isAdminUser(actor.user));
        if (allowed) {
          if (pkg.tracking && pkg.tracking.hookId) {
            const prov = providers.byName(pkg.tracking.provider);
            if (prov && prov.removeTracking) prov.removeTracking(pkg.tracking.ref, { hookId: pkg.tracking.hookId }, () => {});
          }
          try { fs.rmSync(path.join(REGDIR, pkg.name), { recursive: true, force: true }); } catch {}
        }
        if (actor.viaToken) return allowed ? sendJSON(res, 200, { removed: pkg.name }) : sendJSON(res, pkg ? 403 : 404, { error: pkg ? 'not owner' : 'no such package' });
        return redirect(res, '/account');
      }
      // Catch up a package on demand (a missed webhook, or a source with no push
      // tracking) — the same work a poll would do, but for one package only, and
      // only when asked.  Owner/admin (or their token).
      if (u.pathname === '/packages/refresh') {
        const actor = user ? { user, viaToken: false } : tokenActor(req);
        if (!actor) return tokenAttempt(req) ? sendJSON(res, 401, { error: 'bad or missing token' }) : redirect(res, '/login');
        const pkg = loadPackage(String(form.name || '').trim());
        const allowed = pkg && (pkg.owner === actor.user.username || isAdminUser(actor.user));
        if (!allowed) {
          if (actor.viaToken) return sendJSON(res, pkg ? 403 : 404, { error: pkg ? 'not owner' : 'no such package' });
          return redirect(res, '/account');
        }
        return refreshPackage(pkg, () => {
          if (actor.viaToken) { const f = loadPackage(pkg.name); return sendJSON(res, 200, { name: pkg.name, version: f && f.version }); }
          return sendHTML(res, 200, accountPage(loadUser(actor.user.username), { refreshed: pkg.name }));
        });
      }
      // GitHub App admin actions (admin only).
      if (u.pathname === '/gh/app/disconnect') {
        if (!user || !isAdminUser(user)) return redirect(res, user ? '/account' : '/login');
        try { fs.rmSync(GHAPP_FILE, { force: true }); } catch {}
        return redirect(res, '/gh/app');
      }
      if (u.pathname === '/gh/app/sync') {
        if (!user || !isAdminUser(user)) return redirect(res, user ? '/account' : '/login');
        const app = loadGhApp();
        if (!app) return redirect(res, '/gh/app');
        // Relearn coverage from GitHub (a safety net for a missed `installation`
        // webhook).  Accumulate into a local map, then persist once — no races.
        return ghapp.listInstallations(app, (err, insts) => {
          if (err) return sendHTML(res, 200, ghAppPage(user, { error: 'sync failed: ' + err.message }));
          const installs = {};
          let pending = insts.length;
          const finish = () => { const f = loadGhApp(); if (f) { f.installs = installs; saveGhApp(f); } return sendHTML(res, 200, ghAppPage(user, { synced: insts.length })); };
          if (!pending) return finish();
          insts.forEach(inst => {
            const owner = String(inst.account || '').toLowerCase();
            if (!owner) { if (--pending <= 0) finish(); return; }
            if (inst.selection === 'all') {
              installs[owner] = { installationId: inst.id, selection: 'all', repos: {}, updated: Date.now() };
              if (--pending <= 0) finish(); return;
            }
            ghapp.installationRepos(app, inst.id, (e, repos) => {
              const map = {}; (repos || []).forEach(r => { map[String(r).toLowerCase()] = true; });
              installs[owner] = { installationId: inst.id, selection: 'selected', repos: map, updated: Date.now() };
              if (--pending <= 0) finish();
            });
          });
        });
      }
      if (u.pathname === '/register') return handleRegister(req, res, form);
      if (u.pathname === '/login') return handleLogin(req, res, form);
      if (u.pathname === '/logout') { clearSessionCookie(res); return redirect(res, '/'); }
      if (u.pathname === '/account/tokens') {
        if (!user) return redirect(res, '/login');
        const tok = newToken();
        user.tokens = user.tokens || [];
        user.tokens.push({ id: crypto.randomBytes(6).toString('hex'), name: (form.name || 'token').slice(0, 40), hash: tokenHash(tok), created: Date.now(), lastUsed: 0 });
        saveUser(user);
        return sendHTML(res, 200, accountPage(user, { freshToken: tok }), { 'Set-Cookie': sessionCookie(req, user.username) });
      }
      if (u.pathname === '/account/tokens/revoke') {
        if (!user) return redirect(res, '/login');
        user.tokens = (user.tokens || []).filter(t => t.id !== form.id);
        saveUser(user);
        return redirect(res, '/account');
      }
      res.writeHead(404); res.end('not found');
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }

  // website
  if (u.pathname === '/') return sendHTML(res, 200, homePage(u.query.q, user));
  if (u.pathname === '/register') return sendHTML(res, 200, authForm('register'));
  if (u.pathname === '/login') return sendHTML(res, 200, authForm('login'));
  if (u.pathname === '/account') return user ? sendHTML(res, 200, accountPage(user)) : redirect(res, '/login');
  // GitHub App: status/connect page (admin), the manifest-create redirector,
  // and GitHub's post-create callback.
  if (u.pathname === '/gh/app') {
    if (!user) return redirect(res, '/login');
    if (!isAdminUser(user)) return sendHTML(res, 403, page('GitHub App', '<div class="msg err">Admins only.</div>', user));
    return sendHTML(res, 200, ghAppPage(user));
  }
  if (u.pathname === '/gh/app/create') {
    if (!user || !isAdminUser(user)) return redirect(res, user ? '/account' : '/login');
    if (!BASE_URL) return sendHTML(res, 200, ghAppPage(user, { error: 'set PUBLIC_ORIGIN/WEBAUTHN_ORIGIN so GitHub can redirect back.' }));
    // GitHub's manifest flow: POST the manifest to settings/apps/new; on confirm
    // GitHub redirects to redirect_url?code=&state=.  A signed, 15-min state is
    // the CSRF guard.  Create under an org when given, else the user's account.
    const org = String(u.query.org || '').trim();
    const state = signValue({ p: 'ghapp-create', u: user.username, exp: Date.now() + 15 * 60 * 1000 });
    const action = (org ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new` : 'https://github.com/settings/apps/new') + '?state=' + encodeURIComponent(state);
    const manifest = JSON.stringify(ghapp.buildManifest(BASE_URL));
    return sendHTML(res, 200, page('Create GitHub App',
      `<h3>Creating the GitHub App…</h3>
       <p class="meta">You'll be taken to GitHub to confirm. It creates the App and sends you back here — no token to paste.</p>
       <form id="mf" method="post" action="${esc(action)}">
         <input type="hidden" name="manifest" value='${esc(manifest)}'>
         <noscript><button class="primary" type="submit">Continue to GitHub</button></noscript>
       </form>
       <script>document.getElementById('mf').submit();</script>`, user));
  }
  if (u.pathname === '/gh/app/created') {
    if (!user || !isAdminUser(user)) return redirect(res, user ? '/account' : '/login');
    const st = readSigned(String(u.query.state || ''));
    if (!st || st.p !== 'ghapp-create') return sendHTML(res, 400, ghAppPage(user, { error: 'invalid or expired create state — start again.' }));
    const code = String(u.query.code || '');
    if (!code) return sendHTML(res, 400, ghAppPage(user, { error: 'no code from GitHub — start again.' }));
    return ghapp.convertManifest(code, (err, app) => {
      if (err) return sendHTML(res, 200, ghAppPage(user, { error: 'App creation failed: ' + err.message }));
      app.installs = {};
      app.connectedBy = user.username;
      app.connectedAt = Date.now();
      saveGhApp(app);
      return sendHTML(res, 200, ghAppPage(user, { created: true }));
    });
  }
  if (u.pathname === '/wa.js') {
    try { const js = fs.readFileSync(path.join(__dirname, 'public', 'wa.js'));
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': js.length }); return res.end(js);
    } catch { res.writeHead(404); return res.end('not found'); }
  }
  if (u.pathname === '/webauthn/register/options') {
    if (!user) return sendJSON(res, 401, { error: 'sign in first' });
    const { rpId } = rpFor(req); const ch = webauthn.challenge();
    res.setHeader('Set-Cookie', waCookie({ challenge: ch, purpose: 'register', username: user.username, exp: Date.now() + 3e5 }));
    return sendJSON(res, 200, { challenge: ch, rp: { id: rpId, name: 'mv_package' },
      user: { id: waUserId(user), name: user.username, displayName: user.username },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      timeout: 6e4, attestation: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      excludeCredentials: (user.passkeys || []).map(p => ({ type: 'public-key', id: p.credId })) });
  }
  if (u.pathname === '/webauthn/login/options') {
    const { rpId } = rpFor(req); const ch = webauthn.challenge();
    const target = u.query.username ? loadUser(String(u.query.username).trim()) : null;
    const allow = target ? (target.passkeys || []).map(p => ({ type: 'public-key', id: p.credId })) : [];
    res.setHeader('Set-Cookie', waCookie({ challenge: ch, purpose: 'login', exp: Date.now() + 3e5 }));
    return sendJSON(res, 200, { challenge: ch, rpId, allowCredentials: allow, userVerification: 'preferred', timeout: 6e4 });
  }
  if (parts[0] === 'p' && parts[1]) {
    const nm = parts.slice(1).join('/');               // scoped: /p/<scope>/<name>
    if (!okName(nm)) { res.writeHead(400); return res.end('bad name'); }
    const html = pkgPage(nm, user);
    return html ? sendHTML(res, 200, html) : sendHTML(res, 404, page('not found', '<div class="empty">No such package.</div>', user));
  }

  // JSON API
  if (parts[0] === 'package' && parts[1]) {
    const nm = parts.slice(1).join('/');               // scoped: /package/<scope>/<name>
    if (!okName(nm)) return sendJSON(res, 404, { error: 'not found' });
    const meta = loadPackage(nm) || findProvider(nm);  // real package, else a provider
    if (!meta) return sendJSON(res, 404, { error: 'not found' });
    // ?version=<exact> -> that version (for a client resolving a constraint);
    // else the latest.  Both carry the `versions` list and ?system=&arch=
    // artifact resolution.
    if (u.query.version) {
      const r = resolveExactVersion(meta, String(u.query.version), u.query.system, u.query.os, u.query.arch, u.query.endian);
      return r ? sendJSON(res, 200, r) : sendJSON(res, 404, { error: 'no such version' });
    }
    return sendJSON(res, 200, selectArtifact(meta, u.query.system, u.query.os, u.query.arch, u.query.endian));
  }
  if (parts[0] === 'search') {
    const qs = String(u.query.q || '').toLowerCase();
    const hits = loadPackages().filter(p => !qs || (p.name + ' ' + (p.description || '')).toLowerCase().includes(qs))
      .map(p => ({ name: p.name, version: p.version, description: p.description || '' }));
    return sendJSON(res, 200, { packages: hits });
  }
  if (parts[0] === 'packages') return sendJSON(res, 200, { packages: loadPackages() });

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`mv_package registry on http://0.0.0.0:${PORT}  (index: ${REGDIR})`);
  console.log('  a package is added from its source URL; the registry hosts nothing.');
});

// Refresh a package's manifest-derived metadata (description, license,
// dependencies, systems) and its README from the source, so the index stays
// current when a package edits its mvpkg.json or README without re-adding.
// Change-aware: writes only when something actually differs.  cb() when done.
function refreshMeta(pkg, cb) {
  const prov = providers.byName(pkg.tracking && pkg.tracking.provider);
  const ref = pkg.tracking && pkg.tracking.ref;
  if (!prov || !prov.fetchManifest || !ref) return cb();
  prov.fetchManifest(ref, (e, txt) => {
    const fresh = loadPackage(pkg.name);
    if (!fresh) return cb();
    let changed = false;
    if (!e && txt) { try {
      const j = JSON.parse(txt);
      if (j.description && j.description !== fresh.description) { fresh.description = j.description; changed = true; }
      if (j.license && j.license !== fresh.license) { fresh.license = j.license; changed = true; }
      const deps = Array.isArray(j.dependencies) ? j.dependencies.join(' ') : (j.dependencies || '');
      if (deps && deps !== fresh.dependencies) { fresh.dependencies = deps; changed = true; }
      const devdeps = Array.isArray(j.devDependencies) ? j.devDependencies.join(' ') : (j.devDependencies || '');
      if (devdeps !== (fresh.devDependencies || '')) { fresh.devDependencies = devdeps; changed = true; }
      const provs = Array.isArray(j.provides) ? j.provides.join(' ') : (j.provides || '');
      if (provs !== (fresh.provides || '')) { fresh.provides = provs; changed = true; }
      const clibs = Array.isArray(j.clibs) ? j.clibs.join(' ') : (j.clibs || '');
      if (clibs !== (fresh.clibs || '')) { fresh.clibs = clibs; changed = true; }
      const shell = Array.isArray(j.shell) ? j.shell.join(' ') : (j.shell || '');
      if (shell !== (fresh.shell || '')) { fresh.shell = shell; changed = true; }
      if (Array.isArray(j.systems) && j.systems.length) {
        const sys = [...new Set([...(fresh.systems || []), ...j.systems])];   // additive (binaries also add systems)
        if (sys.length !== (fresh.systems || []).length) { fresh.systems = sys; changed = true; }
      }
    } catch {} }
    const finish = () => {
      if (changed) { fresh.updated = Date.now(); savePackage(fresh); console.log(`${pkg.name}: metadata refreshed`); }
      cb();
    };
    if (prov.fetchFile) prov.fetchFile(ref, 'README.md', (er, rd) => {
      if (rd && rd !== fresh.readme) { fresh.readme = rd; changed = true; }
      finish();
    }); else finish();
  });
}

// Refresh one package on demand: manifest/README, then the latest release, then
// a version-history backfill.  Releases are normally pushed by webhook, so this
// is NOT a timer — it is invoked explicitly (the account "Refresh" button) to
// catch up a missed webhook or a source with no push tracking (GitLab, a bare
// manifest).  The registry never polls every package: that does not scale.
function refreshPackage(pkg, cb) {
  const prov = providers.byName(pkg.tracking && pkg.tracking.provider);
  const ref = pkg.tracking && pkg.tracking.ref;
  if (!prov || !ref) return cb();
  // Serialised: each step loads-then-saves the meta, so running in sequence
  // avoids clobbering one another's fields.
  refreshMeta(pkg, () => {
    if (!prov.latestRelease) return cb();
    prov.latestRelease(ref, (e, rel) => {
      if (!e && rel && rel.version) {
        const fresh = loadPackage(pkg.name);
        if (fresh) { const n = indexRelease(fresh, rel); if (n) console.log(`refresh: ${pkg.name} -> ${rel.tag} (indexed ${n})`); }
      }
      if (!pkg.versions && prov.listVersions) return prov.listVersions(ref, (e2, vers) => {
        if (!e2 && vers && vers.length) {
          const f2 = loadPackage(pkg.name);
          if (f2) { vers.forEach(v => mergeVersion(f2, v)); savePackage(f2); }
        }
        cb();
      });
      cb();
    });
  });
}
