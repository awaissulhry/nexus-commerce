# CI plan — required PR checks under 10 minutes

> Saved from the approved plan on 2026-09-26.
> Status: APPROVED by the Owner 2026-09-26. Phase 3: all five tier PRs open, **based on main without #4** (Owner's choice, §6c). #4 is deferred (§4.1a).
> Owner decisions (2026-09-26):
> - Land `chore/architecture-reliability` first.
> - Make the repo **public**, so GitHub-hosted runners are free.
> - Do not buy a paid GitHub plan.

## 0. Context — why

**The pre-push hook is too slow, so it is skipped.**
- The hook has 56 steps. It takes about 8–9 min, plus 20–26 min when the editor-open browser gate runs.
- The Owner has pushed with `--no-verify` since 2026-09-25.

**On `origin/main`, CI has almost no security steps.** `ci.yml` runs only:
- drift checks
- i18n
- `prisma validate`
- the API build
- two PIM and grid test folders

**So today these run nowhere:**
- RBAC deny-by-default coverage
- runtime-role / FORCE RLS on PG17
- the 13 real-Postgres race and RLS suites
- the auth security suite
- the web proxy security tests
- model ownership and policy parity
- the business-profiles-ON (tenant mode) ratchet
- 45 static ratchets

Most of those steps exist in CI only on the **unpushed** branch `chore/architecture-reliability`.

**Goal:**
- fast local hooks
- one required PR check under 10 min that always runs every security check
- slow work at night

## 1. Measurements (Phase 1)

### 1.1 CI before (measured with `gh`, 2026-09-26)

`gh` was installed and logged in after the plan was approved. These are medians of the last 5 successful runs on `main`, while the repo was still private (2-vCPU runners).

**`ci.yml` on main — 11.8 min** (sum of step medians)

| Step | Median | Min–max |
|---|---|---|
| Install dependencies (`npm ci`) | 73 s | 66–78 s |
| apps/api build (tsc) | 93 s | 80–96 s |
| Product grid resolver, write contracts, PGlite regressions (`src/services/pim` …) | **418 s** | 320–442 s |
| Product grid editor regressions (web) | 92 s | 71–94 s |
| Everything else (checkout, drift, i18n, validate, containers) | ~30 s | |

- The 7-minute step is the PIM database tests. The API vitest config gives `floor(cpus/2)` = **1 worker** on a 2-vCPU runner.
- It ran on every push to `main`, and again inside Deploy API (branch version).

**`deploy-api.yml` on main — 10.2 min**

| Step | Median |
|---|---|
| `npm ci` | 80 s |
| API build | 93 s |
| `railway up` (Railway builds from source) | 401 s |
| Other | ~35 s |

Local numbers below are **measured** on this Mac (18 cores) or **read** from the last hook logs (`/tmp/*.log`, 2026-09-25).

### 1.2 What runs today

| Where | Trigger | What | Time |
|---|---|---|---|
| pre-commit | — | nothing | — |
| post-commit | every commit | graphify rebuild (local, untracked, detached) | ~0 s blocking |
| pre-push | every push | 56 steps. All always run except the browser gates (path-scoped). The first failure stops the push. | read: ~8–9 min; +20–26 min with browser gates |
| CI `ci.yml` (main) | PR to main, push to main | one job with 11 steps and no path filter | measured: 11.8 min (§1.1) |
| `deploy-api.yml` (main) | push to main, API paths | `npm ci`, prisma generate, API build, 2 tests, `railway up`, health poll. **It does not wait for CI.** | measured: 10.2 min (§1.1) |
| Railway | `railway up` | builds from source (`dist/` is gitignored); no tests | unknown |
| Railway `nexus-web` (since 2026-09-29) | push to main, web paths (`deploy-api.yml` job `deploy-web`) | `railway up`: builds from source, `next build` with type checks, then `next start` | unknown |

**Pre-push step times, read from the 2026-09-25 logs:**

| Step | Time |
|---|---|
| API vitest, all projects (991 files, 12,579 tests, 4 workers) | 109 s |
| Web vitest (397 files, 4,900 tests) | 6.4 s |
| Web `next build` (compile 12 s, TypeScript 45 s, pages) | ~80 s |
| Database package tests / security suite | 3.8 s / 0.8 s |
| RBAC coverage (2,728 routes, 0 unmapped) | a few s |
| Profiles-ON ratchet (977 files, 41 known failing) + real-PG | ~5 min together |
| 45 static ratchets | < 2 s each |

**Measured in this session:**

| Item | Result |
|---|---|
| API `tsc --noEmit`, no incremental | 16.7 s |
| `prisma migrate diff` to schema SQL (553 KB) | 0.86 s |
| PGlite create + schema + policies | 0.61 + 0.56 + 0.25 s → with the diff, **2.3 s per test file** |
| PGlite restore from a saved snapshot | **0.34 s** |
| Commits on main, 09-14 → 09-25 | 435 (6–88 per day) |

### 1.3 Answers to the Phase 1 questions

**Runs regardless of what changed**
- All of `ci.yml`.
- 55 of the 56 pre-push steps.
- On the branch version, CI also runs twice for each main push: `CI`, then `verify` inside Deploy API.

**Turborepo remote cache**
- Not configured.
- CI does not use turbo at all.
- `turbo.json` has only `build`, `dev` and `lint`. There is no `test` or `typecheck` task.

**How the test Postgres is started and migrated**
- **PGlite (in-process):** a new database **per test file**, in 53 files. Each one runs `prisma migrate diff`, then the DDL for 448 models, then the policies. There is no template or snapshot.
- **Real Postgres:**
  - `scripts/run-real-postgres-tests.mjs` starts it with `docker run` on tmpfs, with no fsync flags.
  - It makes one database per file with `CREATE DATABASE` and no `TEMPLATE`.
  - Files run one at a time, because role creation collides.
  - A second container runs `runtime-role-postgres`.
