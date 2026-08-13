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
    && dnf clean all

# match the source install's group ownership
RUN groupadd -g 1001 unidata || true

# the captured UniData install (/usr/ud83); libgit2 comes from EPEL above
COPY ud83.tar.gz /tmp/ud83.tar.gz
RUN tar xzf /tmp/ud83.tar.gz -C / \
    && rm -f /tmp/ud83.tar.gz \
    && printf '/lib64\n/usr/lib64\n/usr/ud83/bin\n' > /etc/ld.so.conf.d/UniData.conf \
    && ldconfig

# The captured /usr/ud83/bin/libu2callc.so was linked on the capture host against
# a COMPILED libgit2.so.1.9; this image ships EPEL's DISTRIBUTED libgit2.so.1.7.
# A pure-BASIC package build never rebuilds libu2callc.so, so newacct (which loads
# it at start) would die on the missing 1.9 soname.  Point 1.9 at the distributed
# 1.7 so it loads — the git CallC functions are never CALLED during a pure-BASIC
# build, and a native package relinks libu2callc.so against 1.7 (LIBGIT2_LIBS)
# before calling them.  Uses the distributed 1.7, not a compiled 1.9.
RUN L="$(ldconfig -p | awk -F'=> ' '/libgit2\.so\.1\.7/{print $2; exit}')" \
    && [ -n "$L" ] && ln -sf "$L" /usr/lib64/libgit2.so.1.9 && ldconfig \
    && echo "aliased libgit2.so.1.9 -> $L (distributed EPEL 1.7)"

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
