# UniVerse 14.2.1 builder — SELF-CONTAINED: UniVerse is installed from its own
# media during the image build, so the builder depends on no other machine (no
# capture from a live VM).  Private internal use only; the UniVerse binaries are
# licensed and are never redistributed — the media sits on the runner, not in git.
FROM rockylinux:8

# UniVerse build + runtime dependencies, plus what uv.load itself needs (cpio to
# unpack the media components, tcsh/bc which the install scripts call).
RUN dnf -y install epel-release \
    && dnf -y install \
        gcc gcc-c++ make tar gzip unzip which hostname procps-ng findutils cpio \
        glibc libnsl libxcrypt ncurses-compat-libs gdbm-libs pam unixODBC \
        tcsh bc glibc-langpack-en curl sudo diffutils \
    && dnf clean all

# UV 12.1 and later require a uvdb user to exist BEFORE the install — without it
# uv.load suspends waiting for one to be created.
RUN groupadd -r uvdb 2>/dev/null || true; \
    useradd -r -g uvdb -s /sbin/nologin uvdb 2>/dev/null || true

# Install UniVerse from the media.  The components are cpio archives; STARTUP
# carries the installer (uv.load), which with no input takes every default and
# installs to /usr/uv.  The Trial Edition bypasses licensing.
COPY UVTE_LINUXX86_14.2.1.zip /tmp/uv-media.zip
RUN set -eu; \
    mkdir -p /tmp/uvmedia && cd /tmp/uvmedia; \
    unzip -q /tmp/uv-media.zip; \
    cpio -idm --quiet < STARTUP; \
    chmod +x uv.load; \
    ./uv.load < /dev/null > /tmp/uvinstall.log 2>&1 || { tail -40 /tmp/uvinstall.log; exit 1; }; \
    grep -q "installation completed" /tmp/uvinstall.log || { tail -40 /tmp/uvinstall.log; exit 1; }; \
    cd / && rm -rf /tmp/uvmedia /tmp/uv-media.zip; \
    printf "/usr/uv/bin\n" > /etc/ld.so.conf.d/UniVerse.conf; \
    ldconfig; \
    ls /usr/uv/bin/uv >/dev/null

ENV UVHOME=/usr/uv \
    UVBIN=/usr/uv/bin \
    PATH=/usr/uv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    TERM=vt100 \
    LANG=en_US.UTF-8

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