- **Migrations are never replayed.** The history does not replay from zero ("443 apply, 24 fail"). Fresh databases come from `baseline.sql` through `bootstrap-fresh-database.mjs`.
- **No job applies migrations to a fresh database.**

**How Playwright runs**
- `apps/web/playwright.config.ts`: chromium, with no workers, shard, webServer or storageState settings.
- 9 specs, 55 tests, 29 marked `fixme`. They target the live site.
- There are no `@smoke` tags.
- **They run nowhere.**
- The "browser gates" are 3 Node scripts that use the Playwright library:
  - they run against `next dev`, not a production build;
  - they need the seeded local `nexus_development` database;
  - each gate signs in through the API;
  - they run one at a time.

**Local hooks**
- `core.hooksPath` is `.githooks`. There is no husky, lefthook or lint-staged.
- **Tracked `pre-push`:**
  - drift checks
  - database tests
  - 45 static ratchets
  - browser gates
  - full web and API suites
  - both builds
  - RBAC coverage
  - security suite
  - real-PG tests
  - the profiles-ON ratchet
- **Untracked, local only:** `post-commit` (graphify).

**No lint exists**
- There is no ESLint config and no `eslint` package.
- `next lint` was removed in Next 16, so the web `lint` script is dead.

**Duplicated work**

| Work | Where it repeats |
|---|---|
| `npm ci`, which also runs prisma generate in postinstall | each Actions job, plus Railway per service |
| API build (shared, events, prisma generate, tsc) | CI, deploy job, Railway per service. The deploy job's `dist/` is thrown away. |
| Catalog CSV tests | the deploy job, and again inside `src/services/pim` (branch) |
| Web build | hook, CI smoke build, Railway `nexus-web` (production only) |
| Railway native autodeploy | **probably still on** (inferred from "Railway commit checks report success") → maybe a second deploy and a second migration run per push |

**The 20 slowest test files**
- Source: the Vitest results cache. Values are test-body seconds from the last local run.
- Import time is extra: 135 s cumulative for the API.
- ● = the file builds a database.

| # | s | File |
|---|---|---|
| 1 | 32.0 | api `services/pim/mapping/formula-database.vitest.test.ts` ● |
| 2 | 25.6 | api `services/pim/information-database.vitest.test.ts` ● |
| 3 | 25.2 | api `services/workspace.vitest.test.ts` ● tenant isolation |
| 4 | 22.0 | api `lib/cron/workspace-lease.vitest.test.ts` (Redis) |
| 5 | 21.3 | api `services/pim/variation-rule-view.vitest.test.ts` (dev catalogue) |
| 6 | 19.0 | api `services/pim/variation-quality.vitest.test.ts` (dev catalogue) |
| 7 | 17.3 | api `services/pim/catalog-transfer-download.vitest.test.ts` |
| 8 | 15.8 | api `services/pim/content-write.vitest.test.ts` ● |
| 9 | 15.3 | api `services/pim/market-languages-guard.vitest.test.ts` |
| 10 | 13.2 | api `services/pim/catalog-transfer-jobs.vitest.test.ts` ● |
| 11 | 13.1 | api `services/stock-pool/stock-pool-concurrency.vitest.test.ts` ● real PG |
| 12 | 10.6 | api `services/assortment/sync.vitest.test.ts` ● real PG |
| 13 | 10.6 | api `services/pim/information-migration.vitest.test.ts` ● |
| 14 | 10.2 | api `services/pim/catalog-product-transfer.vitest.test.ts` ● |
| 15 | 7.9 | api `services/__tests__/pim-global-routes.test.ts` |
| 16 | 6.2 | api `services/pim/product-relationship.vitest.test.ts` ● |
| 17 | 6.1 | api `services/pim/mapping/review-inputs.vitest.test.ts` ● |
| 18 | 6.0 | api `services/pim/catalog-transfer-http.vitest.test.ts` ● |
| 19 | 6.0 | api `services/stock-pool/stock-pool-orders.vitest.test.ts` ● real PG |
| 20 | 4.3 | web `products/[id]/edit/_studio/sheet/master/masterWrite.deadport.vitest.test.ts` |

These 20 files take 7.3 of the 8.1 min of total test-body time. **The cost is databases and imports, not test logic.**

### 1.4 Gaps found

1. The security checks listed in §0 run nowhere today.
2. CI runs the API tests with business profiles **OFF**. Production has run **ON** since 2026-09-16.
   - The ON baseline also tolerates failures in 6 security files: `auth-routes`, `cx/oauth`, `cx-connect`, `amazon-ads-auth`, `shopify-webhooks-events`, `lib/cron/clustered`.
   - The ratchet stops them getting worse. Fixing them is separate work.
3. These never run anywhere:
   - factory tests (78 files, plus 8 its config never collects)
   - `packages/shared` and `packages/events` tests
   - `stock-pool-rush` and `assortment/sync-load`
   - 39 legacy `*.test.ts` files
4. `cancel-in-progress: true` also applies on main, so a fast second push cancels the first commit's check.
5. On main, the API migrates at startup (`railway.toml` startCommand). The fix (commit `8b431c322`, `preDeployCommand`) is only on the unpushed branch.
6. Web production has no post-deploy smoke test.
7. There is no branch protection.
8. Six API test files need the developer's seeded database: `database-target`, `amazon-publish-binding` and the 4 `variation-*` catalogue suites.
9. There are **no marketplace sandbox tests**. The 5 `*.local.vitest.test.ts` files are local-database rehearsals. The only live marketplace check is the eBay consent check in deploy.

## 2. Target tiers

Runner: a **public** repo gets free GitHub-hosted `ubuntu-latest` with **4 vCPU and 16 GB**, and no minute limit. A free account can run **20 jobs at once**, so a PR run was kept to ≤ 8 jobs at peak. Since 2026-09-30 it peaks at 9, to bring verify under 10 min (docs/ci-fast-deploys/PLAN-2026-09-29.md, D1 = A). §7 has the job budget.

