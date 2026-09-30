# WP4 — Readiness and page-load prefetch (audit B01 B02 B03 B04 B06)

Branch `claude/ultra-code-subagents-product-sheet-neormx-wp4`, based on `25725970`.

| id | outcome | commit | test | notes |
|---|---|---|---|---|
| B01 | fixed | 97afc2f3 | `readinessRefresh.vitest.test.ts` "one read per scope (B01)" | A channel scope has one readiness read. Every refresh (save, Reload, Refresh progress, live event) re-runs the read effect. The effect's cleanup aborts a read already in flight, so a read that started before a save can no longer land after the one asked for it. The coordinate read, `coordinateNonce` and the merge are gone. |
| B02 | fixed (see budget note) | 97afc2f3 | `readiness-only-coordinate.vitest.test.ts` "readiness for the open channel scope (audit B02)" (PGlite); `product-studio-sheet-wire.vitest.test.ts` "…only=scope…"; `readinessRefresh.vitest.test.ts` "readinessUrl (B02)" | New `GET /readiness?…&only=scope`. It returns every chip of the market (Shared and each channel, without field lists; those lists are no longer read from the index for chips) plus the open coordinate's matrix entries, every language, in the server's order. The page uses it on a channel scope for load, Reload, Refresh progress, after a save and on live refresh. Shared keeps the family read, because its sheet has a progress column per coordinate. Consumers checked: scope menu chips and the Shared dot (`scopeItems`/`sharedReadiness`: all chips present); the Variants projection (open coordinate only); the Errors tab `ReadinessPanel` (now shows the open destination's languages, and its copy says so); the master sheet (master scope only, still the family read). |
| B03 | fixed | 05ea4315 | `studioPrefetch.entry.vitest.test.ts` | The provider resolves the remembered market and languages from its first render; before, it read the default first and threw that read away. It also remembers each business's scope choices (markets, default market, primary language, per-scope languages, primary accounts). The prefetch completes a silent URL (product list, catalog, listings, search, legacy `/edit` redirect, listing links without a language) by the same rules. Adoption still needs the exact URL, and now also the same business and never a different signed-in user. List links unchanged (40+ call sites; they cannot know the market). |
| B04 | fixed | 3124ba80 | `studioTabs.vitest.test.ts` "a tab that fails to load stays a tab (B04)" | Each tab renders inside its own error boundary, keyed like the tab. "Reload tab" rebuilds the tab's `next/dynamic` component so the import runs again; "Reload page" is there for a deploy. Checked live: chunk requests blocked → the studio frame stayed and the tab showed "Media could not be loaded"; after unblocking, "Reload tab" loaded it. |
| B06 | fixed (by removal) | 97afc2f3 | `readinessRefresh.vitest.test.ts` "the matrix keeps the server's order (B06)" | `mergeCoordinateReadiness` is deleted: every answer replaces the previous one whole and keeps the server's sort. Its unit tests were removed with it, and the tests above replace them. |

Every new test failed on the previous code; I checked by swapping the old files in and running them.

## Before / after numbers

**Index fixture (PGlite, 4 products × 6 coordinates × 60 optional fields; family vs `only=scope` answer on eBay IT):**
- Raw: 211,362 B → 23,343 B.
- Gzip: 4,618 B → 1,784 B.

**Live local stack** (subagent run):
- Setup:
  - PostgreSQL 17 in Docker, CI smoke seed, `bulk-autosave-seed` family of 20 variants with a credential-less eBay IT connection.
  - Readiness index built by `reconcileFamilyReadiness`, then padded to 60 optional fields per product on Shared/it and eBay IT/it.
  - `next dev` with StrictMode.
  - API HTTP only (no worker, no scheduler), profiles and RBAC on.
- BEFORE = the 7 web files from `25725970`; the API was the same for both. Two reps each.
- Aborted requests are counted as calls.

| Scenario | Calls on load BEFORE → AFTER | Readiness on load BEFORE → AFTER |
|---|---|---|
| Bare link, first visit (master) | 30 (6 aborted) → 30 (6 aborted) | family read, 1,111,599 B → same (Shared scope keeps the family read) |
| Bare link, returning visit | 30 (6) → 29–30 (5) | same |
| Channel scope eBay IT | 28 (4) → 28 (4) | **1,258,549 B → 154,953 B** |
| Readiness after a save (eBay IT) | – | **903,343 B → 73,150 B** |

**Bytes of all successful responses on load:**
- eBay IT: about 1.39 MB → 283 KB.
- Load plus one save: about 2.39 MB → 455 KB.

**B03 on the returning visit:**
- BEFORE: the sheet read started at about 2.0 s, after readiness, and was aborted and restarted.
- AFTER: the sheet read starts at about 1.2 s, beside the frame's reads, and is adopted with no aborted twin.

**First visit in a browser:** unchanged. Nothing has been remembered yet, so there is nothing to complete the URL from.

**Waterfall depth** (timing-based, noisy upper bound): 5–7 in both runs.

**Time to first row:** 2.9–3.8 s in both runs, within noise (±400 ms in dev). In both runs the first row appears when `POST pim/formulas/batch` and `ai/drafts` finish, not when the sheet read does.

**Budget honesty:**
- *≤ 15 calls:* not met — 28–30 in dev, and these commits do not change the count. Most of the extras look like StrictMode double mounts (duplicate connections, pim/family and saved-views calls, aborted twins); a production build should be measured before judging the budget.
- *≤ 50 KB readiness on a channel scope:*
  - Fixture: met (23 KB raw).
  - Padded local family: 155 KB raw. That is one coordinate × 21 products × 60+ optional-field lists, which the Variants projection's progress cells need (`optionalEmpty === null` paints them "unknown").
  - GALE: needs a production measurement (compressed vs raw). If the budget is raw bytes, the next step is to send `optionalMissing` as field keys with one label table, or only for the selected language.

## Commands run
- `cd apps/api && DATABASE_URL=postgresql://postgres@127.0.0.1:5432/nexus_test npx vitest run src/services/pim/readiness src/services/pim/scope-readiness src/routes/product-studio-sheet-wire src/routes/product-workspace-scope src/routes/product-studio-account --maxWorkers=2` → 15 files, 109 passed, 2 skipped.
- `cd apps/web && npx vitest run src/lib 'src/app/products/[id]/edit/_studio'` → 207 files, 2,583 passed, 13 skipped (before B04's tests were added; `studioTabs` 5/5 after).
- `npm run typecheck -w @nexus/web` → pass. `npm run typecheck -w @nexus/api` → pass.
- `node scripts/ci/run-static-gates.mjs` → 59/60.
  - The migrations gate failed only because `origin/main` is not fetched in this checkout.
  - `NEXUS_MIGRATION_BASE=25725970 node scripts/check-migration-expand-contract.mjs` → pass (0 new folders).

## Touched outside my file list (minimal)
- `channel-ops/ReadinessPanel.tsx`: two copy lines and a doc comment. The tables now show the open destination only.
- `apps/api/src/routes/product-studio.routes.ts` (readiness route) and `product-studio-sheet-wire.vitest.test.ts` (readiness block only): accept and test `only=scope`.

## Found along the way (not fixed)
- `apps/web/src/app/products/next/FamilyFooter.tsx:77-84`: the product list reads the whole family readiness (`?market=` only; 11–13 MB raw on GALE) for every expanded family, just to count `variationSource` over the matrix. A dedicated count, or `only=scope`-style narrowing, would save it.
- `sheet/channel/useChannelSheetAdapter.tsx:133-146` (WP2): the `readinessForFamily` / `{ coordinate: true }` choice is now redundant. `ReadinessRefresh` accepts the option and ignores it, because on a channel scope every refresh is already the open scope's read. WP2 can simplify it.
- Live run, both BEFORE and AFTER: on a channel scope every request started around 1.9 s (including 12-byte saved-views reads) ended together at about 3.1 s, while readiness was computing. The API process seems to serialise behind the readiness read. This is inferred from timings, not profiled.
- Live run: `GET /api/ebay/policies` answers 500 for a connection without credentials ("has no credentials"). A named refusal would read better than a 500.
- A bare link on the seeded business opens market DE with Shared language `it`, because `defaultMarket` breaks the channel-count tie alphabetically. Unchanged; it is the documented fallback.
