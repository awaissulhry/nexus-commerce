# syntax=docker/dockerfile:1.7
#
# The API image. One image serves three Railway services — @nexus/api, nexus-worker and nexus-scheduler — which differ
# only by start command (`node apps/api/dist/index.js`, `… background.js worker`, `… background.js scheduler`).
# Built by .github/workflows/images.yml; see docs/ci-fast-deploys/PLAN-2026-09-29.md.
#
# Context: the repository root; apps/api/Dockerfile.dockerignore is its allow-list. The image is public, so no secret
# goes into any layer: the only build argument is the commit SHA. Railway provides every runtime variable.

ARG NODE_IMAGE=node:22.23.2-bookworm-slim

# OpenSSL and CA certificates: Prisma's migration engine needs both (the pre-deploy step runs `prisma migrate deploy`),
# and Prisma picks its engine build from the OpenSSL it finds at install time.
FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 NPM_CONFIG_UPDATE_NOTIFIER=false

# Only the workspaces the API uses (apps/api, packages/database, shared, events) and their part of the lockfile.
FROM base AS prune
WORKDIR /repo
COPY . .
RUN npx --yes turbo@2.9.6 prune @nexus/api --docker

# Dependencies from the package.json files alone, so this layer stays cached until a dependency changes. Install
# scripts are skipped: the database package's postinstall needs its schema, which comes with the sources.
FROM base AS build
WORKDIR /app
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY --from=prune /repo/out/full/ ./
# Then, from the sources:
# - only the install scripts that matter: Prisma's (they fetch the migration engine) and the database package's (links
#   its `nexus-model-metadata` generator, whose file did not exist yet, and runs `prisma generate`); sharp and msgpackr
#   load their prebuilt binaries without one;
# - the API, compiled as `npm run build --workspace=@nexus/api` does but with `--noCheck`: src/services/presence/types.ts
#   imports types from @nexus/web, which this pruned tree does not contain. Type-only imports leave no trace in the
#   output (measured 2026-09-29: all 1,813 emitted .js and .map files byte-identical with and without the check), and
#   CI's typecheck job checks the types;
# - no dev dependencies and no test files (sources and compiled): nothing runs them in production, and their fake keys
#   and database URLs would trip scripts/ci/check-image-secrets.sh.
RUN npm rebuild @prisma/engines prisma @nexus/database \
 && npm run build --workspace=@nexus/shared \
 && npm run build --workspace=@nexus/events \
 && node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noCheck \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && find apps packages -name node_modules -prune -o -type f -name '*.test.*' -exec rm -f {} +

# The same /app layout as Railway's own builds: code resolves paths from the repository root (process.cwd()).
FROM base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
# /api/health/ready reports this as `build`; the deploy waits until production serves it.
ARG RELEASE_SHA
RUN test -n "$RELEASE_SHA" && printf '%s\n' "$RELEASE_SHA" > apps/api/.release-sha
EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]
