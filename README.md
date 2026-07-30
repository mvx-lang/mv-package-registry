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
  "name": "mv-lang/curses",
  "version": "1.0",
  "description": "ncurses terminal handling for UniData",
  "license": "GPL-2.0-only",
  "systems": ["udt"],
  "dependencies": ["mv-lang/cmd"]
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
  "name": "mv-lang/git",
  "dependencies": ["mv-lang/cmd"],
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

A dependency-free Node.js registry and website. Packages live under
`registry/<name>/` as a `meta.json` beside the release tar it points at.

JSON API (the `MVPKG` client speaks this):

```
GET  /package/<name>   that package's metadata
GET  /search?q=<term>  {"packages":[{name,version,description}, ...]}
GET  /tarball/<n>/<f>  the release tar bytes
```

Website:

```
GET  /                 home: search + package list
GET  /p/<name>         package page (install command, dependencies, download)
```

Publish (token-gated when `MVPKG_PUBLISH_TOKEN` is set; metadata as `X-Pkg-*`
headers, body = the tar):

```
POST /publish
```

## Run / deploy

```sh
node server.js 8080                                   # local dev
```

or the container (persistent `registry/` data volume, publish token in
`.env`):

```sh
docker compose up -d --build
```

The live site runs this container on the hosting VM, fronted by an external
Traefik that terminates TLS for `mv-package.heydon.io`.

## Build + publish a release

A release can carry more than one artifact for the same version: a portable
**source** tar plus one **binary** tar per `system`/`os`/`arch` (native code
precompiled, so the client installs it without a compiler). The
`X-Pkg-Artifact` header tags each upload — `source` (default) or
`binary:<system>:<os>:<arch>:<endian>`:

```sh
./mkrelease.sh /path/to/account <name> <version> "<description>" [deps]
./publish.sh https://mv-package.heydon.io <tar> <name> <version> "<desc>" [deps] [systems] [artifact]
```

`GET /package/<name>` returns the source tar by default and the matching
binary when the client sends `?system=&os=&arch=&endian=` (the `MVPKG` client
does this automatically from its `MVPKGOS "PLATFORM"` op). Native binaries are
locked to os+arch; compiled BASIC objects + data files, to endianness. The
website package page lists every artifact.

**External / binary-only sources.** Instead of uploading a tar, pass an
`http(s)://` URL as `<tar>` and the registry just **indexes** that external
location (a vendor's server, a GitHub release asset) — no bytes uploaded. This
is how a **binary-only, commercial** package is served: the registry holds its
name, licence, and download URL; the client fetches from wherever the artifact
points. A version with no `source` artifact is shown as **binary only**.

For UniData packages whose native bridge must compile, `builder/` is a
disposable UniData image that builds **both** artifacts (source + a binary
for the builder's `system`/`$(uname -m)`) and publishes them — see
[`builder/README.md`](builder/README.md).

## Test

End-to-end across both repos (build the client, run the registry, install):

```sh
MVX_HOME=/path/to/mvx-lang MV_PACKAGE_DIR=/path/to/mv_package ./test/run.sh
```

## Roadmap

The registry is growing from a file-backed service into an application:

- **User registration & auth** — **done.** Register/sign-in, sessions, and
  per-user publish tokens (managed at `/account`). A package is owned by its
  first publisher; only the owner (or an admin — `MVPKG_ADMIN_USERS`, or the
  `MVPKG_PUBLISH_TOKEN`) may publish new versions. **Passkeys (WebAuthn)** —
  **done**, add/sign-in from `/account` and `/login`; dependency-free (own
  CBOR/COSE parsing + `crypto` verification in [`lib/webauthn.js`](lib/webauthn.js)).
  Set `WEBAUTHN_RP_ID` + `WEBAUTHN_ORIGIN` in production. Registration is
  guarded by **Cloudflare Turnstile** (CAPTCHA) when `TURNSTILE_SITEKEY` +
  `TURNSTILE_SECRET` are set (off otherwise).
- **GitHub integration** — **done.** Connect a repo to your account
  (`/account`), optionally naming a target package. The registry monitors it
  two ways: a **webhook** (`/webhook/github/<id>`, HMAC-verified with a
  per-connection secret) for instant release events, and **polling** the
  GitHub API (`GITHUB_TOKEN` for private/rate-limits) as a fallback. The
  latest release shows on the account page. Dependency-free
  ([`lib/github.js`](lib/github.js)).
- **Multi-artifact releases** — **done.** A release version carries a source
  tar plus a binary tar per `system`/`arch`; `builder/build-release.sh` builds
  and publishes both, and the `MVPKG` client fetches the binary matching its
  platform (falling back to source). See "Build + publish a release" above.
- **Release deployment** — let `mv_package` deploy selected releases: choose
  which monitored releases become registry packages (built via `builder/`
  where native code is involved) and publish them.

## Layout

```
server.js            the registry service + website
Dockerfile           runnable registry image
docker-compose.yml   deploy (persistent registry/ volume, publish token)
mkrelease.sh         build a release tar from an account
publish.sh           push a release to a running registry
registry/            published packages (runtime data; not committed)
builder/             the UniData builder image (build/validate releases)
test/run.sh          end-to-end install-loop test (client + registry)
```

## Licence

GPL-2.0-only. Copyright (C) 2026 Gordon Heydon.
