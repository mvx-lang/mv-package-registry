# CI: building UniData binary releases on a self-hosted runner

Native UniData binaries can only be built on a licensed UniData install, so
this repo drives the [`udt-builder`](../builder/README.md) container from a
**self-hosted RedHat/Rocky runner** — not a GitHub-hosted `ubuntu` runner.
The runner is a machine on your own infrastructure (the same kind of host you
capture the licence from); the licensed binaries never leave it.

## Pieces

| Path | What it is |
| --- | --- |
| [`actions/udt-build`](actions/udt-build/action.yml) | Private composite action: runs the `udt-builder` container to build + publish one package release (source tar + per-arch UniData binary tar). |
| [`workflows/udt-release.yml`](workflows/udt-release.yml) | Workflow that checks out a package and calls the action. `workflow_dispatch` (manual) **and** `workflow_call` (reusable by package repos). |

## One-time runner setup (RedHat/Rocky host)

1. Install Docker and the [GitHub Actions self-hosted runner](https://docs.github.com/actions/hosting-your-own-runners), registered against `mvx-lang/mv-package-registry` (or the org) with the label **`udt`** — so `runs-on: [self-hosted, linux, udt]` lands here.
2. Build the builder image once from your licensed install (see [`builder/README.md`](../builder/README.md)):
   ```sh
   cd builder
   ./capture-install.sh rocky@your-unidata-host     # writes ud83.tar.gz (git-ignored, licensed)
   docker build -t udt-builder:8.3.2 .
   ```
   The image tag defaults to `udt-builder:8.3.2`; override with the action's `image` input if you tag it differently.
3. Configure the registry endpoint + token:
   - **Variable** `MVPKG_REGISTRY` (Settings → Actions → Variables) — defaults to `https://mv-package.heydon.io` if unset.
   - **Secret** `MVPKG_PUBLISH_TOKEN` — the registry publish token (omit for an open registry).
   - **Secret** `PACKAGE_CHECKOUT_TOKEN` — only needed to build a package that lives in a **private** repo other than this one. The built-in `GITHUB_TOKEN` can check out this repo but not other private org repos, so set a PAT (or GitHub App token) with read access to the package repos. Public package repos need nothing.

> One runner builds for **one architecture** (`x86_64` on an Intel host,
> `aarch64` on ARM). To ship both, register a runner on each and run the
> release on both; the `source` tar is identical, the binary tars differ.

## Run it by hand

Actions → **udt release** → **Run workflow**, then supply:

- **package_repo** — the repo to build, e.g. `mvx-lang/udt_curses`
- **package_ref** — tag/branch (blank = default branch)
- **name** — the published name, e.g. `mv-lang/curses`
- **version** — the release to cut, e.g. `1.0`
- **deps / description** — optional fallbacks (the package's `mvpkg.json` wins)

## Reuse it from a package repo

A package repo can release itself on a tag by calling the reusable workflow —
no build logic in the package repo, and it runs on the same self-hosted runner:

```yaml
# .github/workflows/release.yml in e.g. mvx-lang/udt_curses
name: release
on:
  push:
    tags: ["v*"]
jobs:
  udt:
    uses: mvx-lang/mv-package-registry/.github/workflows/udt-release.yml@main
    with:
      package_repo: ${{ github.repository }}
      package_ref: ${{ github.ref_name }}
      name: mv-lang/curses
      version: ${{ github.ref_name }}   # e.g. the tag, sans a leading v if you prefer
    secrets:
      MVPKG_PUBLISH_TOKEN: ${{ secrets.MVPKG_PUBLISH_TOKEN }}
```

## What a run produces

`build-release.sh` inside the container emits two tars into `releases/` (also
uploaded as a workflow artifact) and publishes both to the registry against the
same version:

- `…-source.tar.gz` — the package as authored (portable; the client builds it).
- `…-<system>-<os>-<arch>-<endian>.tar.gz` — the binary. A package with a
  native (`udt-callc/*.c`) bridge is OS+arch-locked (its `.c` is precompiled to
  `.o`); a pure-BASIC/data package is endian-locked with `os`/`arch` = `any`.

The registry serves `source` by default and the matching binary when a client's
`MVPKG install` sends its `system`/`os`/`arch`/`endian`.
