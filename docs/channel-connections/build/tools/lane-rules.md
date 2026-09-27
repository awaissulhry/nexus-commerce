# Rules for every implementation lane (read fully before starting)

Programme: Nexus channel connections (Amazon, eBay, Etsy; Shopify stays connected and untouched; P8 new channels deferred).
Main dev worktree (DO NOT EDIT; read-only reference): /private/tmp/nexus-channel-connections-20260922 (branch fix/channel-connections-20260922, HEAD cd545b84f).
NEVER touch /Users/awais/nexus-commerce (another session owns it). NEVER push, never run `git push`, never bypass hooks, never `git add -A`/`git add .`, never stash.
NEVER contact production, Railway, Neon, AWS/KMS, or any channel/vendor API (reading public vendor docs on the web is fine). The repo-root `.env` of the dev worktree points at PRODUCTION: never copy or load it.

## Setup (run exactly, sequentially)
```
git -C /private/tmp/nexus-channel-connections-20260922 worktree add -b <BRANCH> <LANE_DIR> cd545b84f
cp /private/tmp/nexus-channel-connections-20260922/apps/api/.env <LANE_DIR>/apps/api/.env   # local-only DB 127.0.0.1:55439
cd <LANE_DIR> && npm ci --no-audit --no-fund
(cd packages/shared && npm run build) && (cd packages/events && npm run build)
(cd apps/api && npx prisma generate --schema=../../packages/database/prisma/schema.prisma)
```
After any schema.prisma change, re-run prisma generate — and NEVER run prisma generate / builds at the same time as tests in the same worktree.

## Shell traps
- `grep` is a shell function running ugrep that skips gitignored files: use `/usr/bin/grep -rn`.
- `docs/channel-connections/build/` is gitignored by a generic rule: build records need `git add -f`.
- Run API tests from `<LANE_DIR>/apps/api`: `npx vitest run <files>` (prints the database target; it must be 127.0.0.1).
- Do NOT run the full API suite and do NOT apply migrations to the local 127.0.0.1:55439 database (other lanes share it). Schema/migration/RLS/lock/race proof uses the throwaway real-PostgreSQL runner:
  `node scripts/run-real-postgres-tests.mjs --suites '[{"name":"x","file":"src/…postgres.vitest.test.ts","expect":N}]'` from <LANE_DIR> (Docker, pgvector/pgvector:pg17, runs as NOSUPERUSER production-equivalent owner; exact counts, zero skips). Test DBs come from `apps/api/src/test-support/concurrent-database.ts` (schema from schema.prisma + generated workspace policies).
- New real-PostgreSQL suites must be registered in `scripts/run-real-postgres-tests.mjs` SUITES with the exact expected count.
- New tables: register ownership in `packages/database/workspaces/model-ownership.json` (see existing entries), add RLS/policy per existing patterns, and pass `node packages/database/scripts/check-model-ownership.mjs`, `node packages/database/scripts/check-policy-migration-parity.mjs`, `node packages/database/scripts/check-schema-drift.mjs`, `node packages/database/scripts/check-column-drift.mjs` and `npm run test --workspace=@nexus/database`.
- Migrations: additive only, new folder under packages/database/prisma/migrations with the name given in your brief; never edit an existing migration.

## Quality bar (non-negotiable)
- Reproduce each defect first (a failing test = "red" log) before fixing; keep the red log.
- Real PostgreSQL for anything about locks, races, RLS, transactions, uniqueness.
- Guard mutations: for each important guard, apply a mutation, run the relevant tests, confirm a test FAILS by assertion (killed), restore the file byte-for-byte (check sha256). Record every result, including survivors; a survivor means a missing test — add it and re-run. Script this (python) like docs/channel-connections/build/tools/f6bc_mutations.py.
- Never weaken an assertion, timeout, ratchet, hook or existing test to make something pass. Existing tests that encode the old defective behaviour may be updated only when the brief says the behaviour changes; say so explicitly.
- `npm run typecheck` in apps/api must pass (run it when no tests are running).
- Save every evidence log under /private/tmp/cx-completion-20260922/<lane>-*.log.
- Match the surrounding code style (dense, typed, short comments that state WHY).
- UI (only if your brief includes it): apps/web/src/design-system only, read DESIGN.md + apps/web/CLAUDE.md; no raw palette values.

## Commits
Commit per slice on YOUR branch only, staging files by name. Message style: `feat(cx): ...` / `fix(cx): ...` with a body listing evidence; end the message with:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

## Final report (≤ 700 words)
Branch, commit SHAs, files, what changed in behaviour (production-facing vs dormant/flagged), tests (counts, red logs, realPG suite counts), mutations (killed/survived), typecheck, open risks, anything you could NOT prove, and exact text for a build-record section (≤ 40 lines) that the main session will paste into docs/channel-connections/build/CX-REMAINING.md. Do not claim deployment or production proof.
