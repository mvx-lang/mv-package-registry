# UniData 8.3.2 builder — captured from the licensed install on VM 108.
# A disposable, reproducible environment for building/releasing the UniData
# MultiValue packages (curses, git, ...).  Private internal use only; the
# UniData binaries are not redistributed.
FROM rockylinux:8

# UniData build + runtime dependencies (compile CallC bridges, run udt)
RUN dnf -y install \
        gcc gcc-c++ make tar gzip which hostname procps-ng findutils \
        glibc glib2 ncurses ncurses-devel gdbm gdbm-libs pam libxcrypt \
        unixODBC libnsl \
        glibc-langpack-en \
    && dnf clean all

# match the source install's group ownership
RUN groupadd -g 1001 unidata || true

# the captured install: /usr/ud83 + the from-source libgit2
COPY ud83.tar.gz /tmp/ud83.tar.gz
RUN tar xzf /tmp/ud83.tar.gz -C / \
    && rm -f /tmp/ud83.tar.gz \
    && ln -sf libgit2.so.1.9.6 /usr/local/lib64/libgit2.so \
    && printf '/lib64\n/usr/lib64\n/usr/local/lib64\n/usr/ud83/bin\n' > /etc/ld.so.conf.d/UniData.conf \
    && ldconfig

# UniData network daemon port
RUN printf 'udt_os\t1382/tcp\nudt_os\t1382/udp\n' >> /etc/services

ENV UDTHOME=/usr/ud83 \
    UDTBIN=/usr/ud83/bin \
    PATH=/usr/ud83/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LD_LIBRARY_PATH=/usr/ud83/bin \
    TERM=xterm \
    LANG=en_US.UTF-8

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
