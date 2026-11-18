FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/var && chown node:node /app/var
USER node
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/app/var/store.sqlite
EXPOSE 3000
VOLUME ["/app/var"]
CMD ["node", "server/index.mjs"]
