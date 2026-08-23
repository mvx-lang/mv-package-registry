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
but it prompts — and the prompt count is the trap. It asks for the **DICTionary**
file first and then the **DATA** file (modulo, separation and file type for
each), and then a **seventh** question: a file description.

```
Please enter the following information for the DICTionary file:
Modulo = 1   Separation = 2   File type = 3
Please enter the following information for the DATA file:
Modulo = 1   Separation = 2   File type = 19
File description =            <- the seventh, and it must be left EMPTY
```

so the script feeds `1 2 3 1 2 19` and then a **blank line**:

```sh
printf 'CREATE.FILE %s\n1\n2\n3\n1\n2\n19\n\nQUIT\n' "$name" | uv
```

**Leave the description empty.** UniVerse stores it in VOC attribute 1 as
`F <description>`, and code that reads attribute 1 as the type — an account scan
matching `F` or `DIR` — then cannot see the file at all. It is staged nowhere,
with no error. An earlier version of this README fed a filler word as the
seventh answer, which is exactly how that bug reached mv_git (see mv_git#43);
feeding `QUIT` instead is no better, as it is consumed as the description too and
the session then runs on.

Positional forms like `CREATE.FILE BP 19` or `CREATE.FILE BP TYPE 19` do *not*
select the type; they either prompt anyway or create nothing.
`CREATE.FILE <name> <mod>,<sep> <mod>,<sep>` is fully non-interactive and gives a
clean `F`, but produces a **hashed** file — no good for `BP`, which must be a
directory to hold source items.
