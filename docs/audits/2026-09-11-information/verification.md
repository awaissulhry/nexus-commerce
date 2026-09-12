# Verification evidence and limits

## Automated checks

| Check | Result |
| --- | --- |
| Relevant API suites | [55 files / 486 tests passed](evidence/api-tests.log): mapping/formulas, provider specifications, Information database routes, locale/reset semantics, safe migration, Etsy resources, seller/reference caches and Shopify integration/sync/reference behavior. |
| Focused regressions | Shopify status correction: 23 passed; final conditional requirements/routes: 72 passed; required-view chips: 53 passed; final Etsy category integration and Amazon schema check: 25 passed, including one new mixed-category case after the full run. The final schema-only check passed 13 tests. Focused counts overlap the full totals. |
| Relevant web suites | [72 files / 876 tests passed](evidence/web-tests.log), including typed editors, writer failures, dead-port recovery, view presets, destination state, Shopify drafts and provenance. |
| Type checks | [API](evidence/api-types.log) and [Web](evidence/web-types.log) passed. Shared package built and Prisma client generated. |
| Tokens and shared controls | Web/Factory generated tokens, token guard and DS fork drift checks passed. New RecordListInput and catalog examples were compared directly between Web and Factory because tracked-file guards do not fully cover untracked additions. |
| Connected local-sheet test | 13 passed, also included in the final 876 web tests. Uses actual GALE/eBay/IT on port 8091. Initial failure from missing formula columns was fixed by the guarded local development migration. |
| Existing browser grid guards | Grid chrome conformance and workspace parity reported **SKIPPED / NOT MEASURED** because their expected grid-lab server on port 3000 was unavailable. Their logs are not passes. |
| Existing contrast guard | Stops while parsing an outdated `.dark` selector in token CSS; [log](evidence/contrast-guard.log). Representative colors were measured separately. |

Initial loopback test failures from sandbox socket restrictions passed when rerun with the required permission. Earlier API expectation failures were corrected to test the new history payload and canonical-owner protection. The final conditional route test also exposed an incorrect exemption of all listing-owned fields from requirements; ordinary Information listing fields now validate, while pricing/inventory/media assembly and Shopify owner projection retain their existing boundaries. Its typed list payload was corrected to the schema contract. A final Etsy check confirms that one row with no category remains incomplete even when sibling listings have a valid category, and its error targets the existing selector. The final full run is green.

## Actual requested localhost page

