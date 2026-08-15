# UniVerse builder

A disposable, reproducible UniVerse 14.2.1 environment for building and
releasing the MultiValue packages — the UniVerse counterpart of `builder/`
(UniData).

**It is self-contained.** Unlike the UniData builder, which is built from a
capture of a live install, this image installs UniVerse *from its own media*
during the image build. The builder therefore depends on no other machine: no
VM to capture from, nothing to keep in sync.

## Provisioning a runner (once)

The image build needs the licensed install media. It is **never committed** —
put it on the runner at the path the action expects:

```sh
sudo mkdir -p /opt/uv-builder
sudo cp UVTE_LINUXX86_14.2.1.zip /opt/uv-builder/
```

Override with the action's `media` input or `$UV_MEDIA_ZIP` if it lives
elsewhere. That is the whole provisioning step; `setup-uv` builds the image from
this directory on every run, so a Dockerfile change is picked up automatically
and Docker's layer cache keeps an unchanged run cheap.

Label the runner `uv` so package workflows can select it:
`runs-on: [self-hosted, linux, uv]`.

## Using it

```yaml
- uses: actions/checkout@v5
- uses: mvx-lang/mv-package-registry/.github/actions/setup-uv@main
- run: uv-run 'BASIC BP MYPROG'
```

or, to build and publish a package's UniVerse artifact, the whole job is:

```yaml
- uses: actions/checkout@v5
- uses: mvx-lang/mv-package-registry/.github/actions/uv-build@main
  with:
    package: mvx-lang/git
```

The package supplies `build-uv.sh`, which — run inside the container at the repo
root — stages its release tree into `$1`.

## Notes from the install

Three things the media does not tell you, each of which stops the build dead:

- **A `uvdb` user must exist first.** UV 12.1 and later require it; without one
  `uv.load` suspends waiting for it to be created, forever if there is no
  terminal. The Dockerfile creates it before installing.
- **`diffutils` is required.** The installer verifies its component checksums by
  shelling out to `diff`; a minimal image has no `diff` and every group "fails"
  its checksum.
- **Unpack on Linux.** The media components (`MAIN`, `STARTUP`, …) collide on a
  case-insensitive filesystem — extracting on macOS loses files.

With those in place, `./uv.load < /dev/null` takes every default and installs to
`/usr/uv`; the Trial Edition bypasses licensing.

A new account needs two answers before it is usable: `Y` to update the VOC's
`RELLEVEL`, then a VOC flavour. The packages target classic Pick, so **3 (PICK
compatibility)** is the flavour to choose.

Creating the BASIC source file is where UniVerse differs most from UniData, and
it caught us out: `mkdir BP` is not enough — the directory needs a VOC pointer,
and a shipped account's looks like

```
0001 F
0002 BP
0003 D_BP
```

i.e. type `F`, data = the directory, dict = `D_BP`. `CREATE.FILE BP` makes both,
but it prompts for the **DICTionary** file first and then the data file — modulo,
separation and file type for each — so a script has to feed six answers, with
**type 19** (directory) for the data part. Positional forms like
`CREATE.FILE BP 19` or `CREATE.FILE BP TYPE 19` do *not* select the type; they
either prompt anyway or quietly create a hashed file.
