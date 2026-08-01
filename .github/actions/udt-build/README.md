# udt-build

Build one package's **UniData binary** release tar in the licensed
`udt-builder` container and attach it to the GitHub release.

Native UniData binaries can only be built on a licensed install, so this runs on
a **self-hosted** RedHat/Rocky runner (label `udt`) that has Docker and the
`udt-builder` image — never on a GitHub-hosted runner. The action carries its
own `build-release.sh`, so a caller in another repo only needs to check itself
out.

## Contract

The package repo provides a **`build-udt.sh`** at its root that — run inside the
container at the repo root — stages its release tree (contents at the root, no
wrapping dir) into the directory passed as `$1`. The action wraps that with the
parts every package shares: the image check, the artifact key, running the
container, and the tar + checksum. It writes and attaches

```
<base>-<version>-udt-<os>-<arch>-<endian>.tar.gz   (+ .sha256)
```

where `base` is the package name with `/` → `_` — the key the registry's release
webhook maps.

## Usage

```yaml
jobs:
  udt-binary:
    runs-on: [self-hosted, linux, udt]
    steps:
      - uses: actions/checkout@v5
      - uses: mvx-lang/mv-package-registry/.github/actions/udt-build@main
        with:
          package: mvx-lang/git
```

## Inputs

| input | required | description |
|-------|----------|-------------|
| `package` | yes | Package name, e.g. `mvx-lang/git`; the artifact base is this with `/` → `_`. |
| `image` | no | The udt-builder image on the runner (default `udt-builder:8.3.2`; override with `UDT_BUILDER_IMAGE`). |
| `repository` | no | Repo whose release to attach to (default this repo) — for cross-repo dispatch. |
| `token` | no | Token for the release upload (default `github.token`). |

## Output

- `tarball` — the binary tarball filename.

One runner builds one architecture; register one per arch (`x86_64`, `aarch64`)
to ship both — each release just gains another per-arch asset. See
[`../../builder/README.md`](../../builder/README.md) for the runner + image
setup, and [`../README.md`](../README.md) for the CI overview.
