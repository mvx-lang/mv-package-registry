# Release CI

How MV packages publish releases the registry can index. The registry **hosts
nothing** — a release is GitHub release assets; the registry indexes them (via
each package's webhook) and resolves the best one per system/arch.

A release is multiple **artifacts** with a shared naming key:

```
<base>-<version>-<suffix>.tar.gz          base = package name with '/' -> '_'
  suffix = source                         portable source (compiled at install)
         = <system>-<os>-<arch>-<endian>  a prebuilt binary (os/arch-locked)
```

## Reusable building blocks

| | where | what |
|---|---|---|
| **publish-source** | `mvx-lang/mvx/.github/actions/publish-source` | tar the source + attach `…-source.tar.gz` (any GitHub-hosted runner). |
| **setup-udt** | [`actions/setup-udt`](actions/setup-udt) | verify the licensed `udt-builder` image + put a `udt-run` wrapper on PATH (self-hosted `udt` runner). |
| **udt-build** | [`actions/udt-build`](actions/udt-build) | build a UniData binary via setup-udt + `build-udt.sh` and attach `…-udt-…​.tar.gz`. |
| **udt-release** | [`workflows/udt-release.yml`](workflows/udt-release.yml) | reusable workflow wrapping udt-build (checkout + build + publish). |

`setup-udt` is the UniData analogue of `setup-mvx` / the dconsole action — but
because UniData is **licensed and cannot be distributed**, it installs nothing;
it verifies the image already on the self-hosted runner and exposes it through
`udt-run`. So any step can use the licensed toolchain:

```yaml
- uses: mvx-lang/mv-package-registry/.github/actions/setup-udt@main
- run: udt-run 'BASIC BP MYPROG'      # runs inside the licensed container
```

The **mvx** binary (Linux) builds on a GitHub-hosted runner via
`mvx-lang/mvx/.github/actions/setup-mvx`; it needs no self-hosted host.

## A package's release workflow

Tag a bare version (`git tag 1.4 && git push origin 1.4`) to fire it. A typical
`release.yml`:

```yaml
on: { push: { tags: ['[0-9]+.[0-9]+*'] } }
permissions: { contents: write }
jobs:
  source:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: mvx-lang/mvx/.github/actions/publish-source@main
        with: { package: mvx-lang/git, title: git, body: "…", extra-exclude: docs }

  udt-binary:
    runs-on: [self-hosted, linux, udt]
    steps:
      - uses: actions/checkout@v5
      - uses: mvx-lang/mv-package-registry/.github/actions/udt-build@main
        with: { package: mvx-lang/git }
```

The package must ship a **`build-udt.sh`** that, run inside the container at the
repo root, stages its release tree (contents at the root) into `$1` — its native
build (compile `udt-callc/*.c` → `.o`, drop the source, add the manifest and any
verbs). `udt-build` supplies everything else (image check, artifact key, tar,
publish).

## The self-hosted `udt` runner (once per build host)

UniData binaries need a licensed install, so they build in the `udt-builder`
container on a self-hosted RedHat/Rocky host — the licensed binaries stay on your
infrastructure and never touch CI.

1. **Build the image** from a captured licence — see
   [`../builder/README.md`](../builder/README.md) (`capture-install.sh` →
   `docker build -t udt-builder:8.3.2 .`). The runner host needs Docker and the
   runner user in the `docker` group.
2. **Register the runner** (org-level, label `udt`):

   ```sh
   TOKEN=$(gh api -X POST orgs/mvx-lang/actions/runners/registration-token --jq .token)
   sh builder/setup-runner.sh "$TOKEN"          # labels default to udt,linux
   ```

   `runs-on: [self-hosted, linux, udt]` then lands here. One runner builds one
   architecture; register one per arch (`x86_64`, `aarch64`) to ship both.

## Manual (cross-repo) builds

Rebuild a package's UniData binary by hand from this repo's **Actions →
udt-release → Run workflow**, giving the package name, its repo, and the tag.
That path is cross-repo, so set a **`PACKAGE_TOKEN`** secret (a token that can
read the package repo and write its release); the tag-triggered `workflow_call`
path above just uses the caller's `GITHUB_TOKEN`.

## Central builds (registry-dispatched)

A package need not run the `udt` build in its own CI. If its **source-only**
release carries native code (`udt-callc/*.c`) and ships no binary asset, the
registry can build one for it centrally — so a package author just tags a plain
source release on public GitHub and users still get a prebuilt binary.

The registry stays index-only — it doesn't run Docker. On the release webhook,
if the connection **opted in** (the account page's *Build binary* toggle, or the
*Build the UniData binary* checkbox on connect) and the source is native with no
binary, it fires [`workflows/build-dispatch.yml`](workflows/build-dispatch.yml)
via `workflow_dispatch` (inputs: `package`, `repository`, `ref`). That workflow
runs on the self-hosted `udt` runner, builds the binary with `udt-build` at that
tag, and uploads it to the release. Attaching the asset edits the release, whose
`edited` webhook re-indexes the package — the binary is now installable, no
polling. A `pkg.builds[version]` record dedupes repeat webhooks.

Setup on this repo:

- **`PACKAGE_TOKEN`** secret — reused for the cross-repo checkout + upload (as
  above).
- The registry's **`GITHUB_TOKEN`** needs *Actions: read and write* on this repo
  to fire the dispatch (the same token that installs release webhooks).
- Optional server env: `BUILD_DISPATCH_REPO` (default `mvx-lang/mv-package-registry`),
  `BUILD_DISPATCH_WORKFLOW` (default `build-dispatch.yml`), `BUILD_DISPATCH_REF`
  (default `main`).

Run it by hand too from **Actions → build-dispatch → Run workflow** to backfill
a binary for any tag.

## Registry config for publishers

- **`MVPKG_REGISTRY`** — the registry base URL a client/CI points at (default
  `https://mv-package.heydon.io`); must be `https`.
- **`MVPKG_PUBLISH_TOKEN`** / a per-user **`X-Auth-Token`** — publish a package to
  the registry index headlessly (`POST /packages`); see the registry README.