| Tier | Runs | Budget | Estimate |
|---|---|---|---|
| A pre-commit | lint-staged → the fast gates for the staged file types | < 10 s | 1–5 s |
| B pre-push | typecheck of the affected workspaces | < 2 min | ~20–60 s (api 17 s and web ~45 s, in parallel) |
| C PR required | see 2.3 | < 10 min wall | measured 12.7 min (median of 15 runs, 2026-09-29); est. 8.25 min since the 2026-09-30 split (§2.3) |
| D merge to main | verify, deploy, smoke production | — | deploy time + ~2 min |
| E nightly + manual | everything slow | — | 30–60 min |

### 2.1 Tier A — pre-commit (< 10 s)

**Setup**
- Add `lint-staged` as a root devDependency.
- Add a tracked `.githooks/pre-commit` that runs `npx lint-staged --no-stash`.
  - `--no-stash` is needed because the default stashes unstaged work. That breaks the "never stash" rule while other sessions share the checkout.
  - If `node_modules` is missing (some worktrees), the hook warns and exits 0.
- Do not touch the local `post-commit`.

**What runs**
- There is no ESLint or Prettier. Adding one is new scope: a first run would flag thousands of lines.
- So lint-staged runs the repo's own fast gates, picked by staged file type:
  - `*.css`: CSS parse, hex, radius and DS-shadow ratchets
  - `apps/*/src/**/*.{ts,tsx}`: raw primitives, AG Grid boundary, route-prisma, context boundary, stock-writer lock
  - i18n `*.json`: the i18n catalog check
  - `schema.prisma` and `migrations/**`: drift, model ownership, expand/contract
  - `design-system/tokens/**`: both `tokens:check` commands
- Scripts that scan the whole tree are called without file arguments. Known limit, the same as today: another session's unstaged file can fail your commit.

**Rollback:** delete `.githooks/pre-commit`.

### 2.2 Tier B — pre-push (< 2 min)

**New hook**
- `.githooks/pre-push` runs `npx turbo run typecheck --affected --cache=local:rw`. The base is `git merge-base HEAD origin/main`.
- `turbo.json` gets a `typecheck` task that depends on `@nexus/shared#build` and `@nexus/events#build` only.
  - Not `@nexus/database#build`, because it rewrites tracked generated files in the shared checkout.
- Pass `tsc --incremental false`. A shared `tsbuildinfo` has given false results before.
- Web runs `next typegen` before `tsc`, so the route types exist.
- Known limit: like today, this checks the working tree, including uncommitted files.

**The old hook**
- Its body moves to `scripts/gates-full.sh`, run with `npm run gates:full`.
- It keeps the browser gates and the 6 dev-catalogue tests, for manual runs.

**Order rule:** this PR merges only **after** the Tier C checks are required on main. Otherwise the hook's checks disappear before CI covers them.

**Rollback:** restore the old hook file from git.

### 2.3 Tier C — PR required (< 10 min)

A new `.github/workflows/ci.yml`. The jobs run in parallel.

