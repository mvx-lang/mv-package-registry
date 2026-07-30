// mv_package registry — the packagist/npm-registry equivalent for MultiValue.
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
//
// A dependency-free HTTP registry + website.  Packages live under
// registry/<name>/ as a meta.json ({name, version, description, dependencies,
// systems, tarball}) beside the release tar the tarball path points at.
//
// JSON API (the MVPKG client speaks this):
//   GET  /package/<name>   -> that package's meta.json
//   GET  /search?q=<term>  -> {"packages":[{name,version,description}, ...]}
//   GET  /tarball/<n>/<f>  -> the release tar bytes (application/gzip)
//
// Publish (push a release; token-gated when MVPKG_PUBLISH_TOKEN is set):
//   POST /publish?name=&version=&description=&dependencies=&systems=
//        body = the .tar.gz bytes
//
// Website (browse):
//   GET  /                 -> home: search + package list
//   GET  /p/<name>         -> package page (install command, deps, download)
//
//   node server.js [port]        (default 8080; or $MVPKG_PORT)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const REGDIR = process.env.MVPKG_REGISTRY_DIR || path.join(__dirname, 'registry');
const PORT = Number(process.argv[2] || process.env.MVPKG_PORT || 8080);
const TOKEN = process.env.MVPKG_PUBLISH_TOKEN || '';   // empty = open publish

// ---- storage ----------------------------------------------------------
// Read every registry/<name>/meta.json.  Re-read per request so a package
// published while the server runs is picked up without a restart.
function loadPackages() {
  const out = [];
  let names;
  try { names = fs.readdirSync(REGDIR); } catch { return out; }
  for (const name of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(REGDIR, name, 'meta.json'), 'utf8'));
      if (meta && meta.name) out.push(meta);
    } catch { /* not a package dir */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
function loadPackage(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REGDIR, name, 'meta.json'), 'utf8'));
  } catch { return null; }
}

// ---- helpers ----------------------------------------------------------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendHTML(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8',
                        'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const okName = n => /^[A-Za-z0-9._-]+$/.test(n);   // safe package name

