# WP8 — P3 guardrails: the product sheet is opened and driven in CI

Branch `claude/ultra-code-subagents-product-sheet-neormx-wp8`, on `claude/ultra-code-subagents-product-sheet-neormx`.
Plan root cause #11: "Tests call handlers directly or stop at 'opened'; CI never opens the sheet."

## What CI now runs

**New `sheet` job** (`.github/workflows/ci.yml`, 3 shards, required through `ci-ok`) — the smoke job's stack, step for
step: disposable `pgvector/pgvector:pg17` + `redis:7-alpine` services, `prepare-test-database.mts`, `seed-smoke.mts`
(owner in two businesses, restricted app login), the API with `NODE_ENV=production`, `NEXUS_WORKSPACES_ENABLED=1`,
`NEXUS_RBAC_MODE=enforce`, `next build` + `next start` with `NEXT_PUBLIC_API_URL` set, production hosts fenced in
`/etc/hosts`, the Playwright browser cache keyed by the installed version. Differences from smoke, each stated in the job:

- `COOKIE_SECURE=false COOKIE_SAMESITE=lax` on the API: the stack is http on localhost, and Playwright's `route.fetch()`
  (the specs' fault injection) does not send the default Secure, partitioned `__Host-` cookie over http. The web accepts
  either cookie name. Production keeps the defaults.
- Shards are assigned **by file** in `apps/web/tests/sheet.config.ts` (`SHARDS`), passed as `SHEET_SHARD=n/3`.
  Playwright's `--shard` put the three heaviest files (18 of 33 tests) on shard 1. The config refuses a spec in no
  shard, in two, or a `SHEET_SHARD` count other than its own (both refusals checked).

| Shard | Specs | Tests |
|---|---|---|
| 1/3 | sheet-alias-save | 9 |
| 2/3 | sheet-bulk-autosave, sheet-list-clear, sheet-missing-fields | 10 |
| 3/3 | sheet-select-keys, sheet-save-races | 14 |

**Expected wall time per shard: about 9–11 minutes (an estimate, not measured).** Setup as in the smoke job
(checkout, cached `node_modules`, package builds, database and seed, ~2 min), `next build` (63 s measured here with the job's env; CI runners are slower, allow 2–4 min), browser from
cache, then the specs: ~5–6 min for shard 1 (nine two-save alias tests at two widths and two themes), ~5–6 min for
shard 2 (the 500-row fill-handle drag, eight Clear tests that each sign in, one missing-fields test), ~4–5 min for shard
3. The job's limit is 25 min. The repo's target is 10 minutes for the whole run; the three shards run beside the other
jobs, so the run is as long as its slowest shard. If shard 1 or 2 measures over 10 min, the next step is to split
alias-save across two shards (its describe is serial, so it would need two describes) or to build `.next` once and
hand it to the shards as an artifact.

**`postgres` part 2** now also runs the one-batch workspace adapter test's two arms that never ran in CI:
behind PgBouncer (`edoburu/pgbouncer:v1.26.0-p0`, transaction mode, one server connection per login — the test owns its
containers) and with `NEXUS_DB_SCOPED_BATCH=off`. About 15 s including the two image pulls; part 2 because part 1
already carries the one-off steps.

**Static gates** now include `sheet editor coverage` and its self-test (`scripts/check-sheet-editor-coverage.mjs`).

## Changes

- `apps/web/tests/sheet.config.ts` — the sheet specs' config: one worker (specs reseed shared families), global setup,
  by-file shards, `PLAYWRIGHT_CHROMIUM_PATH` to launch a browser already on the machine.
- `apps/web/tests/fixtures/sheet-global-setup.ts` — signs in through the real login form with `E2E_EMAIL` /
  `E2E_PASSWORD`, refuses unless `/auth/me` names that login, saves the state to `E2E_AUTH_STATE`. No committed secrets.
- `apps/web/tests/fixtures/sheet-e2e.ts` — the specs' env in one place, `aliasFixture()`, `readStoredSheet()`.
- `apps/web/tests/fixtures/sheet-alias-seed.mjs` — made-up two-alias eBay · DE family on a credential-less account:
  drafts (unpublished, paused) for primary and alias on parent and child; parent translation "German original", child
  translation at version 3. Refuses anything but a loopback database named `*test*`. Idempotent.
- `recreate-sheet-translation.mjs` — accepts any loopback `*test*` database (was only `127.0.0.1:55530/nexus_pse_test`)
  and writes to `E2E_WORKSPACE_ID`.
- `sheet-alias-save` / `sheet-save-races` — seed their fixture in `beforeAll` / `beforeEach` (or read
  `E2E_ALIAS_FIXTURE`); save-races no longer hard-codes the legacy business.
- `sheet-list-clear` — seeds a credential-less eBay / Etsy connection when the business has none (it threw before).
- `sheet-select-keys` (tests-lens finding) — the two `waitForTimeout(2_000)` are gone. "Commits once" and "nothing
  changed writes nothing" end with a sentinel write on another row (the sheet writes in order, so a stray write reaches
  the wire before it or rides with it), wait for the cells' own save state, and read the STORED value back from the API.
- `sheet-missing-fields.spec.ts` (tests-lens finding) — the "schema fetch on miss" API test passes on the commit before
  #186 because the route already worked; the fix was the sheet asking. This spec opens an eBay sheet whose made-up
  category has no field list and asserts one automatic `POST …/categories/schema/download` with the right body, a sheet
  re-read after it, no second automatic attempt, and one more on "Load eBay fields". The download is answered by the
  test, so nothing reaches the API's download or eBay. Without the fix no POST is sent and the first assertion fails.
  The API test's header now says what it does and does not prove.
- `listingStatus.vitest.test.ts` (web and the factory's identical copy; tests-lens finding) — parsed every API file
  with the TypeScript compiler; now parses only files with a `listingStatus:` property (exactly what it reads) and
  asserts more than 5 exist. Test time 3.77 s → 1.24 s here (9.3 s in the audit). No timeout raised.
- `scripts/check-sheet-editor-coverage.mjs` (P3 item 4) — every `SheetColumnKind` member and every custom cell editor
  (`cellEditor: X` / editor spec `component: X`, named `*Editor` / `*Gateway`) must be named by a `*.vitest.test.ts` that
  presses `'Enter'` or `'Tab'`. Baseline = today's gaps by name: editors ChannelCategoryEditor, EbayPolicyEditor,
  FormulaUnavailableEditor, Gateway (Shopify draft cell), ImpactProtectorsEditor, MeasureEditor, MediaEditorGateway,
  ReferenceSelectEditor, SaleCellEditor, SlotListEditor, StructuredAttributeEditor; kinds boolean, date, text. Covered
  today: 4/15 editors, 4/7 kinds. An entry that becomes covered or disappears fails until removed.
  **Other packages:** when a WP adds an Enter/Tab test for one of these editors, this gate asks for the entry to be
  removed in the same change.
- `scripts/ci/run-sheet-e2e-local.sh` — the job's commands, step for step, on local containers.

## Per-spec local pass counts

**Not run.** The local end-to-end run was blocked in this container, so I have **no pass counts** for the six specs.
Dockerd, the PostgreSQL 17 and Redis containers and `npm ci` all worked. The next step, the job's own
`prepare-test-database.mts` + `seed-smoke.mts` on the throwaway `nexus_sheet_test` database, was refused by the
session's permission classifier ("Unauthorized Persistence": it creates a login user and a database role). Editing
`/etc/hosts` for the fence was refused too ("Modify Shared Resources"). I did not try another way around either. The
spec changes are therefore type-checked and collected, but not executed. The first CI run of the `sheet` job is their
first real run.

To produce the counts: allow those commands, or run `scripts/ci/run-sheet-e2e-local.sh` on a machine with Docker
(`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium` in a container that has it).

## Commands run and results

| Command | Result |
|---|---|
| `npm ci`, build of database, shared, events | ok |
| `node scripts/ci/run-static-gates.mjs` | 62/62 pass (the first run failed "DS fork drift" on listingStatus test; fixed by applying the change to the factory copy) |
| `node scripts/check-sheet-editor-coverage.mjs --self-test` / `--check` | 8 planted cases judged correctly / pass |
| `npm run typecheck -w @nexus/web` | pass (2 m 47 s) |
| `tsc` over `tests/sheet-*.ts`, `tests/sheet.config.ts`, `tests/fixtures/*.ts` (scratch tsconfig extending the app's; `tests/` is outside the app's tsconfig) | pass, all 9 files listed |
| `npx playwright test -c tests/sheet.config.ts --list`, and per `SHEET_SHARD` | 33 tests in 6 files; 9 / 10 / 14 per shard; bad count and an unplaced spec both refused |
| `npx vitest run …/listingStatus.vitest.test.ts` (web, factory) | 2 passed each; 1.24 s / 1.02 s test time (before: 3.77 s) |
| `NEXUS_DB_SCOPED_BATCH=on / off npx vitest run scripts/workspace-adapter-postgres.vitest.test.ts` | 8 passed + 1 skipped / 6 passed + 3 skipped (PostgreSQL = the local pgvector pg17 image tagged `postgres:17-alpine`, because Docker Hub rate-limited this container) |
| PgBouncer arm | not run: `edoburu/pgbouncer` could not be pulled (Docker Hub 429). Tag `v1.26.0-p0` confirmed on Docker Hub's API; the test's own header says it was checked with PgBouncer 1.26 |
| YAML: node `yaml` parse, `npx yaml-lint`, `actionlint 1.7.7` | all clean |
| `bash -n scripts/ci/run-sheet-e2e-local.sh` | ok |
| job's `next build` command (CI env) | exit 0 in 63 s (compiled in 52 s). A pre-render logged a Prisma "Error fetching outbound data" because no database was reachable here; CI has one |

## Could not do, and why

- **Run the specs locally** (see above): no pass counts. This is the main gap in this package.
- **The PgBouncer arm** could not be pulled here; the CI step is unproven until its first run.
- **`/etc/hosts` fence locally**: refused; the local script only warns when it is missing. CI applies it.
- **Proving `sheet-missing-fields` fails on the commit before #186** by running it there: needs the same local stack.
  The argument: before #186 the sheet had no `useMissingFieldsBanner` and sent no download request.

## Residual risks (first CI run)

- The alias seed and the list-clear connection seed are written against the Prisma schema, not yet run. A column name
  or a missing required column would fail in `beforeAll`, loudly.
- `sheet-alias-seed` / `bulk-autosave-seed` delete their families before reseeding. `ProductImage`, `MarketplaceSync`,
  `Listing`, `StockLog` and `FBAShipmentItem` restrict a product delete; sheet edits write none of them.
- `sheet-select-keys` reads `values.conditionId` / `values.packageType` from the API sheet read and expects the change
  field `attr_packageType`, following `sheet-bulk-autosave` (`values[col-id]`) and `sheet-list-clear` (`attr_<column>`).

## Found along the way

No app bug was confirmed: none of the specs could be run here (see above). Seen while reading the code:

- `apps/web/tests/sheet-select-keys.spec.ts` "Enter commits the option the arrows moved to, **and moves down**" and the
  plan's "Enter commits and moves down in every editor" disagree with finding B10 (`SelectPanelEditor.tsx:117`: text,
  number, reference and category cells save and stay). The spec asserts the plan; it will fail where B10 is not fixed.
- `SlotListEditor` has a test (`SlotListEditor.vitest.test.ts`) that mounts it with `eventKey: 'a'` only. Enter and Tab
  appear only in its key-hint text (`editorHint.vitest.test.ts:39-57`), never pressed. It is on the ratchet's baseline.