| Job | When | Does | Est. (4 vCPU) |
|---|---|---|---|
| `checks` | always | static gates, typecheck, web tests and small workspace tests (see below) | 3–4 min |
| `api (1/4)` … `(4/4)` | **always, full suite, never affected-gated** | each shard runs its quarter of the whole API suite twice: profiles **OFF**, then profiles **ON** (see below). Three shards until 2026-09-30. | slowest shard est. 6.8–8.7 min (3 shards: 8.4–10.9 min measured) |
| `postgres (1/2)`, `(2/2)` | **always** | one `pgvector/pgvector:pg17` container per part (see below). The real-PG suites are split in two by measured time; the other real-DB steps run once, in part 1. The part count is the matrix's size. One job until 2026-09-30. | est. 4.4–7.3 min per part (one job: 7.4–12.6 min measured) |
| `smoke (1/2)`, `(2/2)` | affected web or api | builds and starts the app, runs Playwright `@smoke` (see below) | 5–6 min |
| `db-security` | always, needs `api` + `postgres` | aggregator with a fixed name, so a branch rule can require it. It checks one profiles-ON report per API shard (the count read from the reports' names), and that the PostgreSQL parts together passed every real-PG suite once. | seconds |
| `ci-ok` | always, needs all | fails on any failed or cancelled job. "Skipped" is allowed only for `smoke`. | seconds |

Times: the `api` and `postgres` cells come from 15 green runs of 2026-09-29, with each job's measured test steps scaled to the new split. `checks` and `smoke` keep the plan's first estimates; in those runs they took 4–7 min and 3–4 min.

Peak: 9 jobs per PR run (7 until 2026-09-30). Critical path: the slowest `api` shard, about 7.8 min (est. median; range 6.8–8.7 min). Before the split it was `postgres`, in 14 of the 15 runs. Verify, from the first job to `ci-ok`: 12.7 min measured (median), about 8.25 min estimated (range 7.1–9.2 min).

**`checks` job**
- `scripts/ci/run-static-gates.mjs` runs, in parallel, and reports **all** failures, not the first:
  - all 45 static ratchets
  - drift, i18n, `prisma validate`
  - ownership and policy parity
  - event and graph contracts
  - the browser-gate runner's own unit tests
  - the expand/contract check (§4.2)
  - a rule that migration folders already on main stay byte-identical
- `turbo run typecheck --affected`.
- The **whole** web vitest suite. It takes 6 s locally, and it holds the proxy, workspace-path and permission-gate tests.
- `turbo run test --affected --filter=!@nexus/api --filter=!@nexus/web`: factory, shared, events.

**`api` shards — why always the full suite**
- A review showed that picking "security" test files by name or content misses real ones. Examples:
  - webhook signatures: `cx/ingress/ebay-signature`, `utils/webhook`
  - OAuth: `cx/connectors/shopify/auth`
  - credential crypto: `lib/crypto-v2`
  - SSRF: `lib/outbound-webhook`
  - cross-account guards: `write-account-guard.p07`
- A public repo has free minutes, so the plan runs **every** API test on every PR. No selection means no misses.

**`api` shards — what each shard does**
- Excluded, with reasons in `scripts/ci/api-test-plan.mjs`:
  - the 4 catalogue suites (they need the dev database);
  - `database-target`, 6 opt-in rehearsals against a local database copy and 2 nightly load tests (13 named files in all, with the catalogue suites);
  - the real-PG runner's suites (55 on 2026-09-30; they run in the `postgres` parts).
  - `--summary` prints the live counts: on 2026-09-30 (main at a1873cc6a), 1210 collected, 1142 in shards, 68 excluded.
  - The script fails if a file is lost or counted twice, or if a list is empty.
- **OFF pass:** Redis is up and `NEXUS_TEST_REDIS_URL` is set, so the Redis lease test really runs.
- **ON pass:**
  - `NEXUS_WORKSPACES_ENABLED=1` with a dead Redis port, the same as the hook.
  - A JSON report is uploaded per shard.
  - `db-security` merges the reports and runs `profiles-on-ratchet.mjs --report=` against a CI baseline, `profiles-on-baseline.ci.json`.
  - The ratchet is changed to count a file as "fixed" **only if it ran**. Today it calls every baselined file that did not fail "fixed", so any partial run goes red.
- **Workers:** `maxWorkers` is 2 by today's formula on 4 vCPU.
- **Shard count:** written once, as the `api` matrix in `ci.yml`. The job's `SHARD` (`n/m`) and the report's artifact name (`profiles-on-<n>-of-<m>`) take m from `strategy.job-total`; no command or check repeats it. db-security reads m back from the reports' names: all must name the same m, and n must run 1..m with no gap and no repeat, one `on.json` each. So a shard that never reported fails db-security, and `api-test-plan.mjs` refuses a shard outside 1..m.
- **Skip ratchet:** a skipped test file that is not on a short allowlist fails the job. This catches tests that skip because an env variable is missing.

**`postgres (1/2, 2/2)` — real-DB work**
- Since 2026-09-30 two parts, a matrix; the part count M is the matrix's size (`strategy.job-total`). `run-real-postgres-tests.mjs --required --part N/M` runs its share of the real-PG suites, split by measured time, and refuses a split that loses or repeats a suite. Each part records the suites it passed (`--record`), and db-security checks that together they passed every suite once.
- Part 1 also runs the other steps below, once: runtime-role, RBAC coverage, the baseline check and the upgrade path. Only the real-PG runner line runs in both parts. The split gives part 1 a head start for those steps (`PART_ONE_HEAD_START` in the runner): about 32 s in CI (medians of 15 runs, 2026-09-29: durability off and the image pull ~4 s, RBAC ~8 s, upgrade check ~11 s, database package ~9 s), 5 % of the suites' 630 s. By the stored times, scaled to CI, that makes part 1 ≈ 299 s of suites + 32 s and part 2 ≈ 331 s; without it, part 1 was ≈ 346 s and part 2 ≈ 316 s.
- Both parts start the job's `pgvector/pgvector:pg17` service container on tmpfs. Only part 1 turns fsync, synchronous_commit and full_page_writes off in it, because only part 1's one-off steps use it. The real-PG suites, in both parts, run on the runner's own throwaway server (tmpfs, no durability flags). The migrations create the `vector` and `pg_trgm` extensions.
- **Security:**
  - `runtime-role-postgres`
  - `run-real-postgres-tests.mjs --required --part N/M --record <file>`: the real-PG suites on the runner's own throwaway server, started from the job's image (the planned `--url` flag was never built)
  - `npx tsx apps/api/src/scripts/check-rbac-coverage.ts`. A review traced it: it needs only built shared/events and the Prisma client, not real secrets.
- **Baseline check:** `baseline.vitest.test.ts` and `check-applied-but-missing.vitest.test.ts` read the URL from env, falling back to `apps/api/.env` locally. Today both crash on a clean runner.
- **Upgrade path — the migrations run the way production runs them:**
  1. Export the merge-base's `packages/database` into `.ci/base/`, with `git archive <base> packages/database | tar -x`.
  2. Bootstrap database A with **that** tree's `bootstrap-fresh-database.mjs`.
  3. Run the PR's `npm run db:migrate:deploy` against A, with a CI `MIGRATION_DATABASE_URL`. This applies only the PR's new migrations, with the production script.
  4. Bootstrap database B from the PR head.
  5. Run `prisma migrate diff --from-url A --to-url B --exit-code`. It must be empty. This proves the new migrations produce exactly the schema that fresh databases get. The non-schema extras (the policy indexes and `variationExcluded`) exist in both, so they cancel out.
- **On `push` and `workflow_call` (main):** the base is `github.event.before`, not the merge-base. On main, `merge-base HEAD origin/main` is HEAD itself, and the check would test nothing.

**`smoke` job — a new, small Playwright suite**
- **Build inside the job.** Each shard builds the web while Postgres starts and the API builds and boots. This avoids an artifact hop, and minutes are free.
- **Web build:**
  - `NEXT_PUBLIC_WORKSPACES_ENABLED=1`, because without it `/backend` returns 404 (`app/backend/[...path]/route.ts:5`).
  - `NEXT_PUBLIC_API_URL=http://localhost:<api port>`.
  - The type step is off, because `checks` covers it.
- **API:** runs from `dist`, as production runs:
  - `NEXUS_WORKSPACES_ENABLED=1`
  - `NEXUS_RBAC_MODE=enforce`
  - `NEXUS_DISABLE_BACKGROUND_JOBS=1`
  - `NEXUS_AMAZON_ENV_TOKEN=off`
- **Database:** bootstrapped from the PR head, plus `scripts/ci/seed-smoke.mjs`:
  - 2 businesses
  - 1 owner user
  - 2 products each
  - a LOGIN role in `nexus_workspace_runtime` for both web and API (`RuntimePool` refuses owner logins under `NODE_ENV=production`)
  - no channel credentials
- **Production is fenced off twice:**
  - `/etc/hosts` maps `nexusapi-production-b7bb.up.railway.app` to `0.0.0.0`.
  - Global setup reads a seeded nonce product through the UI. It aborts if the nonce is not there.
- **Sign-in:** the web is served on `localhost`, because the cookies are `__Host-`/`Secure`.
  - Global setup signs in once with the proven browser-side recipe from `scripts/studio-browser-auth.mjs`.
  - It saves `storageState`, which every test reuses.
- **`@smoke` tests (about 8):**
  1. sign-in page
  2. products grid shows rows
  3. product edit page opens
  4. one cell edit saves and reads back
  5. orders page
  6. settings page
  7. switching business hides the other business's products (tenant isolation in the UI)
  8. sign out, with its own login so it does not end the shared session
- **Config:** `playwright.config.ts` gets a `smoke` project (`grep: /@smoke/`) with `workers: 2`, run as `--shard=${i}/2`.
- **Existing specs:** the 55 tests stay out. They go to Tier E after their live-site URLs are replaced.

### 2.4 Tier D — merge to main

**`deploy-api.yml`**
- Keep `verify`: it calls the Tier C workflow on the main commit.
  - Why: without a merge queue (not offered to personal accounts), the squashed main tree can differ from the tree the PR tested.
  - This adds CI time before a deploy. It adds nothing to PR wait time.
- Remove the deploy job's duplicate API build, `prisma generate` and CSV tests, because Railway builds from source.
- Keep the eBay consent check.

**`ci.yml`**
- It no longer triggers on `push: main`. Deploy's `verify` covers it.
- Concurrency uses `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.

**Production smoke (read-only: no sign-in, no writes)**
- **API:**
  - Keep the SHA and health poll.
  - Add a Railway deployment-status check for the worker and scheduler. The exact CLI command is verified in PR-4.
- **Web:** `prod-smoke.yml`, called by `deploy-api.yml` (job `smoke-web`) after `deploy-web` ships the web to Railway, runs Playwright `@prod` against `vars.NEXUS_WEB_URL`. It checks that:
  - the sign-in page renders;
  - `/backend/api/health/ready` reports healthy;
  - static assets load.
- **Later, on the Owner's word only:** a signed-in production smoke. It needs a production smoke user.

### 2.5 Tier E — nightly (02:00 UTC) + `workflow_dispatch`

**Runs:**
- the full API suite in both modes, unsharded (this also checks the sharding)
- the full ON ratchet over its whole scope
- factory tests, including the 8 files its config never collects (after a config fix)
- `stock-pool-rush` and `sync-load` on real PG
- the 39 legacy `tsx` tests
- the eBay consent check
- the full Playwright suite (after its `fixme` tests and live URLs are fixed)

**Browser gates:**
- They move to nightly once `seed-smoke.mjs` grows the studio fixture they need.
- Until then they stay manual: `npm run gates:browser`.
- This is UI coverage, not security.

**Marketplace sandbox tests:** none exist. A slot is reserved. It needs sandbox secrets.

**On failure:** the workflow fails, and GitHub emails the Owner.

## 3. Levers evaluated

| Lever | Use? | Saves (est.) | Risk | Rollback |
|---|---|---|---|---|
| Turbo remote cache (Vercel Remote Cache; the project is already linked) | Yes, for `build` and `typecheck`. PRs **read only** (`--cache=local:rw,remote:r`); only main writes. `test` and `@nexus/database#build` are `cache: false`: the latter writes tracked files and the Prisma client, which turbo cannot restore. | 1–4 min per job on a hit | A stale or poisoned output if an input or env var is undeclared. Declare `NEXT_PUBLIC_*`, `NODE_ENV` and the schema. Add `passThroughEnv` for test variables (turbo 2 strips undeclared env). | delete the `TURBO_TOKEN` secret |
| cancel-in-progress | PRs only | minutes and queue slots | none | one line |
| `node_modules` cache (key: lockfile + `patches/**`) | Yes. Then **always** run the database build (prisma generate + runtime) and the shared/events builds. The factory's `prisma generate` runs before its typecheck. | ~1 min per job | a stale Prisma client, prevented by the forced generate | remove the step |
| Playwright browser cache | Yes; `install-deps chromium` still runs | ~30 s per smoke shard | none | remove the step |
| `.next/cache` | Yes, measured before it is kept (Turbopack's build cache may be off by default) | 0–1 min | low | remove the step |
| PG with fsync, synchronous_commit, full_page_writes off, on tmpfs | Yes | 10–20 % of real-PG time | none (throwaway database) | drop the flags |
| **Template DB clone** | Yes, **one clone per test FILE, not per worker**. A per-worker database lets files see each other's rows. At 0.34 s a clone is cheap enough for every file. | PGlite: 2.3 s → 0.34 s × 53 files ≈ **1.7 CPU-min**. Real PG: `CREATE DATABASE … TEMPLATE nexus_template`, roles made once. | objects that span the cluster (roles) could leak, so per-file role names stay | env `NEXUS_TEST_NO_TEMPLATE=1` |
| Playwright sharding + storageState | storageState yes. 2 shards; if smoke takes < 2 min, go to 1. | sign-in once instead of per test | the sign-out test needs its own login | the matrix size |
| Skip the type step in CI `next build` | Yes, via a CI-only env flag. The Railway web build is unchanged. | ~1 min on the critical path | none while `checks` is required | remove the env var |
| Paid larger runners | **No.** Not available to a free personal account. | — | — | — |

## 4. Railway, schema rule, branch protection

### 4.1 Migrations in a Railway pre-deploy command

This is already built in commit `8b431c322`, on the unpushed branch:
- `preDeployCommand = ["npm run db:migrate:deploy"]`
- `startCommand = "node apps/api/dist/index.js"`

**It lands with Tier 0.** The Railway dashboard needs three settings:
1. `MIGRATION_DATABASE_URL` is set on the API service.
2. The worker and scheduler get their settings in Railway itself (Railway no longer lets a new service read a config file; see `tasks/architecture-operations.md`).
3. **Native GitHub autodeploy is off** on all 3 services. Otherwise each push gets two deploys and two migration runs.

These are Railway writes. They happen only on the Owner's word, or the Owner clicks them.

- **Risk:** a failed migration stops the deploy, and the old container keeps serving. That is the wanted behaviour.
- **Rollback:** the API's pre-deploy command is a Railway service setting (since 2026-09-26, when `railway.toml` was removed); change it in the service's settings.

### 4.1a Cutover runbook for #4 (written 2026-09-26; DEFERRED — fix the login bug in §6c first)

After #4, `RuntimePool` refuses any runtime login that owns objects or bypasses RLS, **in the API and the web**. Production still logs in as `neondb_owner`. So the new login, the variables, the services and the merge are **one** change. Do not do half of it.

**State already done (2026-09-26):**
- `MIGRATION_DATABASE_URL` is set on the Railway API (the direct host, `neondb_owner`).
- The Neon password is rotated everywhere.

**Steps, in order:**

1. **Neon SQL editor:** create the restricted login. Choose a strong password.

   ```sql
   CREATE ROLE nexus_app LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<new password>';
   GRANT nexus_workspace_runtime TO nexus_app WITH INHERIT TRUE;
   ```

   `WITH INHERIT TRUE` is required: the web reads `UserSession` as the login (measured in #5). `scripts/ci/seed-smoke.mts` creates exactly this shape, and #5's smoke job runs the API and the web on it.

2. **Railway:** create the `worker` and `scheduler` services from this repo.
   - Settings in Railway (build, start, health check, region); see `tasks/architecture-operations.md`.
   - Copy the API's variables.
   - Source: none. Deploys come from GitHub Actions.

3. **GitHub:** add the secrets `RAILWAY_WORKER_SERVICE` and `RAILWAY_SCHEDULER_SERVICE` (service IDs). `deploy-api.yml` refuses to deploy without them.

4. **Railway API, worker and scheduler:** set `DATABASE_URL` and `DIRECT_DATABASE_URL` to the `nexus_app` login (pooler host for `DATABASE_URL`).
   - Use `railway variables --set … --skip-deploys`, so the change waits for the #4 deploy. Main's code still migrates at start with `DATABASE_URL`, and a restricted login cannot do that.
   - Keep `MIGRATION_DATABASE_URL` on `neondb_owner`.

5. **Railway `nexus-web`:** set `DATABASE_URL` to the `nexus_app` pooler URL (today it references the API's, `${{@nexus/api.DATABASE_URL}}`, so step 4 already changes it). It applies on the web's next deployment.

6. **Railway:** disconnect the API service's native GitHub source, so each push deploys once and migrates once.

7. **Merge #4.** Deploy API runs `verify`, then:
   - Railway builds;
   - the pre-deploy step migrates with `MIGRATION_DATABASE_URL`;
   - the API, worker and scheduler start on `nexus_app`.

   Watch these:
   - `/api/health/ready` reports the release SHA;
   - the worker and scheduler report their new deployments.

**Rollback:**
- Railway: redeploy the previous deployment.
- Railway: set `DATABASE_URL` back to the `neondb_owner` pooler URL.
- Railway `nexus-web`: redeploy the previous deployment.
- #4 adds **no** migration folders (measured: 0 against main), so a rollback meets the same schema.

### 4.2 Expand/contract rule

This goes into `tasks/architecture-operations.md` and `CLAUDE.md`:

1. A release may only **add** schema: new tables, nullable columns or columns with defaults, new indexes, new enum values.
2. Code that stops reading a column or table ships first.
3. The drop, rename, type change or `SET NOT NULL` ships in a **later** migration. It waits until the release with no readers is live on API, worker, scheduler and web.
4. Rollback never undoes a migration. Each release must run on the next release's schema.

**Enforcement: `scripts/check-migration-expand-contract.mjs`**
- It has the usual ratchet shape: old folders are grandfathered, and new folders are held at zero.
- It flags:
  - `DROP TABLE`, `DROP COLUMN`, `RENAME`
  - `ALTER COLUMN … TYPE`, `SET NOT NULL`
  - `ADD COLUMN … NOT NULL` without `DEFAULT`
  - `DROP TYPE`, and removing an enum value
- A flagged statement passes only with a header: `-- contract: expands in <migration>, readers removed in <sha>`.
- A second rule refuses edits to migration folders that already exist on main.

### 4.3 Branch protection on `main` (free once the repo is public)

**Ruleset:**
- require a pull request, with 0 approvals (single owner)
- required checks: `ci-ok` and `db-security`
- **do not** require "up to date". There is no merge queue, and about 40 merges a day would force every open PR to rebase and re-run. Deploy's `verify` covers the merged tree.
- block force-push and deletion
- no bypass

**Impact:** agent sessions that push straight to main will be refused. They must push a branch and open a PR. Announce this before the ruleset goes on.

**Rollback:** disable the ruleset.

## 5. Coverage map — nothing security-critical is dropped

| Check | Today on main | After |
|---|---|---|
| RBAC deny-by-default coverage | nowhere (hook skipped) | **PR, always** (`postgres`) |
| Auth security suite | nowhere | PR, always (`api`) |
| Runtime-role / FORCE RLS on PG17 | nowhere | PR, always (`postgres`) |
| Real-PG race and RLS suites (13 when this plan was written, 55 on 2026-09-30) | nowhere | PR, always (`postgres`, split across its parts; db-security checks each passed once) |
| All PGlite tenant-isolation files | 2 folders only | PR, always, **both modes** (`api`) |
| Webhook signature, OAuth, crypto, SSRF, account-guard tests | nowhere | PR, always (`api`, whole suite) |
| Profiles-ON ratchet | nowhere | PR, always (`db-security`) |
| Model ownership, policy parity | nowhere | PR, always (`checks`) |
| Web proxy, paths and permission-gate tests | nowhere | PR, always (`checks`, whole web suite) |
| Baseline ⇄ schema, applied-but-missing | nowhere | PR, always (`postgres`) |
| Migrations applied to a fresh DB | nowhere | PR, always (`postgres`, upgrade path) |
| 45 static ratchets | nowhere | PR, always (`checks`) |
| Browser gates (UI) | hook, skipped | manual now; nightly after the seed grows |
| 4 catalogue suites (PIM, not security) | hook, skipped | manual, `npm run gates:full` |
| `database-target` (test DB guard), `amazon-publish-binding` | hook, skipped | made hermetic in PR-1, then in `api` |

## 6. Phase 3 — the order of work

Each PR is based on `main` and built in its own worktree, because other sessions share this checkout. Each PR body carries a before/after timing table from `gh run view --json jobs`. Nothing is pushed to main directly.

**Tier 0a — land the branch**
- Push `chore/architecture-reliability` and open its PR.
- After it merges, do the Railway dashboard steps (§4.1), on the Owner's word.

**Tier 0b — make the repo safe to publish, then make it public**
1. **Blocker:** the Neon production password is in 4 old commits (`c3cdd9efe`, `bda99343c`, `2fb3cc1cb`, `a31b2cebd`). It must be rotated **before** the repo is public.
2. A full-history secret scan (gitleaks, read-only). Every hit is rotated, or shown to be dead.
3. A scan of tracked docs and fixtures for customer data (for example `docs/audits/**`, rehearsal JSON).
4. Actions settings:
   - fork PRs need approval to run;
   - the default `GITHUB_TOKEN` is read-only;
   - no `pull_request_target` workflows.
5. The Owner switches visibility to public.

Until then, CI runs count against the private minutes quota.

**PR-1 — Tier C**
- **Commit 1:** add the RBAC coverage step to the current `ci.yml`, so that gap closes at once.
- **Then:**
  - the `ci.yml` rewrite
  - `turbo.json`
  - `scripts/ci/*`
  - the PGlite snapshot and PG template
  - the real-PG `--url` flag
  - the env-reading database tests
  - the ratchet fix and its CI baseline
  - the smoke seed and specs
  - the hermetic `database-target` and `amazon-publish-binding` tests
  - the expand/contract check
- **Positive controls.** Each is pushed as a throwaway commit on the PR branch, seen red, then dropped:
  - an unmapped route
  - a removed RLS policy
  - a test that fails only with profiles ON
  - a destructive migration with no header
  - an edited old migration
  - a smoke test whose nonce is missing

**PR-2 — Tier B:** pre-push becomes typecheck only, and `gates:full` is added. It merges **after** branch protection requires PR-1's checks.

**PR-3 — Tier A:** pre-commit with lint-staged.

**PR-4 — Tier D:** the deploy slim-down, production smoke, and `ci.yml` off `push: main`.

**PR-5 — Tier E:** the nightly workflow.

**Settings (Owner):** the branch ruleset (§4.3) goes on after PR-1 is green on main, and before PR-2.

## 6a. PR-1 result (PR #5, 2026-09-26)

**Before → after (GitHub Actions wall time)**

| | Before (`main`, 5-run median) | After (PR #5, run 3) |
|---|---|---|
| Wall time | 11.8 min, one job | **7.65 min**, 9 jobs in parallel |
| Runner | 2 vCPU (private repo) | 4 vCPU (public repo) |
| API tests | `src/services/pim` + 7 named paths, profiles OFF | **whole suite, 939 files, profiles OFF and ON** |
| Web tests | 3 folders | whole suite |
| Security gates | none on main (§0) | RBAC coverage, runtime-role RLS, real-PG races, ownership/parity, profiles-ON ratchet |
| Static ratchets | none | 50 |
| Migrations on a fresh database | never | every PR (upgrade check) |
| Browser | never | 7 `@smoke` journeys on a production build |

Job times in run 3: checks 5.7 · API 6.0 / 4.6 / 7.2 · postgres 2.4 · smoke 3.0 / 2.4 · db-security 0.3 min.

**Deliberate failures, each seen red**
- A new `DROP TABLE` migration.
- An edited shipped migration.
- A stray-column migration in the upgrade check.
- A test file that passed while skipping every test.
- An unmapped route (RBAC coverage named it).
- A new profiles-ON failure (ratchet).
- The smoke fence while the products page was 500.
- `ci-ok` and `db-security` on CI when API shard 3 failed in run 2.

**Not done: a removed RLS policy.** Claude Code's safety check refused a commit that plants a security fault. The API shards run every tenant-isolation test, and the upgrade check compares all 444 policies.

**Found and fixed while building it**
1. 5 API test files read `Marketplace` rows from the developer database. CI gives them a bootstrapped database with the market catalogue (`scripts/ci/prepare-test-database.mts`).
2. The web's control pool reads `UserSession` as the login, without `SET ROLE`. A restricted login therefore needs `GRANT nexus_workspace_runtime … WITH INHERIT TRUE`. **This is required for #4's production cutover.**
3. `pgrep -a` means `--list-full` on Linux, so the browser-gate aloneness witness counted 0 on every Linux machine.
4. A web date test asserts a Rome-local day. The web tests run with `TZ=Europe/Rome`.
5. A 13-business test needs its own 30 s timeout, as `vitest.config.ts` asks database tests to set.

**Changes from the plan**
- The PGlite template is done (per-file copy): 50 files went from 50 s to 31 s, and the API shards from about 6.8 to 4.6 min. The real-PG template and the runner's `--url` flag are **not done**: the runner still starts its own container. The real-PG suites take 102 s, so they are the next thing to speed up.
- Smoke runs on every PR, not only affected ones: minutes are free, and the gate is simpler.
- Smoke has its own config (`apps/web/smoke/`), not a project in `playwright.config.ts`. The live-site suite stays untouched.
- The API in the smoke job runs through `tsx`. The web is the production build.
- Smoke has 7 journeys. The cell-edit round trip is still to write.
- `database-target` is excluded, not rewritten: it reads the real `.env` files by design (R-VT-12).
- The Turbo remote cache is wired (`TURBO_TOKEN` secret, `TURBO_TEAM` variable) but **not configured**. Without them, turbo uses its local cache.

## 6b. PR-2 … PR-5 (2026-09-26)

All four are stacked on #5: **#6 → #7 → #8 → #10**.

| PR | Tier | Result |
|---|---|---|
| #6 | B pre-push | `turbo typecheck --affected`, **19 s** (was 8–9 min). A planted TS2322 fails it. The old hook is `npm run gates:full`. |
| #7 | A pre-commit | `lint-staged --no-stash` → the repo's fast gates. **4 s** for a `.ts` change. A planted raw hex is refused in 1 s. |
| #8 | D merge to main | Deploy drops its duplicate build and tests. The worker and scheduler must show a NEW successful deployment. `ci.yml` is off push-to-main. Read-only production web smoke on Vercel's Production `deployment_status` (needs `VERCEL_AUTOMATION_BYPASS_SECRET`). |
| PR-5 | E nightly | 02:00 UTC + manual. Covers: ci.yml on main; the whole API suite in one job without the snapshot (OFF + ON ratchet); 39 legacy runners (**39/39**); the real-PG load tests (rush 2/2, sync 1/1 at POOL_RUSH=20/BURST=50, AE4_LOAD=200); the eBay consent check. The factory config now collects its 8 design-system tests (**86/86**). |

**Found while building PR-5**
- The legacy runners had never run.
  - 37 of 39 passed at once.
  - `ebay-pushback` (5/5) and `channel-cancel` (9/9) pass, then never exit: the queue's Redis client holds them open. The runner stops a file 3 s after it prints its own all-green summary. A file that crashes on its own keeps its exit code. Control: a planted failure turns the runner red.
- My first runner killed only the `tsx` wrapper, and a hung test ran for 21 minutes. The runner now kills the whole process group.

## 6c. Re-based onto main, #4 deferred (2026-09-26)

Reading #4's own cutover notes (`tasks/architecture-operations.md` on its branch) showed two things:
- #4 moves every background job out of the API into new worker and scheduler services. It is a production migration with 5 open evidence items, not only a login change.
- **#4 has a bug.** Its notes ask for a `NOINHERIT` runtime login. But the web's control pool (`apps/web/src/lib/workspaces/server.ts`) reads `UserSession` as the login, without `SET ROLE`. With a `NOINHERIT` grant, every signed-in page is a 500 (measured in the smoke job). Fix it before any cutover. Either the control pool sets the role, or the login is granted `WITH INHERIT TRUE`, as the smoke job does.

The Owner chose "CI first, #4 later". The five tier PRs were rebuilt on `main` (Prisma 6) and re-measured there:

| Check on main's code | Result |
|---|---|
| Static gates | 50/50 |
| Typecheck, 8 workspaces | pass, 50 s |
| API suite, profiles OFF | **936/936 files**, 83 s locally |
| API suite, profiles ON | 37 files / 212 tests — the CI baseline, identical to the #4 measurement |
| Database package / RBAC coverage / real-PG (11 suites, now `--required`) | pass |
| Migration upgrade check (through `migrate-direct.mjs` run from `packages/database`, as `railway.toml` runs it) | pass; a stray-column control goes red |
| Smoke on a production build, restricted login | **7/7** |
| Pre-push / pre-commit controls | a TS2322 and a raw hex are both refused |
| Legacy runners / factory | 39/39 / 86/86 |

Changes needed for main:
- `prisma validate` gets a placeholder `DATABASE_URL`, because Prisma 6 reads `env()` to validate.
- Main's real-PG runner exited 0 on a skip; it gained `--required`.
- The upgrade check calls main's release script.
- The deploy workflow gained the `verify` gate. Main deployed without waiting for any check.

**Merge order**
1. #5
2. The ruleset on main requires `ci-ok` and `db-security`
3. #6, #7, #8, #10
4. #4 later: rebase it on main, fix the login bug, let the new CI check it, then follow §4.1a

## 7. Verification

- **Timings:** run `gh run list --workflow ci.yml -L 5` and `gh run view <id> --json jobs`. The target is a p50 under 10 min over the last 5 PR runs.
- **Test count parity:** CI files and tests, per mode, must equal local `vitest run` minus the named exclusions. `api-test-plan.mjs` prints both numbers.
- **Positive controls:** every gate in §5 must be seen red once (PR-1 list). A gate that has never gone red is not proven.
- **Concurrency:** a free account runs at most 20 jobs at once.
  - Since 2026-09-30 a `ci.yml` run starts 9 jobs at once: `checks`, 4 `api`, 2 `postgres`, 2 `smoke` (7 before).
  - A push to main starts up to 12: verify's 9, the 2 `images.yml` builds and deploy-api's `changes` (seconds).
  - So 2 PRs at once fit (18 jobs). A PR during a push to main (21) makes at least one job wait for a runner.
  - In the 15 green runs of 2026-09-29 (7 jobs per `ci.yml` run) no job waited more than 17 s for a runner.
  - Check a run's waits: `gh api "repos/{owner}/{repo}/actions/runs/<id>/jobs" --jq '.jobs[] | [.name, .created_at, .started_at] | @tsv'`. `gh run view --json jobs` has no creation time.
  - If jobs often wait for minutes, lower the matrix sizes in `ci.yml`: the `api` shards or the `postgres` parts. Each count is its matrix alone; the commands and db-security take it from there.
