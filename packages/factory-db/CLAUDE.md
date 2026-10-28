# packages/factory-db — the factory's Prisma schema and database helpers

Prisma 7.10 with a schema folder, `prisma/schema/`: `schema.prisma` holds the generator and the datasource, and each
module adds its own `.prisma` file. No models yet. The client is generated into `src/generated/prisma` (git-ignored),
never into `node_modules`, where Commerce's client lives. `src/test-database.ts` is the test-database guard.

## Commands
    cd packages/factory-db && npx prisma validate
    npm run generate -w @nexus/factory-db       # typecheck runs it first
    npm run typecheck -w @nexus/factory-db
    cd packages/factory-db && npx vitest run

## Rules
- Run the Prisma CLI only from this folder. `prisma.config.ts` reads only `packages/factory-db/.env`
  (`FACTORY_MIGRATION_DATABASE_URL`, else `FACTORY_DATABASE_URL`) and refuses a non-loopback database off Railway.
- Every generator has an `output` inside this package (`scripts/factory/check-prisma-output.mjs`). A relative output
  is read from `prisma/schema/`, the folder of the file that holds the generator.
- No `Float` (`scripts/factory/check-no-float.mjs`): amounts are Int minor units, unit prices and costs Decimal(18,6),
  quantities Decimal(18,4).
- Never `prisma migrate reset`, `prisma db push` or `prisma migrate dev` against a shared database; `migrate dev` only
  against a throwaway one. Unlike Commerce, the factory's migration history must replay from zero.
- Never hand-edit `src/generated/`.
