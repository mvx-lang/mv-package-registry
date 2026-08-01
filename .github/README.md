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
| **udt-build** | [`actions/udt-build`](actions/udt-build) | build a UniData binary in the `udt-builder` container + attach `…-udt-…​.tar.gz` (self-hosted `udt` runner). |
| **udt-release** | [`workflows/udt-release.yml`](workflows/udt-release.yml) | reusable workflow wrapping udt-build (checkout + build + publish). |

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

## Registry config for publishers

- **`MVPKG_REGISTRY`** — the registry base URL a client/CI points at (default
  `https://mv-package.heydon.io`); must be `https`.
- **`MVPKG_PUBLISH_TOKEN`** / a per-user **`X-Auth-Token`** — publish a package to
  the registry index headlessly (`POST /packages`); see the registry README.
