# syntax=docker/dockerfile:1.7
#
# The web image (Railway service nexus-web): Next.js `standalone` output, started by apps/web/scripts/start.mjs.
# Built by .github/workflows/images.yml; see docs/ci-fast-deploys/PLAN-2026-09-29.md.
#
# Context: the repository root; apps/web/Dockerfile.dockerignore is its allow-list. The image is public. The build
# arguments are the values Next inlines at build time: NEXT_PUBLIC_* reach the browser anyway, and
# NEXUS_API_PROXY_TARGET (the API's private address) is frozen into the standalone server's /backend rewrite. No secret
# is a build argument; Railway provides the runtime variables (DATABASE_URL, …).

ARG NODE_IMAGE=node:22.23.2-bookworm-slim

# OpenSSL: Prisma picks its engine build from the OpenSSL it finds (the web reads some pages through @nexus/database).
FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 NPM_CONFIG_UPDATE_NOTIFIER=false

# Only the workspaces the web uses (apps/web, packages/database, shared) and their part of the lockfile.
FROM base AS prune
WORKDIR /repo
COPY . .
RUN npx --yes turbo@2.9.6 prune @nexus/web --docker

# Dependencies from the package.json files alone, so this layer stays cached until a dependency changes. Install
# scripts are skipped: the database package's postinstall needs its schema, which comes with the sources.
FROM base AS build
WORKDIR /app
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY --from=prune /repo/out/full/ ./
COPY patches ./patches
COPY --from=prune /repo/docs/fixtures/vt1/fixtures.ts ./docs/fixtures/vt1/fixtures.ts
# Then the install scripts that matter: Prisma's, the database package's (`prisma generate`), and the root's
# patch-package (ag-grid-enterprise).
RUN npm rebuild @prisma/engines prisma @nexus/database && npx patch-package

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WORKSPACES_ENABLED
ARG NEXT_PUBLIC_AUTH_ENFORCE
ARG NEXT_PUBLIC_AG_GRID_LICENSE_KEY
ARG NEXUS_API_PROXY_TARGET
# Without an API address the app falls back to the production API (hard rule 3): refuse to build one by accident.
RUN test -n "$NEXT_PUBLIC_API_URL" || { echo "NEXT_PUBLIC_API_URL is required"; exit 1; }
# Without next build's type step, as CI's smoke build does: the app imports types from apps/api's sources, which this
# pruned tree does not contain (and apps/api imports types from the web). The compile resolves every real import;
# CI's typecheck job checks the types.
RUN NEXT_OUTPUT=standalone NEXUS_CI_SKIP_BUILD_TYPECHECK=1 npm run build --workspace=@nexus/web

# The standalone tree keeps the repository layout: /app/apps/web/server.js, /app/node_modules, /app/packages.
FROM base
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/scripts/start.mjs ./apps/web/scripts/start.mjs
EXPOSE 3000
CMD ["node", "apps/web/scripts/start.mjs"]