// ---- website ----------------------------------------------------------
const CSS = `
:root{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--mut:#9198a1;--acc:#58a6ff;--code:#0b0f14}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:820px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--line);padding:22px 0;margin-bottom:24px}
header .wrap{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
h1{font-size:20px;margin:0}h1 a{color:var(--fg)}.tag{color:var(--mut);font-size:13px}
form{margin:0 0 22px}input[type=search]{width:100%;padding:10px 12px;border-radius:8px;
border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:15px}
.card{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:14px 16px;margin:10px 0}
.card h3{margin:0 0 4px;font-size:16px}.card .v{color:var(--mut);font-weight:400;font-size:13px}
.card p{margin:6px 0 0;color:var(--fg)}
.badge{display:inline-block;font-size:11px;color:var(--mut);border:1px solid var(--line);
border-radius:20px;padding:1px 8px;margin-left:6px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto}
.meta{color:var(--mut);font-size:13px;margin:2px 0}.meta b{color:var(--fg);font-weight:600}
footer{color:var(--mut);font-size:12px;border-top:1px solid var(--line);margin-top:34px;padding:18px 0}
.empty{color:var(--mut);padding:30px 0;text-align:center}`;

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><div class="wrap"><h1><a href="/">mv_package</a></h1>
<span class="tag">a package registry for MultiValue</span></div></header>
<main class="wrap">${inner}</main>
<footer class="wrap">mv_package &middot; Composer/npm for the PICK world &middot;
<code>MVPKG install &lt;name&gt;</code></footer></body></html>`;
}

function homePage(q) {
  const all = loadPackages();
  const ql = (q || '').toLowerCase();
  const list = all.filter(p => !ql ||
    (p.name + ' ' + (p.description || '')).toLowerCase().includes(ql));
  const search = `<form method="get" action="/"><input type="search" name="q"
    placeholder="Search ${all.length} package${all.length === 1 ? '' : 's'}…"
    value="${esc(q || '')}" autofocus></form>`;
  if (!list.length) {
    return page('mv_package', search +
      `<div class="empty">${all.length ? 'No packages match your search.'
        : 'No packages published yet.'}</div>`);
  }
  const cards = list.map(p => {
    const sys = (p.systems && p.systems.length)
      ? p.systems.map(s => `<span class="badge">${esc(s)}</span>`).join('') : '';
    return `<a class="card" href="/p/${esc(p.name)}" style="display:block">
      <h3>${esc(p.name)} <span class="v">${esc(p.version || '')}</span>${sys}</h3>
      <p>${esc(p.description || '')}</p></a>`;
  }).join('');
  return page('mv_package', search + cards);
}

function pkgPage(name) {
  const p = loadPackage(name);
  if (!p) return null;
  const deps = String(p.dependencies || '').trim();
  const depsHtml = deps
    ? deps.split(/\s+/).map(d => `<a href="/p/${esc(d)}">${esc(d)}</a>`).join(', ')
    : '<span class="meta">none</span>';
  const sys = (p.systems && p.systems.length) ? p.systems.map(esc).join(', ') : 'any';
  const tar = p.tarball ? `<p class="meta"><b>Download:</b>
    <a href="${esc(p.tarball)}">${esc(path.basename(p.tarball))}</a></p>` : '';
  const inner =
    `<div class="card"><h3>${esc(p.name)} <span class="v">${esc(p.version || '')}</span></h3>
     <p>${esc(p.description || '')}</p></div>
     <h3>Install</h3><pre>MVPKG install ${esc(p.name)}</pre>
     <p class="meta"><b>Dependencies:</b> ${depsHtml}</p>
     <p class="meta"><b>Systems:</b> ${esc(sys)}</p>
     ${tar}
     <p style="margin-top:22px"><a href="/">&larr; all packages</a></p>`;
  return page(`${p.name} — mv_package`, inner);
}

// ---- publish ----------------------------------------------------------
function publish(req, res, q) {
  const h = req.headers;
  // metadata may come as X-Pkg-* headers (no URL-encoding) or query params
  const field = (hk, qk) => (h[hk] != null ? String(h[hk]) : String(q[qk] || ''));
  if (TOKEN) {
    const given = h['x-auth-token'] || q.token || '';
    if (given !== TOKEN) return sendJSON(res, 401, { error: 'bad or missing token' });
  }
  const name = field('x-pkg-name', 'name'), version = field('x-pkg-version', 'version');
  if (!okName(name) || !version) return sendJSON(res, 400, { error: 'name and version required' });
  const chunks = [];
  let size = 0;
  req.on('data', c => { size += c.length;
    if (size > 64 * 1024 * 1024) req.destroy();        // 64 MB cap
    else chunks.push(c); });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (!buf.length) return sendJSON(res, 400, { error: 'empty body (expected tar.gz)' });
    const dir = path.join(REGDIR, name);
    const tarName = `${name}-${version}.tar.gz`;
    const sysRaw = field('x-pkg-systems', 'systems');
    const meta = {
      name, version,
      description: field('x-pkg-description', 'description'),
      dependencies: field('x-pkg-dependencies', 'dependencies'),
      systems: sysRaw ? sysRaw.split(/[,\s]+/).filter(Boolean) : [],
      tarball: `/tarball/${name}/${tarName}`,
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, tarName), buf);
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    } catch (e) { return sendJSON(res, 500, { error: 'write failed: ' + e.message }); }
    console.log(`published ${name} ${version} (${buf.length} bytes)`);
    sendJSON(res, 200, { ok: true, name, version });
  });
}

// ---- routing ----------------------------------------------------------
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const parts = u.pathname.split('/').filter(Boolean);

  if (req.method === 'POST' && parts[0] === 'publish') return publish(req, res, u.query);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end('method not allowed');
  }

  // ---- website ----
  if (u.pathname === '/') return sendHTML(res, 200, homePage(u.query.q));
  if (parts[0] === 'p' && parts[1]) {
    if (!okName(parts[1])) { res.writeHead(400); return res.end('bad name'); }
    const html = pkgPage(parts[1]);
    return html ? sendHTML(res, 200, html)
                : sendHTML(res, 404, page('not found', '<div class="empty">No such package.</div>'));
  }

  // ---- JSON API ----
  if (parts[0] === 'package' && parts[1]) {
    const meta = loadPackage(parts[1]);
    return meta ? sendJSON(res, 200, meta) : sendJSON(res, 404, { error: 'not found' });
  }
  if (parts[0] === 'search') {
    const qs = String(u.query.q || '').toLowerCase();
    const hits = loadPackages()
      .filter(p => !qs || (p.name + ' ' + (p.description || '')).toLowerCase().includes(qs))
      .map(p => ({ name: p.name, version: p.version, description: p.description || '' }));
    return sendJSON(res, 200, { packages: hits });
  }
  if (parts[0] === 'tarball' && parts[1]) {
    const file = path.normalize(parts.slice(1).join('/'));
    if (file.startsWith('..')) { res.writeHead(400); return res.end('bad path'); }
    return fs.readFile(path.join(REGDIR, file), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': data.length });
      res.end(data);
    });
  }
  if (parts[0] === 'packages') return sendJSON(res, 200, { packages: loadPackages() });

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`mv_package registry on http://0.0.0.0:${PORT}  (registry: ${REGDIR})`);
  if (!TOKEN) console.log('  publish is OPEN (set MVPKG_PUBLISH_TOKEN to require a token)');
});
