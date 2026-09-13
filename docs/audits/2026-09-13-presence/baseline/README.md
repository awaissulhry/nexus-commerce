# Presence programme baseline — PR.1

Measured 2026-09-13, 16:30–16:38 UTC. Every baseline instrument log records its command, CWD, time, load and exit code captured through file redirection. No baseline was raised and no shared file was stashed/reverted. API environment: local Docker `127.0.0.1:55439/nexus_development`; static instruments read source only. The studio suite uses `NEXT_PUBLIC_API_URL=http://127.0.0.1:1 PES3_API=http://127.0.0.1:1`.

| Instrument | Measured | Exit |
|---|---|---:|
| grid-kit ratchet | DS DataGrid 34 vs 32; all 34 paths in `grid-kit-importers.log` | 1 |
| wire-null-defaults | **29 vs 17**, all 29 rows in its log (proposal expected 28) | 1 |
| ds-dts-fresh | **14 of 253** stale; full list in its log | 1 |
| route-prisma | assets 62→64; brand-story 32→33; catalog-transfer 0→2 | 1 |
| route-prisma census | full census retained | 0 |
| studio vitest, hermetic | **121 files passed; 1692 tests passed, 13 skipped** (1705 total), no failures | 0 |
| web tsc, private build-info | no diagnostics | 0 |
| api tsc, private build-info | no diagnostics | 0 |
| swatch bare / check | selector-list dark block accepted | 0 / 0 |
| swatch deliberately red | scratch `--nds-grid-bg: #6366f1`; Indigo foreground equals background → 1:1; 7 enforced failures | **1 expected** |

The studio result differs from the proposal's six failures in two files: those failures are absent from this reading. The first sandbox run could not bind the `masterWrite.deadport` local listener (EPERM); it is preserved at `/private/tmp/nexus-pr1-presence/studio-vitest-sandbox.log`, and is not counted as a product failure. The exact hermetic suite was rerun outside the sandbox to obtain the reported result.

## Ratchet attribution

`grid-kit-importers.log` derives the exact matcher used by the instrument and intersects the output with `git status --porcelain`. Of the 34 listed importers, three are dirty: `design/grid-lab/GridLabClient.tsx`, `products/listing-readiness/page.tsx`, `_studio/channel-ops/ReadinessPanel.tsx`. Inspection of their diffs shows the GridLab DataGrid import already exists in HEAD; its new Matrix scenario does not add a retiring import. The two increases are `listing-readiness/page.tsx` (DataGrid newly added in the LX language-axis rewrite; final LX notes discuss that page) and the untracked studio `ReadinessPanel.tsx` (PR.7 owns its migration). Clearing only the studio importer leaves 33, still one above 32. Dirty AND listed is only the initial suspect set; the diff attributes the increase.

The route-prisma reds all predate PR.1: `brand-story.routes.ts` adds `prisma.brandStory.findMany` to detect an existing normalised language in POST `/brand-stories` (LX reader-switch claim, ledger's 2026-09-12 Step 3 integration). `assets.routes.ts` and `catalog-transfer.routes.ts` are likewise dirty/listed and recorded by MX.1's closing run. PR.1 adds no direct Prisma query in its guard changes. Full route census retained; thresholds unchanged.

The new swatch parser is tested without editing shared tokens: copy `tokens.css` into `/private/tmp/nexus-pr1-presence/tokens-seeded-red.css`, replace the FIRST `--nds-grid-bg: var(--nds-surface);` with `--nds-grid-bg: #6366f1;`, then run the command recorded in `swatch-seeded-red.log`. The unchanged file is the positive control and passes both bare and `--check`. Dark/state-tint failures remain advisory under the instrument's existing policy; PR.1 did not change its enforcement scope.

## Wave 0 security evidence

`w0-security.log`: local-env, mocked Prisma/channel reads; 46 tests passed across the in-file route guard probes, manifest order, session-cookie actor resolution and bulk/restore regression tests. `rbac-coverage.log`: 2685 registered routes, 88 permissions, 71 PUBLIC, zero UNMAPPED, exit 0. That registration-only checker does not invoke routes or connect to the DB, and root CWD resolves the production env, which is why it is not used to run API tests.

`actor-sites.log` records the post-fix non-test literal census, with `actor-control.log` as its positive control. The remaining files are outside PR.1 ownership and have individual ledger REQUEST lines; the test inspects the guarded hard-delete audit's actual session user. `etsy-retirement.log` proves no broken method definitions/callers remain and shows four surviving read-method declarations as its positive control.
