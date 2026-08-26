# UniData 8.3.2 builder — captured from the licensed install on VM 108.
# A disposable, reproducible environment for building/releasing the UniData
# MultiValue packages (curses, git, ...).  Private internal use only; the
# UniData binaries are not redistributed.
FROM rockylinux:8

# UniData build + runtime dependencies (compile CallC bridges, run udt), plus
# EPEL's libgit2_1.7-devel — the git package links libgit2.so.1.7 so end users
# install the runtime with a plain `dnf install libgit2_1.7` (see LIBGIT2_LIBS
# below); base-OS libgit2 is 0.26, too old.
RUN dnf -y install epel-release \
    && dnf -y install \
        gcc gcc-c++ make tar gzip which hostname procps-ng findutils \
        glibc glib2 ncurses ncurses-devel gdbm gdbm-libs pam libxcrypt \
        unixODBC libnsl \
        glibc-langpack-en \
        libgit2_1.7-devel \
        libcurl-devel \
        curl sudo \
        git \
    && dnf clean all

# match the source install's group ownership
RUN groupadd -g 1001 unidata || true

# the captured UniData install (/usr/ud83); libgit2 comes from EPEL above
COPY ud83.tar.gz /tmp/ud83.tar.gz
RUN tar xzf /tmp/ud83.tar.gz -C / \
    && rm -f /tmp/ud83.tar.gz \
    && printf '/lib64\n/usr/lib64\n/usr/ud83/bin\n' > /etc/ld.so.conf.d/UniData.conf \
    && ldconfig

# THE CAPTURED libu2callc.so NEEDS libgit2.so.1.9 AND THIS IMAGE SHIPS 1.7.
# newacct loads libu2callc.so at start, so with no 1.9 to resolve it dies:
#   newacct: error while loading shared libraries: libgit2.so.1.9
# and the mvpkg layer below cannot provision its operator account.
#
# So 1.9 is pointed at the distributed 1.7 FOR THE BUILD ONLY.  That is an ABI
# lie -- a soname exists precisely to stop 1.7 being called with 1.9
# expectations -- tolerable here only because nothing calls a git CallC
# function during provisioning, and because IT DOES NOT SHIP: the final layer
# removes it, once mvpkg's install has relinked libu2callc.so against the 1.7
# this image actually has.
#
# (An earlier change deleted this outright, on the evidence that the live
# libu2callc.so has no libgit2 in its DT_NEEDED.  That reading came from the
# FINISHED image, where the library has already been relinked -- during a build
# it is still the captured one, and the build died here.)
#
# The durable fix is to stop capturing a libu2callc.so linked against a libgit2
# the image does not ship -- see capture-install.sh.
RUN L="$(ldconfig -p | awk -F'=> ' '/libgit2\.so\.1\.7/{print $2; exit}')" \
    && [ -n "$L" ] && ln -sf "$L" /usr/lib64/libgit2.so.1.9 && ldconfig \
    && echo "build-only alias libgit2.so.1.9 -> $L (removed in the final layer)"

# UniData network daemon port
RUN printf 'udt_os\t1382/tcp\nudt_os\t1382/udp\n' >> /etc/services

# LIBGIT2_LIBS makes build-udt.sh link the EPEL libgit2_1.7 by its exact soname
# (it ships no unversioned libgit2.so or pkgconfig; headers are the standard
# /usr/include).  The binary then needs only libgit2.so.1.7 at the user's site,
# which they get from `dnf install libgit2_1.7`.
ENV UDTHOME=/usr/ud83 \
    UDTBIN=/usr/ud83/bin \
    PATH=/usr/ud83/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LD_LIBRARY_PATH=/usr/ud83/bin \
    TERM=xterm \
    LANG=en_US.UTF-8 \
    LIBGIT2_LIBS=-l:libgit2.so.1.7

# MVPKG — the MV package manager, installed so a package BUILD can provision the
# shared platform header.  A cross-platform package compiles against
# `$INCLUDE MVPKG.INC PLATFORM.H` (the $DEFINE MV / $DEFINE UDT vendor defines),
# and that include is provisioned per account by `MVPKG init` — so mvpkg has to be
# here for such a package to compile at all.  Its build-udt.sh runs
# `MVPKG init -y` in the scratch account it creates.
#
# Installed at IMAGE build (once) rather than per build: udt-run starts a fresh
# `docker run --rm` container for every invocation, so a runtime install would be
# thrown away.  install.sh needs UniData up, which docker build does not start —
# hence the explicit startud.  UDT_OWNER=root: the unpacked tar carries the
# publisher's uid, which is not a user here.  MVPKG is additionally cataloged
# GLOBALLY (install.sh keeps it local to its operator account) so any scratch
# account can run `MVPKG init`; safe in a disposable build container, and it
# also shadows any stale MVPKG carried in the captured catalog.
ARG MVPKG_VERSION=1.15.0
RUN set -eu; \
    cd /tmp; \
    curl -fsSL -o mvpkg.tar.gz \
      "https://github.com/mvx-lang/mv_package/releases/download/${MVPKG_VERSION}/mvx-lang_mvpkg-${MVPKG_VERSION}-udt-any-any-le.tar.gz"; \
    tar xzf mvpkg.tar.gz -C /opt; \
    rm -f mvpkg.tar.gz; \
    chown -R root:root /opt/mvpkg; \
    yes | "$UDTBIN/startud" >/tmp/startud.log 2>&1 || true; \
    cd /opt/mvpkg && UDT_OWNER=root UDT_GROUP=unidata ./install.sh; \
    printf 'CATALOG BP MVPKG FORCE\nQUIT\n' | udt >/dev/null 2>&1; \
    ls "$UDTHOME/sys/CTLG/m/MVPKG" >/dev/null

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]

# ---- final layer: undo the build-only alias, drop stale package state ------
#
# THE 1.9 ALIAS DOES NOT SHIP.  It exists only so the CAPTURED libu2callc.so
# loads during provisioning above.  By now mvpkg's install has relinked that
# library against the 1.7 this image really has, so nothing needs 1.9 and the
# finished image must not claim a libgit2 it does not have.  The final test
# asserts the claim is gone rather than trusting the rm.
#
# NO PRE-INSTALLED PACKAGE CallC FRAGMENTS either.  The capture carried
# /usr/ud83/callc.d/git -- prebuilt gitcallcb.o / mvxgit.o / udtgit_rt.o from
# the capture host, under mv_git's PRE-RENAME package name.  mv_git installs as
# `mvx-lang_git`, so both stage the same object names and udt-callc keeps
# `git`: libu2callc.so, which the in-session GIT verb calls through, was
# assembled from the CAPTURED objects rather than the ones just built.  Every
# suite run in this image tested a month-old engine while the install reported
# success (mv_git#163).  callc.d is per-site package state, not part of the
# licensed install; anything needing a fragment reinstalls it.
RUN rm -f /usr/lib64/libgit2.so.1.9 \
    && rm -rf /usr/ud83/callc.d/git \
    && ldconfig \
    && ! ldconfig -p | grep -q 'libgit2\.so\.1\.9' \
    && echo "final: no 1.9 alias, no stale callc fragment"
