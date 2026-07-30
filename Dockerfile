# mv_package registry — runnable service image.  GPL-2.0-only.
#   docker build -t mvpkg-registry .
#   docker run -d --name mvpkg-registry -p 8080:8080 \
#     -v mvpkg-data:/data -e MVPKG_PUBLISH_TOKEN=... --restart unless-stopped mvpkg-registry
FROM node:20-alpine
WORKDIR /app
COPY server.js .
ENV MVPKG_REGISTRY_DIR=/data MVPKG_PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
