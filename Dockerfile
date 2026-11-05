# behavior-dashboard — zero npm dependencies: the image is the source plus a
# Node runtime. Nothing to install, nothing to supply-chain.
FROM node:22-slim

ENV NODE_ENV=production
# /data holds the SQLite file; it is the only state and the only volume.
RUN mkdir -p /data && chown -R node:node /data
USER node
WORKDIR /app

COPY server.js ./
COPY public ./public

ENV DB_PATH=/data/board.db
EXPOSE 3000

# node:slim ships no curl — the healthcheck rides node's own fetch.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
