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

   Pulls `$UDTHOME` (default `/usr/ud83`) plus any from-source libgit2 —
   the runtime `/usr/local/lib64/libgit2.so*` **and** its headers
   (`/usr/local/include/git2*`), so the image can *build* `udt-git` (mv_git's
   UniData binary) from source, not just run a prebuilt bridge.

2. **Build**:

   ```sh
   docker build -t udt-builder:8.3.2 .
   ```

   Rocky 8 base + the build/runtime deps (gcc, ncurses-devel, glib2, gdbm,
   pam, unixODBC, libnsl, `en_US.UTF-8`) + the captured install, with
   `/usr/ud83/bin` on the linker path and UniData's own start-up.

## Use it

A **package repo's release workflow** drives this image to compile its native
bridge and attach the result to a **GitHub release** (the registry then indexes
that asset — it hosts nothing).  The workflow just runs the container to build
the per-arch binary tar, e.g. (from `udt_curses`'s `release.yml`):

```sh
docker run --rm -v "$PWD":/src -w /src udt-builder:8.3.2 bash -lc '
  cp -a . /tmp/stage && rm -rf /tmp/stage/.git
  for c in /tmp/stage/udt-callc/*.c; do gcc -m64 -fPIC -O2 -c "$c" -o "${c%.c}.o"; rm -f "$c"; done
  tar czf /src/mv-lang_curses-<ver>-udt-linux-x86_64-le.tar.gz -C /tmp/stage .'
```

The asset is named `<name-with-_>-<version>-<system>-<os>-<arch>-<endian>.tar.gz`
so the registry maps it (native binaries are os+arch-locked).  See `mv_git`'s
and `udt_curses`'s `release` workflows for the full jobs (checkout → build in
this container → publish the GitHub release).

- **Architecture** is `$(uname -m)` — `x86_64` on an Intel builder,
  `aarch64` on an ARM builder. To ship an ARM binary, run the workflow on an
  ARM builder too; each release just adds another per-arch asset.

Or get an interactive UniData shell for development:

```sh
docker run --rm -it --hostname unidata --shm-size=512m udt-builder:8.3.2 bash
# then: cd /work && mkdir acct && cd acct
#       printf 'y\nroot\nunidata\n' | $UDTHOME/bin/newacct
#       udt
```

## Run it as a UniData server (UniObjects — for demos)

The image is built for *compiling* (it runs `udt` locally), so it ships without
the UniObjects/UniRPC server layer — fine for builds, but a client like
`udt-git` connects over UniObjects and needs a server. `setup-udt-server.sh`
adds that layer (the UniRPC service map, a PAM login service, a login user, the
libgit2 ownership guard) and starts `unirpcd`. Run the container with `--init`
so the daemon's children are reaped:

```sh
docker run -d --init --hostname unidata --shm-size=512m --name udt udt-builder:8.3.2 sleep infinity
docker cp setup-udt-server.sh udt:/root/
docker exec -e UDT_LOGIN_PASSWORD=secret udt sh /root/setup-udt-server.sh
# then, from inside (or any UniObjects client):
#   UDT_HOST=127.0.0.1 UDT_SERVICE=udcs UDT_USER=root UDT_PASSWORD=secret \
#     udt-git -a /usr/ud83/demo init
```

See `mv_git`'s `docs/udt-demo.md` for a full download → install → init/add/commit
transcript against the bundled `demo` account.

## Notes

- **`--hostname unidata`** matches the captured install's hostname — belt and
  braces against any host binding in the licence.
- **`--shm-size=512m`** gives SMM room; UniData uses SysV shared memory.
- **Unirpcd** does not start by default (no Unishared) — fine for a *builder*,
  which drives `udt` directly. To accept *network* clients (UniObjects/ODBC),
  configure it with `setup-udt-server.sh` above.

## Files

```
Dockerfile          Rocky 8 + deps + the captured UniData install
capture-install.sh  pull a licensed install into ud83.tar.gz (git-ignored)
entrypoint.sh       start UniData, then exec the requested command
setup-runner.sh     register a self-hosted GitHub Actions runner (org-level)
setup-udt-server.sh configure the container as a UniObjects server (for demos)
```
