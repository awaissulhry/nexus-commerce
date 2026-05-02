# Development setup

Short notes for contributing to Nexus. See `RESTORATION_NOTES.md` for the historical phase log and `TECH_DEBT.md` for the prioritised backlog.

## First-time setup

```bash
npm install
# Sets up workspaces (apps/web, apps/api, packages/database, …).
# Postinstall runs `prisma generate` in packages/database.
```

Point `DATABASE_URL` at a Postgres instance (Neon / Railway / local Docker). Then:

```bash
cd packages/database
npx prisma migrate deploy   # apply existing migrations
```

## Pre-push gate (recommended)

A pre-push hook runs the schema-drift check then builds both `apps/web` and `apps/api`. To install:

```bash
git config core.hooksPath .githooks
```

(Once per clone. There is no CI yet — this hook is the only barrier between a broken commit and `origin/main`. CI is on the backlog.)

The canonical hook lives at `.githooks/pre-push`. If you edit it, the change is version-controlled and benefits everyone running `core.hooksPath`.

## Schema changes

When modifying `packages/database/prisma/schema.prisma`, you **must** create a corresponding migration. The pre-push hook (and `npm run check:drift`) will reject pushes that have schema models without a `CREATE TABLE` in any migration.

```bash
cd packages/database
# Edit schema.prisma — add a model, add a column, etc.
npx prisma migrate dev --name describe_what_changed
# Commit BOTH schema.prisma AND the new migrations/<timestamp>_*/ folder
```

Why this matters: TypeScript via `prisma generate` is happy as long as the schema declares the model — but `findMany()` will throw at runtime if Postgres has no matching table. `/products` was empty for a day on 2026-05-02 because of exactly this. See TECH_DEBT entry **#0**.

### Running the drift check manually

```bash
npm run check:drift
```

Exits 0 on clean, 1 on drift, with a report listing the offending model(s). The script:

- Parses `prisma/schema.prisma` for every `model X` block (and any `@@map("y")`).
- Scans every `prisma/migrations/*/migration.sql` for `CREATE TABLE [IF NOT EXISTS] "X"`.
- Reports any model whose table never appears.

Limitations (consciously out of scope):

- **Column-level drift** — adding a field to a model without a migration that adds the column. Catching this needs a real shadow database; today it would be a CI step with a Postgres service container, not a fast pre-push hook.
- **Renames** — `ALTER TABLE … RENAME TO` after the original `CREATE TABLE`. Rare; if it bites, extend the script.

### Drift allow-list

`packages/database/scripts/check-schema-drift.mjs` has a small `ALLOW_LIST` near the top for pre-existing drift that's tracked in `TECH_DEBT.md` (entries #31, #32 as of 2026-05-02). Each entry must reference a ticket. Removing an entry: ship the missing migration, then delete the line. Adding new entries silently to bypass the gate is a footgun — don't.

## Useful commands

```bash
# Build everything (turbo)
npm run build

# Drift gate only
npm run check:drift

# Database tooling
cd packages/database
npx prisma studio          # browse the DB
npx prisma migrate dev     # create + apply migration locally
npx prisma migrate deploy  # apply migrations (CI / production)
npx prisma generate        # regenerate client types
```

## Deploys

- **API** — Railway. The `start` npm script runs `prisma migrate deploy` before `node apps/api/dist/index.js`, so migrations land before the server boots.
- **Web** — Vercel. Standard Next.js build.
