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
    && dnf clean all

# match the source install's group ownership
RUN groupadd -g 1001 unidata || true

# the captured UniData install (/usr/ud83); libgit2 comes from EPEL above
COPY ud83.tar.gz /tmp/ud83.tar.gz
RUN tar xzf /tmp/ud83.tar.gz -C / \
    && rm -f /tmp/ud83.tar.gz \
    && printf '/lib64\n/usr/lib64\n/usr/ud83/bin\n' > /etc/ld.so.conf.d/UniData.conf \
    && ldconfig

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

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
