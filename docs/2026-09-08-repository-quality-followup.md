# Repository quality follow-up — 2026-09-08

All changes remain uncommitted and unpushed. This continues the grid-guard cleanup in `2026-09-08-repository-grid-guards.md`; it is a record of the checks below, not a claim that every application workflow has been tested.

## Fixes

- **Theme guard correctness:** parse generated CSS with PostCSS, including selector lists. The old guard split only on `.dark {`, so it read a combined dark selector as light definitions. Resolve dark aliases in the dark context and shell aliases in the pin context; unchanged dark values need no pin. Two parser regression tests cover selector lists, comments, descendant overrides and later definitions. Guard thresholds are unchanged.
- **Theme consistency:** restore the nine missing light-shell information, tonal and selected-filter pins. Add `--nds-info-text-light`, use the dedicated information text role for Pill and Tag, and retain primary text for that role in dark mode. Shared token sources, generated CSS, primitive CSS, catalog specimens and documentation are mirrored in Factory. Controls retain their standard sizes.
- **Account enumeration:** catalog transfer account pickers use `listActiveConnections`. Response projections retain the original public fields. These are account lists, not ambiguous single-account selection; the connection-resolution audit now reports zero ambient lookups.
- **API boundaries:** move newly added database operations into the relevant domain services: product bulk editing, saved-view alert summaries, mapping editor lists/reviews, eBay family/media resolution, gallery assignments, DAM ID resolution, preset application/validation, scheduled deletion and workspace member listing. The bulk route keeps request context and HTTP error translation; the service owns validation, preview, atomic persistence, audit and formula recalculation. Existing ownership and compare-and-swap checks remain in place. Direct route calls are 3,432 against a 3,491 baseline, with no file above its limit.
- **Regression coverage:** preserve the real family-root helper in the eBay route mock, align four theme-upgrade expectations with the concurrently introduced workspace selector, and exercise schedule deletion against foreign ownership, active schedules, stale versions and concurrent changes.

## Verification

| Check | Result |
| --- | --- |
| Web production build | Passed, isolated output directory; compile 18.9 seconds |
| API production build | Passed, including shared/events builds and Prisma generation |
| Factory TypeScript | Passed |
| Web suite | 260 suites passed; 3,511 tests passed, 13 skipped |
| Focused API regressions | 28 suites passed; 368 tests passed, 4 skipped |
| Formula PostgreSQL integration | 13 passed against disposable PostgreSQL and the production writer |
| Security suite | 110 passed |
| Workspace/media PostgreSQL run | 48 passed, 2 skipped |
| Route permission coverage | 2,597 routes, 85 permissions, zero unmapped routes |
| Theme parser regressions | 2 passed |
| Theme pin guard / dark parity | 108 fresh pins; zero missing or drifted semantic pins |
| Generated Web and Factory tokens | Passed |
| Design-system/CSS guards | Conformance, fork drift, token resolution, raw controls, raw hex, radius, CSS parse/shadow, dark aliases, append-only gap record and API barrels passed |
| Grid guards | AG import boundary, stable options, grid kit and required modules passed |
| Other repository guards | i18n, links, P3 legibility, alias form, disabled controls, button vocabulary, help cursor, events, graph, context boundaries, clustered jobs and global exposure passed |
| Schema/migration drift | All 425 models covered; column check passed with its two existing SyncLog allow-list entries |

Browser checks used an isolated Next preview at `127.0.0.1:3189`, because the existing shared preview rendered static content but did not respond to interactions. The shared formula form accepted `=$brand & " Jacket"`, showed `Xavia Jacket`, and closed with Escape. Its Cancel/Apply buttons measured **28px** in both themes in the existing **320px** form specimen. Information Pill and Tag measured **8.39:1 light** and **11.23:1 dark**. With a dark document root, the legacy grid lab's body retained light information, tonal and filter values, which also provide the inherited scope for portals. Sample changes were reset, verification tabs closed and the temporary server stopped. No product records were saved for browser verification.

The CLI browser census/editor-timing/grid-chrome scripts were not run in this pass; browser checks above used the in-app browser. No full application-wide accessibility certification is implied.

## Shared-workspace and environment notes

The business-profile migration changed during verification. Initial errors included missing migration files, workspace unique selectors and missing workspace setup in the formula fixture. The concurrent migration work supplied those changes; final Web/API builds, migration checks and formula integration tests passed against the resulting shared tree. This session did not apply migrations to the catalog database.

The first production build stalled inside the sandbox during compilation. It was stopped, then rerun outside the sandbox with a new output directory and passed. Tests requiring a local socket/tsx IPC were similarly rerun with the necessary access. Existing previews and their build directories were preserved. The whole pre-push hook was not invoked, and nothing was staged, committed or pushed.
