# mv-package-registry

The backend for [mv_package](https://github.com/mvx-lang/mv_package) — the
registry **service + website** (the packagist/npm equivalent for
MultiValue), the tools that build and publish releases, and the UniData
builder image. Split out of the client repo so people installing the
`MVPKG` client don't download the server and build infrastructure.

Live at **https://mv-package.heydon.io**.

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

```sh
./mkrelease.sh /path/to/account <name> <version> "<description>" [deps]
./publish.sh https://mv-package.heydon.io <tar> <name> <version> "<desc>" [deps] [systems]
```

For UniData packages whose native bridge must compile, `builder/` is a
disposable UniData image that validates the build and produces a release tar
— see [`builder/README.md`](builder/README.md).

## Test

End-to-end across both repos (build the client, run the registry, install):

```sh
MVX_HOME=/path/to/mvx-lang MV_PACKAGE_DIR=/path/to/mv_package ./test/run.sh
```

## Roadmap

The registry is growing from a file-backed service into an application:

- **User registration & auth** — accounts and per-user publish tokens
  (replacing the single shared token), so package owners manage their own
  releases.
- **GitHub integration** — connect repositories and monitor them for new
  releases, so a published GitHub release can flow into the registry.
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
