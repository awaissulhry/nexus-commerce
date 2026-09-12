# Product formula quality verification — 2026-09-07

This completes the reliability and usability follow-up to the September 6 review. The work is local, uncommitted and unpushed. Existing workspace changes have been preserved. This report supersedes the earlier report's missing history/recovery limitations.

## User-facing behavior

- Typing `=` after double-clicking a writable scalar cell opens formula guidance immediately. Clicking another field in the same product row inserts a named reference. The grid, drawer and bulk form share completion, preview, Insert field and Add text. Enter applies; Escape dismisses the current suggestion/text helper before cancelling the editor. Invalid expressions remain editable.
- `===` and `!==` provide exact, case-sensitive, type-sensitive comparisons. `&` joins text, and Add text quotes and escapes it. Previously saved comparison operators retain their existing meanings. Expressions over 16,384 characters are refused with a clear error.
- Apply formula to selected products defaults to applying calculated values once. Keeping formulas linked is an explicit choice. Brand and Manufacturer can be transformed in bulk; a one-time formula can read the field it replaces. Linked self-references are refused as cycles.
- Formula history in the sheet's More menu shows the latest 20 operations for the product family, user and coordinate. It supports inspecting results, continuing interrupted apply/undo and undoing an operation after refresh. Alternate account views do not expose primary-account history actions.
- Apply uses one client-generated operation ID. Retrying a request after a lost response resumes the same operation. Each request processes at most five products; closing the dialog stops scheduling subsequent requests while the current request can finish. Persisted progress is available when the dialog is reopened.
- Undo restores prior storage, inheritance/follow flags and formula metadata, preserves unrelated edits, and refuses to overwrite a newer target value. A restored valid linked formula recalculates using today's source values. Restored Master inheritance also refreshes following channel snapshots using the current parent content. Unattempted rows are reported as not applied, never as restored.

## Persistence and scope

Each row's ordinary product write, formula/dependency metadata, audit receipt and progress cursor commit in one Serializable database transaction. Immutable operation headers and append-only per-row receipts avoid rewriting a growing snapshot for every product. Database locks serialize duplicate clients; a new transaction checks for an existing receipt before classifying a failed response. Derived cache refreshes run after commit and are deduplicated. Authentication is forwarded through the internal ordinary writer, which still performs normal permission checks.

Formulas use named fields within the same product row. They intentionally retain the existing primary listing/account coordinate: named aliases and alternate accounts require literal overrides until formula persistence supports those identities. Structured values and read-only fields retain their ordinary writer restrictions. Existing unattributed listings with a previewed version are updated by listing ID, avoiding Prisma's unsupported null account in a compound unique key. Creating an unattributed listing through other legacy upsert paths remains outside this change; the existing `compound-unique-null.vitest.test.ts` records that platform limitation.

## Accessibility and browser evidence

Shared `Modal readable` / `nds-readable`, `SegmentedControl wrap`, `DataGrid keyboardScroll` and `ListboxPanel ariaLabel` are documented and mirrored in Web and Factory. Modal makes background content inert, contains keyboard focus, supports nested dialogs, respects explicit initial focus and restores the opener. Reference text retains its original color association through an underline while using a stronger text color.

Density correction later on September 7: user review rejected the wrapper's enlarged controls. `nds-readable` now affects contrast and focus only, preserving the chosen Nexus control size and input typography. The historical 44px target measurements below describe the earlier build, not the current design contract. Standard/readable catalog dimensions now match in both themes, and 1,630 Studio/formula-editor regressions pass. See [the Media follow-up](2026-09-07-ebay-media-rebuild.md) for current measurements.

Actual browser checks covered:

- Double-click Title, type `=`, click Brand, add ` Jacket`, save `=$brand & " Jacket"`, reopen the expression, and cancel. These writes used synthetic catalog rows.
- Apply Manufacturer, reload the page, reopen saved history, undo, and verify the original value through the real feature and disposable PostgreSQL API. This found and fixed empty POST requests incorrectly declaring a JSON body.
- Tab containment, nested Escape handling, initial formula focus, opener restoration and removal of background inert state on close.
- Real 320px and 768px iframe viewports in both themes, wrapping actions and vertical body scrolling. The measured initial form/guidance states had no horizontal dialog/body overflow, no measured enabled target below 44px, and minimum text contrast of 9.87:1 in light and 11.81:1 in dark. See `2026-09-07-formula-browser-metrics.json` for the recorded measurements.

These checks establish specific usability, contrast and keyboard behavior. They are not a complete WCAG AAA conformance certification or a screen-reader/device matrix. All product mutations used the disposable database; live catalog values were only previewed. The catalog sample was reset and the disposable servers stopped after verification.

## Automated verification

- Web: 251 suites, 3,436 tests passed.
- API formula, expression, ordinary writer and authentication regressions: 27 suites, 346 tests passed.
- Real PostgreSQL integration: 13 cases passed, including lost-response replay, interrupted apply/undo, duplicate clients, stale previews, rollback when receipt recording fails, inherited storage, current parent content in channel snapshots, restored linked expressions, channel/alias isolation, authentication/actor retention and post-commit effects. The fixture uses generated production Prisma models and real routes/services; external queues and derived cache refreshes are replaced.
- A separate 1,000-product run passed with exactly one applied receipt per product and at most five product results per continuation request. Preview took 1,509ms and apply 22,409ms in local in-memory PGlite; these are fixture measurements, not production latency guarantees.
- Web, API and Factory TypeScript checks passed. Generated token checks passed in both apps. Web token guard, raw primitive ratchet, DS conformance, DS-GAPS append-only and whitespace checks passed.

## Unrelated workspace checks

The Factory token guard reports 54 legacy platform-token aliases in `styles/patterns.css`. The shared-source fork guard reports the existing SourceIndicator export-order difference in `components/index.ts`. The CSS shadow ratchet reports 32 selectors in the unrelated `app/design/grid-lab/legacy/workspace-grid.css`. Formula shared source/styles are mirrored; none of these guard findings is a new formula control rule. Broader concurrent workspace work may change these counts.

## Reproducing the isolated workflow

Run these from the repository root in separate terminals. The fixture backend creates an in-memory PostgreSQL database from the checked-in Prisma schema and requires a local socket; it never connects to the catalog database.

```sh
FORMULA_BROWSER_FIXTURE=1 npm run test:watch --workspace=@nexus/api -- --watch formula-database.vitest.test.ts
```

Wait for the disposable API readiness message on port 4115, then start a separate development build:

```sh
FORMULA_BROWSER_FIXTURE=1 NEXT_PUBLIC_API_URL=http://localhost:4115 NEXT_DIST_DIR=.next-formula-qa npm run dev --workspace=@nexus/web -- --port 3101
```

Open `http://localhost:3101/design-system/formula-workflow` or its `/responsive` child. The routes are opt-in development specimens; the normal application and production do not expose the workflow fixture. Stop both processes after use; the database is discarded. The large-selection verification can be repeated with:

```sh
FORMULA_BENCHMARK=1 npm run test --workspace=@nexus/api -- formula-database.vitest.test.ts
```


Repository guard follow-up (2026-09-08): the previously reported fork/token failures are resolved in the current workspace. The legacy grid-lab selector/radius failures and additional grid import, callback identity and retiring-grid findings are now fixed. See [the guard cleanup report](2026-09-08-repository-grid-guards.md) for the current results and verification scope.
