# syntax=docker/dockerfile:1
# Three targets:  runtime (default, what production runs)  ·  tools (migrations, seed, bootstrap-admin, Excel import)  ·  build (intermediate)
FROM node:22-bookworm-slim AS base
# postgresql-client-17 (from the official PGDG repository; Debian 12 only ships 15) provides pg_dump/pg_restore for the in-app backups. A pg_dump must be
# at least as new as the server, and it can dump older servers too. Not built or run in the authoring environment: check `docker build` in CI.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl gnupg \
    && install -d /usr/share/keyrings && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
    && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npx nest build

# Operator image: has the CLI tooling (prisma migrate, ts-node scripts). Never exposed to the internet.
FROM build AS tools
COPY scripts ./scripts
COPY --from=build /app/dist ./dist
CMD ["npx", "prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
RUN groupadd --system app && useradd --system --gid app --home /app app && chown -R app:app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
