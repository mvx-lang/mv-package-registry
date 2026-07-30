# UniData builder image

A disposable, reproducible UniData environment for building and releasing the
MultiValue packages (curses, git, …) — so you can compile CallC bridges,
catalog BASIC, and produce release tars without hand-maintaining a UniData
host.

It runs `udt` locally against the shared-memory manager (no network daemon
needed), compiles BASIC, and runs the native build toolchain
(gcc + `gencdef`/`genefs`/`genfunc` + the UniData headers and `libuvic.a`).

> **Licensing.** The image contains Rocket UniData binaries, which are
> licensed. `ud83.tar.gz` (the captured install) is git-ignored and must not
> be committed or shared. This is for **private, internal build use of your
> own licensed UniData install** — the binaries stay on your infrastructure.

## Build the image

1. **Capture** your licensed install (once) into the build context:

   ```sh
   ./capture-install.sh rocky@your-unidata-host        # writes ud83.tar.gz
   ```

   Pulls `$UDTHOME` (default `/usr/ud83`) plus any from-source
   `/usr/local/lib64/libgit2` (needed by the git bridge).

2. **Build**:

   ```sh
   docker build -t udt-builder:8.3.2 .
   ```

   Rocky 8 base + the build/runtime deps (gcc, ncurses-devel, glib2, gdbm,
   pam, unixODBC, libnsl, `en_US.UTF-8`) + the captured install, with
   `/usr/ud83/bin` on the linker path and UniData's own start-up.

## Use it

Run a package's release build — validate its native bridge compiles in a
clean library, then emit the release tar:

```sh
docker run --rm --hostname unidata --shm-size=512m \
  -v "$PWD/build-release.sh:/build-release.sh" \
  -v /path/to/udt_curses:/pkg \
  -v /path/to/mv-package-registry:/registry \
  -v "$PWD/releases:/out" \
  udt-builder:8.3.2 bash /build-release.sh curses 1.0
```

produces `releases/curses-1.0.tar.gz` + `meta.json`. Drop the tar + meta into
a registry (`server/`) and `MVPKG install curses` picks it up.

Or get an interactive UniData shell for development:

```sh
docker run --rm -it --hostname unidata --shm-size=512m udt-builder:8.3.2 bash
# then: cd /work && mkdir acct && cd acct
#       printf 'y\nroot\nunidata\n' | $UDTHOME/bin/newacct
#       udt
```

## Notes

- **`--hostname unidata`** matches the captured install's hostname — belt and
  braces against any host binding in the licence.
- **`--shm-size=512m`** gives SMM room; UniData uses SysV shared memory.
- **Unirpcd** fails to start (no Unishared) and that is fine — it is only for
  *network* clients (UniObjects/ODBC over the wire); a local builder drives
  `udt` directly.

## Files

```
Dockerfile          Rocky 8 + deps + the captured UniData install
capture-install.sh  pull a licensed install into ud83.tar.gz (git-ignored)
entrypoint.sh       start UniData, then exec the requested command
build-release.sh    validate a package's native build, then produce its release
```
