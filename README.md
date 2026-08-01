# mv-package-registry

The backend for [mv_package](https://github.com/mvx-lang/mv_package) — the
registry **service + website** (the packagist/npm equivalent for
MultiValue), the tools that build and publish releases, and the UniData
builder image. Split out of the client repo so people installing the
`MVPKG` client don't download the server and build infrastructure.

Live at **https://mv-package.heydon.io**.

## The package manifest (`mvpkg.json`)

A package declares its metadata in a JSON manifest at its root:

```json
{
  "name": "mvx-lang/curses",
  "version": "1.0",
  "description": "ncurses terminal handling for UniData",
  "license": "GPL-2.0-only",
  "systems": ["udt"],
  "dependencies": ["mvx-lang/cmd"]
}
```

`license` is an [SPDX identifier](https://spdx.org/licenses/) (e.g.
`GPL-2.0-only`, `MIT`, or `LicenseRef-Commercial` for a proprietary package).
The builder reads it and passes it through publish (`X-Pkg-License`); the
registry stores and displays it. A version whose artifacts include no `source`
is shown as **binary only** — the intended shape for commercial packages.

### The `deploy` block

`MVPKG install` **globally catalogs** every program in the package's `BP` (so
subroutines are callable from any account), then **deploys** it into the current
account. The `deploy` block declares what is account-specific — the client
infers nothing:

```json
{
  "name": "mvx-lang/git",
  "dependencies": ["mvx-lang/cmd"],
  "deploy": {
    "verbs": ["GIT"],
    "fallback": { "cmd": ["CMD.BP"] }
  }
}
```

- **`verbs`** — programs that get a per-account `VOC` verb pointer on deploy
  (so they're typeable at TCL). Everything else in `BP` is a subroutine, global
  and needs no per-account entry.
- **`files`** — account data files created on deploy: `[{ "name": …, "type":
  "dir" | "hashed" }]`. e.g. `mvpkg` declares its `mvpkg.installed` manifest
  file; `git` needs none (it makes its repo on demand).
- **`fallback`** — `{ "<dep>": ["<dir>", …] }`: catalog those extra `*.BP`
  source dirs **only if** the named dependency is not available. `git` bundles a
  copy of `cmd` in `CMD.BP` and lists `{"cmd": ["CMD.BP"]}`, so the bundle is
  cataloged only when `cmd` itself isn't — otherwise the real `cmd` owns
  `CMD.*`.

Install downloads once (recorded in a system-level manifest); rerun `MVPKG
install <name>` in another account and it detects the global install and just
deploys into that account.

## The registry (`server.js`)

A dependency-free Node.js **index** — it hosts nothing.  A package is added
from its source URL; a **provider** reads the package's `mvpkg.json`, tracks its
releases, and each release asset is recorded as an **external download URL**.
Packages live under `registry/<name>/meta.json` (source, provider, tracking,
and the external artifact URLs).

JSON API (the `MVPKG` client speaks this):

```
GET  /package/<name>   metadata; `tarball` resolved to the artifact URL best
                       matching ?system=&os=&arch=&endian=  (else the source)
GET  /search?q=<term>  {"packages":[{name,version,description}, ...]}
GET  /packages         the full index
```

Website + account:

```
GET  /                 home: search + package list
GET  /p/<name>         package page (install command, source, downloads)
GET  /account          your packages + add a package by source URL
POST /packages         add a package (source URL)   POST /packages/remove
POST /webhook/<id>     a provider release webhook (id = the package's tracking id)
```

## Adding a package

In your account, paste a **source URL** — a repository, or a link to an
`mvpkg.json`.  A source provider ([`lib/providers.js`](lib/providers.js))
handles it:

- **github** — reads `mvpkg.json` via the Contents API, tracks releases, and
  **auto-installs a release webhook** (needs a `GITHUB_TOKEN` with
  `admin:repo_hook`; otherwise it polls).
- **gitlab** — manifest + releases via the API (poll-based).
- **manifest** — any `mvpkg.json` URL (metadata only).

The registry reads the name + description/licence/dependencies from the
manifest, records the source, and indexes the current release.  On each new
release (webhook or poll) it refreshes the version and the external artifact
URLs.  It stores no bytes — downloads come from the source.

## Releases

A package repo publishes its own releases — e.g. a **GitHub release** whose
assets are named `<name-with-_>-<version>-<system>-<os>-<arch>-<endian>.tar.gz`
for a native binary (or `…-source.tar.gz`).  The registry indexes those assets
as external artifacts, and `GET /package/<name>?system=&os=&arch=&endian=`
returns the matching one — native binaries are os+arch-locked, compiled BASIC
objects + data files are endian-locked — falling back to source.

UniData packages that ship a native bridge compile it in the `builder/`
container inside their release workflow — see [`builder/README.md`](builder/README.md)
and, for worked examples, `mv_git`'s and `udt_curses`'s `release` workflows.

## Run / deploy

```sh
node server.js 8080                    # local dev
docker compose up -d --build           # container (persistent data volume + .env)
```

The live site runs the container on the hosting VM behind Traefik
(`mv-package.heydon.io`).  `.env`: optional `GITHUB_TOKEN` (webhook
auto-install + higher API limits), `MVPKG_ADMIN_USERS`,
`WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN`, and the Turnstile keys.

## Test

End-to-end across both repos (build the client, run the registry, install):

```sh
MVX_HOME=/path/to/mvx-lang MV_PACKAGE_DIR=/path/to/mv_package ./test/run.sh
```

## Roadmap

- **User registration & auth** — **done.** Register/sign-in, sessions, and
  **passkeys (WebAuthn)** at `/account` and `/login`; dependency-free (own
  CBOR/COSE parsing + `crypto` verification in [`lib/webauthn.js`](lib/webauthn.js)).
  Set `WEBAUTHN_RP_ID` + `WEBAUTHN_ORIGIN` in production; registration is
  guarded by **Cloudflare Turnstile** when `TURNSTILE_SITEKEY` +
  `TURNSTILE_SECRET` are set.
- **Source providers** — **done.** A package is added from its source URL; the
  provider reads the manifest, tracks releases (a signed webhook at
  `/webhook/<id>`, or polling), and indexes external artifacts.  GitHub is full
  (auto-installed webhook); GitLab and a generic manifest source are
  poll/metadata. Dependency-free ([`lib/providers.js`](lib/providers.js),
  [`lib/github.js`](lib/github.js)).
- **Index, not host** — **done.** The registry stores no bytes; every download
  links to the source's release asset.
- **More providers** — add push tracking for GitLab (project hooks) and other
  hosts behind the same provider interface.

## Layout

```
server.js            the registry service + website (an index; hosts nothing)
lib/providers.js     source providers (github / gitlab / manifest)
lib/github.js        GitHub API helpers (manifest, releases, webhooks)
lib/webauthn.js      passkey (WebAuthn) verification
Dockerfile           runnable registry image
docker-compose.yml   deploy (persistent data volume + .env)
registry/            the index (runtime data; not committed)
builder/             the UniData builder image (compile native bridges in CI)
test/run.sh          end-to-end install-loop test (client + registry)
```

## Licence

GPL-2.0-only. Copyright (C) 2026 Gordon Heydon.
