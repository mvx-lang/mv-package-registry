# setup-udt

Make the **licensed UniData toolchain** available to a workflow — the UniData
analogue of `setup-mvx` or the [dconsole](https://github.com/dconsole/dconsole)
action, which install a *distributable* CLI onto a hosted runner.

UniData **cannot be distributed**, so nothing is downloaded. Instead the tool
lives on a **self-hosted** runner (as the `udt-builder` image, built once from
your captured licence — see [`../../builder/README.md`](../../builder/README.md)).
This action verifies that image is present and puts a **`udt-run`** wrapper on
`$PATH`, so any later step runs a command inside the licensed container.

## Usage

```yaml
jobs:
  build:
    runs-on: [self-hosted, linux, udt]
    steps:
      - uses: actions/checkout@v5
      - uses: mvx-lang/mv-package-registry/.github/actions/setup-udt@main
      - run: udt-run 'BASIC BP MYPROG'          # any udt command…
      - run: udt-run sh build-udt.sh /pkg/dist   # …or a build script
```

`udt-run <command…>` runs its arguments as a shell command line inside the
container, with the current directory mounted at **`/pkg`** (the working dir)
and `$GITHUB_REF_NAME` forwarded. The container runs as root, so files it
creates are chowned back to the runner user on exit (a stray root-owned file
would block the runner's next checkout).

## Inputs

| input | required | description |
|-------|----------|-------------|
| `image` | no | The udt-builder image on the runner (default `udt-builder:8.3.2`). Also pinned into `UDT_BUILDER_IMAGE` for the rest of the job. |

## Output

- `image` — the udt-builder image in effect.

Building a package release? [`udt-build`](../udt-build) layers on top of this:
it calls `setup-udt`, then drives the package's `build-udt.sh` and publishes the
per-arch binary tar.
