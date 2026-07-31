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
const isAdminUser = u => u && ADMIN_USERS.includes(String(u.username).toLowerCase());
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
:root{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--mut:#9198a1;--acc:#58a6ff;--code:#0b0f14;--ok:#3fb950;--err:#f85149}
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
button{padding:9px 16px;border-radius:8px;border:1px solid var(--line);background:#21262d;color:var(--fg);cursor:pointer}
button:hover{border-color:var(--acc)}button.primary{background:#238636;border-color:#238636}
.card{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:14px 16px;margin:10px 0}
.card h3{margin:0 0 4px;font-size:16px}.card .v{color:var(--mut);font-weight:400;font-size:13px}.card p{margin:6px 0 0}
.badge{display:inline-block;font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:20px;padding:1px 8px;margin-left:6px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto}
.meta{color:var(--mut);font-size:13px;margin:2px 0}.meta b{color:var(--fg);font-weight:600}
.msg{border-radius:8px;padding:10px 12px;margin:0 0 16px}.msg.err{border:1px solid var(--err);color:#ffb0aa}.msg.ok{border:1px solid var(--ok);color:#9ff0b0}
.tok{font-family:ui-monospace,monospace;background:var(--code);border:1px solid var(--ok);border-radius:8px;padding:12px;word-break:break-all}
footer{color:var(--mut);font-size:12px;border-top:1px solid var(--line);margin-top:34px;padding:18px 0}
.empty{color:var(--mut);padding:30px 0;text-align:center}`;

function page(title, inner, user) {
  const nav = user
    ? `<a href="/account">${esc(user.username)}</a> <form method="post" action="/logout" style="margin:0;display:inline"><button style="padding:2px 10px">Sign out</button></form>`
    : `<a href="/login">Sign in</a> <a href="/register">Register</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><div class="wrap"><h1><a href="/">mv_package</a></h1><span class="tag">a package registry for MultiValue</span>
<span class="nav">${nav}</span></div></header>
<main class="wrap">${inner}</main>
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

function pkgPage(name, user) {
  const p = loadPackage(name);
  if (!p) return null;
  const deps = String(p.dependencies || '').trim();
  const depsHtml = deps ? deps.split(/\s+/).map(d => `<a href="/p/${esc(d)}">${esc(d)}</a>`).join(', ') : '<span class="meta">none</span>';
  const sys = (p.systems && p.systems.length) ? p.systems.map(esc).join(', ') : 'any';
  const tar = (p.artifacts && p.artifacts.length)
    ? '<p class="meta"><b>Artifacts:</b></p>' + p.artifacts.map(a =>
        `<p class="meta">&bull; <a href="${esc(a.tarball)}">${esc(a.kind === 'binary' ? artLabel(a) : 'source')}</a>${a.external ? ' <span class="meta">— external</span>' : ''}</p>`).join('')
    : (p.tarball ? `<p class="meta"><b>Download:</b> <a href="${esc(p.tarball)}">${esc(path.basename(p.tarball))}</a></p>` : '');
  const owner = p.owner ? `<p class="meta"><b>Owner:</b> ${esc(p.owner)}</p>` : '';
  const src = p.source ? `<p class="meta"><b>Source:</b> <a href="${esc(p.source)}">${esc(p.source)}</a></p>` : '';
  const license = `<p class="meta"><b>Licence:</b> ${p.license ? esc(p.license) : '<span class="meta">unspecified</span>'}</p>`;
  // A version whose artifacts include no "source" is binary-only (commercial).
  const binaryOnly = p.artifacts && p.artifacts.length && !p.artifacts.some(a => a.kind === 'source');
  const dist = `<p class="meta"><b>Distribution:</b> ${binaryOnly ? 'binary only — no source' : 'source included'}</p>`;
  return page(`${p.name} — mv_package`,
    `<div class="card"><h3>${esc(p.name)} <span class="v">${esc(p.version || '')}</span></h3><p>${esc(p.description || '')}</p></div>
     <h3>Install</h3><pre>MVPKG install ${esc(p.name)}</pre>
     <p class="meta"><b>Dependencies:</b> ${depsHtml}</p><p class="meta"><b>Systems:</b> ${esc(sys)}</p>${license}${dist}${src}${owner}${tar}
     <p class="meta" style="margin-top:14px">This is an index — packages are hosted at their source; downloads link out.</p>
     <p style="margin-top:22px"><a href="/">&larr; all packages</a></p>`, user);
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
        const track = t.hookId ? 'auto-updating on release &#10003;' : (t.provider ? 'tracked (polling)' : 'not tracked');
        return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div>
          <b><a href="/p/${esc(p.name)}">${esc(p.name)}</a></b> <span class="v">${esc(p.version || '—')}</span><br>
          <span class="meta">source: ${p.source ? '<a href="' + esc(p.source) + '">' + esc(p.source) + '</a>' : 'unknown'}</span><br>
          <span class="meta">releases: ${esc(track)}</span></div>
          <form method="post" action="/packages/remove" style="margin:0" onsubmit="return confirm('Remove ${esc(p.name)} from the index?')"><input type="hidden" name="name" value="${esc(p.name)}"><button style="padding:4px 12px">Remove</button></form></div></div>`;
      }).join('')
    : '<p class="meta">No packages yet — add one below by pasting its source URL.</p>';
  const adminBadge = isAdminUser(user) ? ' <span class="badge" style="border-color:var(--acc);color:var(--acc)">admin</span>' : '';
  const pks = (user.passkeys || []).length
    ? (user.passkeys || []).map(p => `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${esc(p.name || 'passkey')}</b> <span class="badge">${esc(p.kind || 'ec')}</span><br><span class="meta">added ${new Date(p.created).toISOString().slice(0, 10)}${p.lastUsed ? ' &middot; last used ' + new Date(p.lastUsed).toISOString().slice(0, 10) : ''}</span></div>
        <form method="post" action="/account/passkeys/revoke" style="margin:0"><input type="hidden" name="id" value="${esc(p.credId)}"><button style="padding:4px 12px">Remove</button></form></div>`).join('')
    : '<p class="meta">No passkeys yet.</p>';
  const a = opts.added;
  const addMsg = a
    ? `<div class="msg ok">Added <code>${esc(a.name)}</code>${a.installed ? ' — release tracking installed; new releases appear here automatically.' : (a.note ? ' — <span class="meta">' + esc(a.note) + '</span>' : '')}</div>`
    : '';
  const addErr = opts.addError ? `<div class="msg err">${esc(opts.addError)}</div>` : '';
  return page('Account — mv_package',
    `<h3>Signed in as ${esc(user.username)}${adminBadge}</h3>
     <h3 style="margin-top:24px">Passkeys</h3>${pks}
     <p><button class="primary" type="button" onclick="addPasskey()">+ Add a passkey</button></p>
     <h3 style="margin-top:24px">Your packages</h3>${addMsg}${addErr}${pkgs}
     <form method="post" action="/packages" style="margin-top:14px">
       <label>Add a package — paste its <b>source URL</b> (a repository, or a link to its <code>mvpkg.json</code>)</label>
       <input type="text" name="source" placeholder="https://&hellip;/your-package   &middot;   or a link to its mvpkg.json" required>
       <label>Package name <span class="meta">(optional &mdash; read from mvpkg.json)</span></label>
       <input type="text" name="package" placeholder="mv-lang/git">
       <div style="margin-top:10px"><button class="primary" type="submit">Add package</button></div>
     </form>
     <p class="meta">The registry indexes your package and tracks its releases &mdash; it hosts nothing; downloads come from the source.</p>`, user);
}

// ---- packages: a source-tracked index (no hosting) ------------------
// A package is added from a source URL; a provider reads its mvpkg.json and
// finds its releases, whose assets are recorded as external artifact URLs.
// Release assets follow `<base>-<version>-<suffix>.tar.gz` (base = name with
// '/'->'_', suffix "source" or "<system>-<os>-<arch>-<endian>").

// Index a release's assets onto a package: refresh version + artifacts (all
// external), keep source/tracking/owner.  Returns how many assets were indexed.
function indexRelease(pkg, rel) {
  if (!rel || !rel.version) return 0;
  const version = rel.version;
  const prefix = `${pkg.name.replace(/\//g, '_')}-${version}-`;
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
  if (!arts.length) return 0;                          // nothing recognisable in this release
  pkg.version = version;
  pkg.artifacts = arts;
  const src = arts.find(a => a.kind === 'source');
  pkg.tarball = src ? src.tarball : (arts[0] ? arts[0].tarball : '');
  pkg.systems = [...new Set([...(pkg.systems || []), ...arts.filter(a => a.kind === 'binary').map(a => a.system)])];
  pkg.updated = Date.now();
  if (pkg.tracking) pkg.tracking.latest = { version, tag: rel.tag, at: rel.at, html: rel.html, seenAt: Date.now() };
  savePackage(pkg);
  return arts.length;
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
    if (man.systems && man.systems.length) meta.systems = [...new Set([...(meta.systems || []), ...man.systems])];
    meta.tracking = meta.tracking || { id: crypto.randomBytes(6).toString('hex'), secret: crypto.randomBytes(24).toString('base64url'), hookId: null, latest: null };
    meta.tracking.provider = provider.name;
    meta.tracking.ref = ref;
    meta.updated = Date.now();
    savePackage(meta);

    const indexLatest = (installed, note) => provider.latestRelease(ref, (e2, rel) => {
      if (!e2 && rel) { const fresh = loadPackage(name); if (fresh) indexRelease(fresh, rel); }
      cb(null, { name, installed, note });
    });

    if (provider.supportsTracking) {
      provider.installTracking(ref, { hookUrl: `${BASE_URL}/webhook/${meta.tracking.id}`, secret: meta.tracking.secret }, (herr, hook) => {
        if (hook) { const fresh = loadPackage(name); if (fresh && fresh.tracking) { fresh.tracking.hookId = hook.id || null; savePackage(fresh); } }
        indexLatest(!herr && !!hook, herr ? herr.message : null);
      });
    } else {
      indexLatest(false, 'Releases are picked up by polling (this source has no push webhook).');
    }
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
    license: meta.license || '', sourceIncluded,
    systems: meta.systems || [], owner: meta.owner, selected,
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
      // Add a package by pasting its source URL (repo or mvpkg.json).  The
      // provider reads the manifest, records the source, installs release
      // tracking where it can, and indexes the current release.
      if (u.pathname === '/packages') {
        if (!user) return redirect(res, '/login');
        addPackage(user, form.source, form.package, (err, r) => {
          if (err) return sendHTML(res, 400, accountPage(user, { addError: err.message }));
          return sendHTML(res, 200, accountPage(loadUser(user.username), { added: r }));
        });
        return;                                          // response sent asynchronously
      }
      if (u.pathname === '/packages/remove') {
        if (!user) return redirect(res, '/login');
        const pkg = loadPackage(String(form.name || '').trim());
        if (pkg && (pkg.owner === user.username || isAdminUser(user))) {
          if (pkg.tracking && pkg.tracking.hookId) {
            const prov = providers.byName(pkg.tracking.provider);
            if (prov && prov.removeTracking) prov.removeTracking(pkg.tracking.ref, { hookId: pkg.tracking.hookId }, () => {});
          }
          try { fs.rmSync(path.join(REGDIR, pkg.name), { recursive: true, force: true }); } catch {}
        }
        return redirect(res, '/account');
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
    const meta = loadPackage(nm);
    if (!meta) return sendJSON(res, 404, { error: 'not found' });
    // ?system=&arch= -> tarball resolved to the best matching artifact
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

// Poll tracked packages for new releases — the fallback to a webhook, and how
// providers without push tracking (e.g. GitLab for now) are picked up at all.
const POLL_MS = Number(process.env.GITHUB_POLL_MS || 15 * 60 * 1000);
if (POLL_MS > 0) setInterval(() => {
  for (const pkg of loadPackages()) {
    if (!pkg.tracking || !pkg.tracking.provider) continue;
    const prov = providers.byName(pkg.tracking.provider);
    if (!prov) continue;
    prov.latestRelease(pkg.tracking.ref, (e, rel) => {
      if (e || !rel || !rel.version) return;
      const seen = pkg.tracking.latest && pkg.tracking.latest.version;
      if (seen === rel.version) return;
      const fresh = loadPackage(pkg.name);
      if (fresh) { const n = indexRelease(fresh, rel); if (n) console.log(`poll: ${pkg.name} -> ${rel.tag} (indexed ${n})`); }
    });
  }
}, POLL_MS).unref();