The browser was also used on [the exact GALE Information URL](http://localhost:3000/products/cmokmy3a40078pm0p1fvnu523/edit/studio?market=GLOBAL). The web app points at API 8091; `apps/api/.env` selects the isolated local development database on port 55439. Root production credentials were not used for mutations.

The initial missing CellFormula columns caused Information reads to return HTTP 500. Applying only the guarded, reviewed local migration fixed the actual page. A second integration defect rejected an environment-managed Amazon account in single-profile mode; it now uses the database's established workspace resolver, with cross-workspace and seller-mismatch tests retained. Requiredness is evaluated with the same Amazon schema branches before and after filling a field, and the actual sheet's Required preset and completeness use that result.

Observed Shared, Amazon IT/DE, eBay IT, Shopify GLOBAL and Etsy GLOBAL reads each returned all 21 GALE rows. The final [actual field record](evidence/actual-page-capabilities.json) contains the applicable fields, destination/owner routing and schema/error states. [Amazon actual screenshot](evidence/gale-amazon-actual.png) shows blocked validity alongside population counts; [German Shared DOM](evidence/gale-shared-german-actual.txt) marks requested de versus effective it/en content. eBay's primary and additional account were switched in the real UI and retained distinct values; see [additional account DOM](evidence/gale-ebay-second-account-actual.txt).

No GALE product values were edited. GALE has no selected Etsy category or persisted Shopify remote owner, so its real-page checks cover base Etsy and unlinked Shopify Information. Linked Shopify and Etsy category-property mutations, and multiple named aliases per account, were exercised in the controlled fixture below. Amazon Belgium returned access denied from the provider and the UI exposed requirements as unavailable; it was not counted as a successful schema load. API watch restarts during source changes temporarily interrupted reads; final captures were repeated after the server stabilized.

## Controlled database and browser

`information-database.vitest.test.ts` uses disposable PostgreSQL through PGlite with the real Prisma models, common sheet, formula/global/bulk routes and Shopify cell writer. External queue effects and provider network reads are stubbed. It seeds a family with a parent/two children, four channels, two accounts per channel, primary/two named aliases and multiple locales. Separate formula database tests cover 12 independent Etsy formula destinations, replay, restore, conflicts and recalculation. No canonical products are duplicated for aliases.

The browser fixture runs the real `StudioClient`, shared sheets, Nexus controls and real disposable API. Only authentication/navigation, provider reads and unrelated saved-view/AI services are controlled. `server.mjs` can deliberately lose the response after committing a save or delay a sheet read. [Captured writes](evidence/browser-writes.json) retain their exact destination payloads; formula read batches are omitted. The field manifest is generated read-only by `capture-coverage.mjs`.

Observed browser sequences:

- Shared composition 80/20 → invalid 75/20: exact total-100 error announced, intended value retained, header Blocked and row Errors. Correction to 75/25 saves and refreshes both inherited child rows without reload. [Invalid DOM](evidence/shared-invalid.txt), [corrected DOM](evidence/shared-corrected.txt).
- German shared content and missing translations carry explicit source-language/fallback states. Etsy additional-account German alias saves remain separate. An interrupted response after commit is reconciled by reading back and clears the unsaved state.
- Delayed Etsy response followed by rapid eBay navigation does not replace the new scope. Existing destination/draft/recovery tests supplement this observation.
- Named Etsy shipping selector displays the selected shop's profile name and saves its ID. Main Information labels explicitly state Nexus draft autosave, and category/property tests preserve saved incompatible values.
- Shopify additional-store named alias title saves as a Nexus draft; neighboring alias titles remain distinct. Reopening/cancelling the editor returns focus to the exact gridcell. [Draft DOM](evidence/shopify-draft.txt). API tests cover product versus variant owners, app-read-only fields, definition boolean values, exact new history and stale tokens.
- Desktop light/dark and genuine 390px/768px iframe layouts were visually reviewed: [Shared narrow](evidence/shared-mobile-light.png), [Etsy narrow dark](evidence/etsy-mobile-dark.png), [Shopify tablet](evidence/shopify-tablet-light.png), [Etsy desktop](evidence/etsy-required-desktop-light.png). The browser viewport override did not change the outer viewport; fixed-width frames provided real CSS media-query breakpoints. Grid content scrolls horizontally while identity remains pinned. Screenshots include a fixture-only control strip.

Some captured screenshots precede final small status/action-label corrections; they document layout, not current publication status. The final API assertions cover the DRAFT/ARCHIVED correction. The initially captured review-navigation control was subsequently removed from Information because it merely navigated to the already active page.

## Accessibility limits

Verified: native typed-control labels and required semantics, grid roles, visible focus, Enter-based editing, error status announcements, modal focus/return, and responsive light/dark rendering. Existing reduced-motion CSS rules were inspected; an OS-level preference transition was not exercised. No screen reader was run, and actual browser zoom at 200% was not measured.

[Representative measured colors](evidence/contrast-ratios.json) show body/title text at 15.48:1 light and 12.73:1 dark. Initial primary-action samples were 4.79:1 light / 5.84:1 dark; the initial Requirements treatment was 5.98:1 light. The Information navigation/requirements controls now use the existing secondary button treatment, but other existing primary actions still use those DS token pairs. This is a known limit against a universal AAA 7:1 normal-text claim. This phase does not certify AAA or exhaustive accessibility conformance.

## Reproduction

From the repository, run `INFORMATION_BROWSER_FIXTURE=1 npm test --workspace=@nexus/api -- src/services/pim/information-database.vitest.test.ts`, then `node docs/audits/2026-09-11-information/browser-fixture/server.mjs`. Open `http://127.0.0.1:3151/products/store-demo/edit/studio?market=IT`. API uses port 4116. The API process intentionally waits after tests; stop that owned worker with SIGINT when finished. `viewport.html?width=390&scope=ETSY&theme=dark` and width 768 exercise narrow layouts. Capture evidence with `node docs/audits/2026-09-11-information/capture-coverage.mjs`.

Unverified: live provider writes/acceptance, every category/market/definition permutation, remote interruption delivery, formal assistive-technology conformance, and production migration/deployment. Existing earlier read-only provider audit evidence remains useful context but is not a substitute for this phase's live mutation acceptance.
