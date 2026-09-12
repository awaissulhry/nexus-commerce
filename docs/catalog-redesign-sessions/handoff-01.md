# Session 1 handoff — core account and write contracts

Date: 2026-09-06. **Status: implemented and verified for the core Information/readiness/account/write contracts below. Sessions 2 and 3 may build against these contracts. The complete redesign and the consumer workflows in the capability matrix are not complete.**

The current uncommitted source is the baseline. Starting copies of touched files are in `/tmp/nexus-session-one-before`; starting Git status is `/tmp/nexus-session-one-start-status.txt`. No reset, stash, checkout, database migration or live catalog update was performed. Do not start from Git HEAD alone.

## Navigation decision

Only product editing has secondary navigation. THIS PRODUCT contains Information, Media, Needs attention, Performance and Activity; Presentation appears once under the eBay branch. Return to Products is the only catalog navigation item. Channel/account/market selection stays in the scope row. The latest owner revision restores Amazon/eBay branches without mappings. Listing information opens the existing channel sheet; eBay has one combined Description themes & variation order entry for Presentation. Variant editing remains in the existing Information family grid.

Shared libraries remain explicit contextual actions. Main Listings and Channels navigation will be handled after Products/product editing; reusable channel configuration belongs under main Channels in that later phase. See PRODUCT-CONTEXT-ADDENDUM.md and the final integration receipt below.
## Contract ready for consumers

- **Coordinate:** product or variant ID within a family; channel; validated account/connection; market; applicable content language/locale; primary listing or alias; field. Language and market remain distinct. Per-cell ownership decides whether a channel-visible edit writes shared product data or listing data.
- **Names:** Studio URL `account`; API query/body `accountId`; internal `channelConnectionId`. Sheet reads use `market`; response/write contexts use `marketplace`. Existing names remain compatible. StudioCoordinate now also carries optional `accountId`.
- **Account resolution:** `resolveChannelConnectionId(channel, undefined)` resolves the unique primary (a single active account qualifies). A named account must be active and belong to the requested channel. `null` preserves an already resolved unattributed destination; it is not another request to resolve the primary. Disconnected draft destinations retain explicit null. Ambiguous primary selection raises `AMBIGUOUS_CONNECTION`/409; invalid named selection raises `NO_CONNECTION`/400. Database errors are not interpreted as disconnection.
- **Bulk destination:** `/products/bulk` resolves only requested unnamed channels. Shared-only edits do not query accounts; explicit account edits do not consult an unrelated or same-channel ambiguous primary. One commit supports one account per channel. Mixed implicit/explicit accounts or two named accounts for one channel are refused. A multi-account import must use the existing per-destination transfer orchestration, not one ambiguous row commit.
- **Rows/columns/category:** both Studio sheet and columns endpoints carry `accountId` into the same category context and existing resolver. Listing and alias reads filter the exact resolved account. Unattributed legacy aliases are no longer included in every named account; no records were rewritten or reassigned.
- **Writes:** keep the server-provided `writeField` and `writeTarget`. Keep Product and ChannelListing versions distinct. Existing validation, atomic override merge, reset/clear semantics and per-cell refusals remain authoritative. `intent: reset` removes an override and restores current inheritance; it is not a literal null customization. Ordinary Shared changes preserve listing overrides.
- **Aliases:** create carries `accountId`; product, account, channel, market and active alias ownership are checked before alias-targeted cell writes. Creation uses the selected connection even when no prior listing exists. Both `aliasId` relation and `aliasKey` discriminator are written when materializing listing rows. Rename/reorder accepts body `accountId`; archive accepts query `accountId`; both validate the path product/family and account before mutation. Empty explicit IDs are refused. Omitted IDs retain primary semantics. Alias creation still honors the pre-existing legacy-index deployment gate.
- **Primary-only capability:** UI `studioAccountAccess` and backend `isPrimaryChannelConnection` distinguish a unique primary from an alternate or ambiguous account. These guards do not confer authorization; the existing API permissions still apply. A guard is not support for the underlying alternate-account workflow.
- **Formulas:** the current CellFormula model has no account/alias key. Its editor remains primary-account/primary-listing only. Alternate sheets do not load/display/export primary formula metadata. An alternate-account or alias-only edit does not trigger primary-account formula recalculation. Shared edits retain their existing dependent-formula behavior. This does not add account-specific formula persistence.
- **Async lifetime:** product changes remount Studio state; scope changes isolate surfaces. Account changes clear listing, record, cell and chip coordinates. Sheet responses and local/refresh callbacks are checked against their originating URL; pending reads abort on cleanup. Readiness responses include the selected channel/account in their identity and discard other-coordinate results.

## Capability matrix and remaining owners

| Consumer | Verified support now | Remaining work / owner |
| --- | --- | --- |
| Shared Information and variants | Existing grid/write model retained; Shared commits independent of account ambiguity | Universal version coverage across legacy shared writers is still incomplete; integration owner / Session 4 |
| Channel Information | Named accounts, category/column/row/effective-value agreement, scoped overrides and alias ownership | Account-specific CellFormula persistence is not supported; retain primary restriction |
| Readiness scope chips | Selected channel uses selected account; failures in another channel do not discard successful results | Other channel chips describe their primary account until selected; full consolidated issues is Session 4 |
| Presentation / themes / variation order | Existing primary-account experience; alternate-account notice cannot fail open when no unique primary exists | Session 3 must wire account-aware product assignments and broad management before removing the restriction |
| Media, Needs attention, Activity, Performance tabs | Shared/primary paths retained; alternate account cannot mount primary-only surfaces | Account-specific consumer/service work and unified history: Sessions 3/4 as appropriate |
| Alias creation / metadata / cell edits | Explicit account contract and ownership checks implemented | Creation depends on the existing alias-index deployment gate; no migration applied; metadata mutations do not introduce a new CAS/version model |
| Formulas and preflight / channel verbs | Primary-account restrictions; formula metadata and triggers no longer cross into alternate-account edits | Sessions 3/4 must extend the actual model/services, not just hide notices |
| Legacy bulk schema update / replicate | Requested channels only; primary account and aliasKey='' on source/preimage/read/upsert/create | Alternate account/alias contexts refused. Legacy validation, override semantics and full target CAS remain unconverged; do not use as canonical import/bulk services |
| Catalog transfer | Existing explicit destinations and SET/CLEAR/INHERIT foundation retained | Session 2: generic incoming-column mappings, presets, external ownership, large preview/execution and account-safe legacy file tools |
| Listing presets | Existing channel/market library and wizard integration retained | Account-specific defaults and broad assignment: Sessions 3/4 |
| Wizard / publishing / synchronization | Existing primary-account workflows retained; no live submission tested | Session 4: explicit destination/version contracts throughout jobs, retries, guided/bulk review and continuity |

The new mapping system remains canonical. This increment only preserves the resolved account/null when handing values to it; it does not change rule precedence, invent an inheritance engine, or complete overlapping rules, reviewed formula/category activation, standing theme/order rules or input-version invalidation. `tryResolveConnection` and other legacy consumers were not universally rewritten. Their error handling must be inspected before claiming global account completeness.

## Files changed in this increment

API production files: `services/connection-resolver.service.ts`; `services/pim/{product-category-context,studio-sheet,scope-readiness,listing-alias,channel-value-write}.ts` (service suffixes retained in the actual filenames); `services/pim/mapping/index.ts`; `routes/{products,product-studio}.routes.ts`.

Web Studio files: new `accountScope.ts`, `channelLibraries.ts`; changed `StudioClient.tsx`, `StudioSubheader.tsx`, `StudioTabHost.tsx`, `contracts.tsx`, `types.ts`, `sheet/channel/{ChannelSheet.tsx,useChannelSheet.ts}`. No grid-engine implementation changed.

Tests: new `connection-destinations.vitest.test.ts`, `product-studio-account.vitest.test.ts`, `listing-alias-account.vitest.test.ts`, `studio-account-resolution.vitest.test.ts`, `readiness-account.vitest.test.ts`, `accountScope.vitest.test.ts`, `channelLibraries.vitest.test.ts`; extended bulk-noop, bulk-recalc-guard, channel-value-write and channelWrite tests.

DS: only navigation label/link color declarations and neutral Banner description color were changed in `styles/{patterns,components}.css`, using `--nds-text`. These exact changes were mirrored to Factory without replacing its existing differences. Both catalog READMEs, changelogs and component/pattern documentation plus `.claude/DS-GAPS.md` record the fix. No new component/export API was necessary.

## Verification evidence

- API: **47 files / 494 tests passed**. Command: `npm run test --workspace=@nexus/api -- src/services/pim src/services/connection-destinations.vitest.test.ts src/services/connection-resolver.vitest.test.ts src/services/connection-resolver-select.vitest.test.ts src/routes/product-studio-account.vitest.test.ts src/routes/products-bulk-noop.vitest.test.ts src/routes/products-bulk-recalc-guard.vitest.test.ts`. Log: `/tmp/nexus-session-one-api-final.log`. This is the focused PIM/core-route suite, not every API test.
- Web: `npm run test --workspace=@nexus/web -- 'src/app/products/[id]/edit/_studio' src/design-system/grid`: **137 files; 2,112 passed, 13 live tests skipped** while the API was unavailable to that run. Log: `/tmp/nexus-session-one-web-final.log`. The separate read-only `npm run test --workspace=@nexus/web -- live-channel-scope.vitest.test.ts` subsequently ran successfully: **13/13 passed**, 3.16s. Thus all 2,125 selected tests passed across those runs; the skip is not represented as a pass in the batch log.
- Tests cover two accounts on one market, no/multiple primaries, inactive/wrong-channel IDs, exact alias ownership, alias lifecycle, named reads and writes, stable null destinations, readiness isolation, formula metadata/triggers, legacy bulk source/create destinations, override/reset/CAS persistence and existing SheetWriter behavior. Browser rapid account switching ended in the selected account with fresh rows; deterministic React-hook scheduling and an exhaustive multi-client concurrency run are not added by this increment.
- API, Web and Factory `npm run typecheck --workspace=@nexus/<app>` passed. Logs: `/tmp/nexus-session-one-{api,web,factory}-types.log`.
- Web token guard passed. Factory token guard reports **320 existing violations**; all reported declarations were matched to saved starting files, with no new violations. Logs: `/tmp/nexus-session-one-{web,factory}-token.log`. Commands: `node apps/<app>/src/design-system/tools/token-guard.mjs`.
- `npm run tokens:check` and `npm run tokens:check:factory` passed. The sandbox blocks the tsx local IPC socket, so these checks used their approved external-sandbox commands. The existing web dead-port suite similarly needed permission to listen on localhost.
- All **264 design-system/grid files** remain byte-identical to `/tmp/nexus-redesign-before/apps/web/src/design-system/grid`; no added files there. Grid-suite duration is not a controlled performance benchmark.
- Desktop Shared grid baseline remains x=67, y=187, width=1660, height=674.25 at 1728×906. Final alternate eBay Information grid measured x=67, y=254, width=1660, height=607.25 both closed and open; its extra channel toolbar is part of that surface. Product overlay x=66, y=56, width=224, height=850. Products Next still has no secondary toggle and retains its baseline grid rectangle (121, 621.796875, 1552, 1237).
- Browser: connected Amazon/eBay library groups and scoped URLs; alternate eBay Information loads; Presentation correctly names the primary-account limitation; alternate preflight is disabled. Escape removes navigation and restores its opener. An outside dismissal click over Market does not open it or change the market. Global header/primary rail remain visible; desktop is undimmed.
- At 390×844: no document horizontal overflow; drawer bounds x=66, y=56, width=324, height=788; links wrap within the panel. Light/dark styles inspected. Measured navigation link/group text contrast is **15.48:1 light / 12.73:1 dark**; neutral account notice description is **13.66:1 light / 13.23:1 dark**. These measurements cover the changed states, not application-wide AAA certification. Browser returned to 1728×906, dark theme, primary-account Information, navigation closed.

## Integration instructions

Session 2 may implement import consumers and Session 3 may implement mapping/presentation consumers against this handoff, with the distinct file ownership in README. Keep the coordinator as the sole writer of core routes/contracts and shared DS/schema/registration files. Do not remove account restrictions until reads, writes, previews and background jobs carry the same destination and have been verified. No worktree made from committed files alone includes this foundation.

Session 5 still owns the full production build, exhaustive accessibility/keyboard checks and isolated database-scale performance/concurrency benchmark. No real marketplace listings were published, no product facts or aliases were edited in the browser, and no scale fixtures were inserted into the working catalog.

## Final Session 1 follow-up — save feedback isolation and launch clearance

The coordinator continued the core audit after the first handoff and fixed a concrete save-feedback collision. `channelWriteIdentity` previously keyed writes by variant/alias row ID and a counter that restarted when the sheet remounted. Account A and account B could therefore emit the same ID into the product's shared save ledger. Their subjects also collided, allowing one account's successful response to clear the other's failure.

The helper now requires channel, market, account, applicable locale and the sheet instance ID. The failure subject stays stable for retries in the same destination; a new mounted sheet gets a distinct attempt namespace through React `useId`. Both literal and formula writes use it. No grid-engine, resolver, write-destination or API behavior changed in this follow-up.

Changed source: `sheet/channel/rows.ts` and `sheet/channel/ChannelSheet.tsx`. Tests: `hoverNote.vitest.test.ts` and `channelWrite.vitest.test.ts`. Regression tests drive the real save ledger with overlapping writes in different accounts/channels/markets/languages and returning to a previously opened scope. A deferred-fetch test completes B's save before A's delayed conflict and verifies B's stored listing version remains intact. Starting copies: `/tmp/nexus-session-one-followup-before`.

Verification:

- The old implementation failed six assertions, including the existing identity expectation updated to require a scoped subject: `/tmp/nexus-session-one-save-identity-red.log`.
- The focused save-ledger/write suite passes **74 tests**: `/tmp/nexus-session-one-save-identity-green.log`.
- The complete selected Studio/grid suite now passes **137 files / 2,131 tests**, including all 13 live channel smoke tests: `/tmp/nexus-session-one-save-isolation-web.log`. Command: `npm run test --workspace=@nexus/web -- 'src/app/products/[id]/edit/_studio' src/design-system/grid`. Its first sandbox run could not open the existing localhost test listener; the approved rerun passed.
- Web typecheck passes: `/tmp/nexus-session-one-followup-web-types.log`. API and DS source were unchanged by this follow-up; their earlier verification remains recorded above. All 264 grid-engine files still match the original snapshot byte-for-byte.
- Browser smoke check: Information loads after account changes; navigation opens and Escape closes it. At 1728×962, the channel grid rectangle is x=67, y=254, width=1660, height=663.25 with navigation both closed and open. No product writes or live publication were used for browser testing; delayed writes were mocked in tests.

**Launch clearance: Sessions 2 and 3 can start now**, using the current workspace and their individual prompts. The README's explicit launch-boundary table governs ownership. Core readiness does not transfer core-file ownership: the coordinator retains account/write/read/save contracts and shared integration files. Sessions 2/3 implement their independent areas, prepare exact shared-file patches when necessary, and report results in their own handoffs. Session 4 implementation waits for both handoffs and integration. Session 5 may audit read-only; its full integrated verification remains later work.

One concrete Session 2 consumer concern is now highlighted in its prompt: the older channel keyed export does not encode account identity, so it must not claim a safe named-account editing round trip. This follow-up does not complete that import/export integration or remove primary-only tool restrictions. All other limitations in the capability matrix remain explicit.

## Subsequent owner clarification — product-sidebar destination scope

[PRODUCT-CONTEXT-ADDENDUM.md](PRODUCT-CONTEXT-ADDENDUM.md) supersedes this handoff’s original direct-to-library navigation interpretation. Product-context preset/theme/order work must retain the product identity/sidebar and affect only the explicit product/destination; shared-definition management is separate and clearly labeled. Existing sidebar links still lead to global libraries and have not yet been replaced. Session 3 owns the feature/service work currently in progress; Session 1 retains the corresponding shell/route integration. Core account/write contracts and completed verification remain valid. No new UI or runtime verification is claimed in this clarification increment.

## Active coordinator increment — product task navigation

2026-09-06: The owner accepted task-based product navigation with one channel/account/market scope selector. This supersedes the intermediate AMAZON/EBAY sidebar branches. Product editing stays the only secondary-sidebar workspace. Main Listings and Channels navigation is a later phase; the intended Channels area will expose canonical shared libraries and mapping services. Session 1 is removing the direct global-library branches and integrating Session 3's source-metadata patch. Existing Information/family grid and consumer scope guards remain. Source backup: `/tmp/nexus-product-task-navigation-before`.

**Browser acquired by Session 1** after Session 2's recorded release at 13:49 UTC. Session 1 is checking product navigation on the existing server; do not restart it or control this browser concurrently. Verification and release will be recorded below.

## Coordinator integration receipt — task sidebar and returned handoffs

2026-09-06. This increment is implemented and checked. **Products/product editing and the full redesign are not complete; do not start the main Listings/Channels navigation phase yet.**

- `StudioSubheader`, scope task ordering and URL contracts: removed AMAZON/EBAY library branches and global attribute administration from the product sidebar. Kept Information, Media, eBay Presentation, Needs attention, Performance, Activity and Return to Products. Task navigation now uses the existing shallow history mechanism with a history entry and the existing draft guard; scope controls keep their existing replace behavior. No duplicate variant editor was created; variants remain in Information.
- Applied `session-03-source-metadata.patch` to the current source. The resolver's supplying rule ID/name/version/link now reaches channel cells and Presentation. The feature source description and reset wording respect that supplying rule before the superseded source path. The grid's existing reusable-mapping action opens the supplying rule when present. Presentation explicitly labels the link as shared and explains its broader impact. No second resolution calculation or new data writes were added.
- Applied all three Session 2 patches. Every channel Import action opens `/products/catalog-transfer`; the unreachable legacy channel ImportDrawer mount was removed. Channel table exports use the existing DS exporter with SKU/account/market/alias context, and both toolbar tooltip and save feedback call them review files. Shared sheet imports/exports remain. Legacy channel previews are refused even when channel coordinates are hidden in headers submitted as master; historical channel apply/revert are refused. `/api/import-jobs` create/apply/retry uses `products.import`; the existing stricter generic rollback permission remains `bulk.rollback`.
- **Variation-order restriction tightened:** inspection confirmed `PATCH /ebay/cockpit/variation-matrix` uses product+market `findFirst` without account/alias or CAS, and the live order service enumerates the family without those destinations. A primary-account UI guard cannot make this write safe for a chosen destination. Product Presentation now shows its existing order action disabled with an explanation and does not mount that modal. Existing saved order, legacy editors and shared variant/grid sorting are untouched. Implement destination/version support before re-enabling; removing the gate alone is not completion.

### Verification for this increment

- Web Studio/grid suite: **136 files / 2,129 tests passed**, including 13 read-only live cases. `/tmp/nexus-product-task-web-suite.log`.
- API import/permissions/transfer/source/canonical-write integration: **11 files / 117 passed, 1 intentionally skipped opt-in browser fixture**. Multipart tests exercise the actual registered Studio endpoint, including channel headers under master scope, two-header files, shared-only review and historical job refusal. `/tmp/nexus-product-task-import-integration.log`.
- API sheet/mapping/presentation focused suite: **5 files / 36 passed**, including new account/alias rule metadata forwarding coverage. `/tmp/nexus-product-task-api-suite.log`.
- The source-label regression first failed with “Follows Master,” then passed with the correct shared rule/version and reset behavior. Explicit overrides retain their source. `/tmp/nexus-product-task-source-red.log` and `/tmp/nexus-product-task-focused-web.log`.
- Web/API types pass: `/tmp/nexus-product-task-{web,api}-types-final.log`. Web generated tokens, Web token guard (165 files), raw-control ratchet (4,368 / 4,692 baseline), and owned tracked-file whitespace checks pass. No DS implementation changed, so no Factory mirror was required. The previously reported Factory guard failures were not introduced or rerun here.
- The first token and full Web attempts hit sandbox IPC/localhost restrictions; approved reruns passed. The test fixture initially used an incorrect expiry type and omitted a response field; these fixture failures were corrected. No unresolved failure from this increment remains in the checks run.
- All **264 shared grid files** match `/tmp/nexus-product-task-navigation-before/grid-sha256.json`. Shared grid before/after at 1728×962: x=67, y=187, w=1660, h=730.25; 22 rendered rows including the header, 12 rendered columns. Opening navigation leaves the same rectangle/counts. eBay open/closed at 1728×906: x=67, y=254, w=1660, h=607.25. These are layout/rendering comparisons, not database-scale performance benchmarks.
- Browser: task links keep product/eBay/IT/Italian context; Presentation retains the sidebar; Back/Forward returns between Information and Presentation. Escape restores the toggle's focus; closed items are unmounted. Outside clicking at the underlying Import button closes the panel without activating Import. The desktop backdrop is transparent; panel anchors at global header y=56 and primary rail x=66. Toggle divider ends with the subheader; no matching content gutter.
- At 390×844 in light/dark: document width/scrollWidth both 390; panel x=66,y=56,w=324,h=788, retaining global header and primary rail; internal overflow is auto. Settled screenshots inspected. Navigation text computes to 15.48:1 light / 12.73:1 dark; keyboard focus has a visible 2px outline. This is not full AAA certification or a newly simulated reduced-motion audit (the DS implementation is unchanged).
- Channel Import opens the real Catalog import & export page. `/products/next` and catalog-transfer have no secondary-sidebar toggle. Existing product data caused the eBay buyer preview to report a missing description/overlong title; no business data was changed to hide those issues. Development hot reload briefly interrupted API reads and an import-removal module refresh; ordinary retry/reload recovered without restarting servers.

### Remaining product-phase work

1. Implement product/family **account+market+listing-specific** variation-order reads/writes, inheritance reset, CAS and consumer parity before restoring the product control or enabling standing order rules.
2. Complete product preset application through the existing wizard/defaults consumer and its exact destination review; broad one-time/standing preset assignment is still unfinished.
3. Finish Presentation's remaining account/alias consumers and exact listing-ID deep links, theme usage/staleness and draft Back/programmatic navigation protection. Primary-only restrictions remain.
4. Repeat native browser file upload in an isolated fixture after its browser file-access prerequisite is available. Session 2's isolated HTTP and URL-input browser tests do not prove native chooser upload.
5. Continue consolidated issue/job, catalog continuity, actual database scale/concurrency and full build/accessibility verification. Do not equate the completed navigation increment with completed product editing.

Source backup and grid hashes: `/tmp/nexus-product-task-navigation-before`. Reviewed patch against that saved source: `/tmp/nexus-product-task-navigation-review.diff`. No reset/stash/clean/blanket formatting, live catalog writes, marketplace publications, migrations or background fixtures were performed.

**Browser released by Session 1:** restored dark appearance and reset the temporary viewport override; left the routine verification tab on Products Next for automatic cleanup. No other session's tab or server was changed.

## Coordination follow-up — existing Sessions 02 and 03

2026-09-06: The owner authorized this session to lead the two existing handoff chats. Current assignments are in the README and `02-product-presets-followup.md` / `03-product-presentation-followup.md`. Session 02 retains imports and takes the bounded product preset/wizard-draft work; Session 03 completes eBay product Presentation and its ordering/publication consumers. Shared Studio/writer/destination/submission contracts and integrated verification remain here. These assignments preserve product-specific theme/order customization and the accepted task sidebar.

Status at assignment: files prepared; the user must relay each follow-up to the corresponding existing chat. There is no direct cross-chat messaging or automatic wake-up. No new feature implementation or runtime verification is claimed by this documentation change. The existing patch integrations and test evidence above remain the latest completed receipt. Sessions 04/05 are not cleared as additional feature writers. Native file upload, product presets, complete presentation consumers and final quality/scale gates remain open.

For the next receipt, review each session's exact diff and contract patches against the current dirty source before integration. Verify real product/destination binding, override/reset/CAS behavior and consumer parity, then run focused combined tests/types and product-workspace browser checks. Retain guard restrictions until the supporting operation is proven; a session's final response alone does not confer clearance.


### Product-workspace scope follow-up — browser lease, 2026-09-06 16:39 UTC

The user asked the scope follow-up to check and continue. Core and ancillary implementation is in progress; see `docs/2026-09-06-product-workspace-scope-audit.md` (its original audit is historical until the completion receipt). Session 02 released at 16:27 UTC; Session 03's narrow navigation pass has ended without acquiring a lease and has handed its remaining browser checks to integration. The coordinator now acquires the browser for isolated scope and navigation verification, using separate 3104/4104 fixtures and `.next-workspace-scope-test`. No other session's processes or eBay-owned files will be changed.


### Product-workspace scope completion — 2026-09-06 17:18 UTC

The existing workspace scope follow-up is implemented and verified. Read [the implementation handoff](../2026-09-06-product-workspace-scope-audit.md) before continuing; its opening receipt supersedes the historical pre-handoff audit. Product/account/market/listing resolution, stale reads and save receipts, drawer history, queue attribution, scoped observations, Media restrictions, override reset and snapshot conflicts are covered. The existing layout and shared grid remain unchanged. Presentation’s exact listing picker is integrated and its blanket primary-account gate removed after supporting checks; its owning publication/Inventory/standing-order restrictions remain. No Session 02 preset patches or unrelated platform work was included.

Final evidence: API 89 tests passed (1 opt-in fixture skipped), Web Studio/Presentation 1,319 passed, final queue subset 34 passed; API/Web/Factory types and generated tokens passed. Web token guard and raw-control ratchet passed. Factory token guard retains 320 existing violations in 105 files. Web/Factory DS and grid hashes are unchanged. No full-build, production-scale or AAA certification is claimed.

**Browser lease released:** both owned tabs closed, viewport reset, only this task’s 3104/4104 and 3105/4105 processes stopped. Temporary test page and copied Presentation fixture archived outside the repository and removed. No live catalog writes or marketplace calls occurred. Further accountless historical data must remain excluded until its existing owner can provide destination attribution; do not remove restrictions by adding a primary-account fallback.


### Channel sidebar revision — browser acquired, 2026-09-06 17:30 UTC

The user now requests Amazon/eBay branches without mappings, with one eBay entry where description themes and variation order share a page. This supersedes the earlier flat task-sidebar decision. The coordinator owns this narrow navigation increment. Browser acquired for isolated real-Studio checks on 3105/4105, reusing the archived in-memory Presentation fixture; no duplicate frontend page is created. No other session’s files or processes will be touched.


### Channel sidebar revision completed — 2026-09-06 17:35 UTC

Restored connected Amazon/eBay branches using the existing design-system WorkspaceSubheader collapsible groups. Both branches provide Listing information for their channel; eBay has one Description themes & variation order link to the existing combined Presentation page. Removed the duplicate top-level Presentation entry. Mappings and shared-library administration are absent from these branches. This is navigation over the existing product pages, not a new page or editor. Amazon uses its supported Information destination; Session 02’s pending product-preset integration remains separate.

Native link URLs and ordinary clicks share the same channel/task patch. Same-channel links retain product, account, market, listing and record context. Cross-channel links clear incompatible account/listing/record coordinates and choose a supported target market. Ordinary clicks run as one existing guarded shallow-history operation; no direct router transition bypasses the pending-draft guard. Existing account resolution and all publication restrictions remain unchanged.

Checks: 48 focused navigation/scope/guard tests passed; Web types, token guard and raw-control ratchet passed. Browser used the actual Studio page against an isolated API: keyboard branch collapse/expand, Enter activation, Escape focus restoration, exact eBay alternate preview, Amazon URL clearing eBay account/listing, and Back restoring the original eBay destination all passed. At 390×844, light/dark document width and scrollWidth were 390; sidebar bounds were x=66, y=56, w=324, h=788 and the combined entry stayed inside the panel. No product/listing edits or publication actions were performed.

Web and Factory design-system/grid hashes match the saved baseline exactly, so no shared source mirror was needed. Prior Factory token-guard and wider AAA limitations remain recorded in the scope handoff; this navigation change makes no application-wide certification claim. Source backup and review delta: `/tmp/nexus-channel-sidebar-before`, `/tmp/nexus-channel-sidebar-review.diff`. Logs: `/tmp/nexus-channel-sidebar-{tests,types,tokens,controls}.log`.

**Browser released:** restored dark appearance, reset viewport, closed the owned tab, stopped only fixture PIDs 57373/57391 on 4105/3105, and archived/removed the temporary API fixture. No temporary frontend page was created. The latest PRODUCT-CONTEXT-ADDENDUM and README now record the owner’s restored-branch decision.


### Product presentation layout split completed — 2026-09-06 18:14 UTC

The owner rejected the combined Presentation layout and requested a design-system rebuild. eBay now has separate Description themes and Variation order product pages. Existing `tab=presentation` links open Description themes; `tab=variation-order` opens inline axis/value ordering. Same-account alias context, draft guards, canonical writes and reviewed publication remain intact. Read [the complete handoff](../2026-09-06-product-presentation-pages.md) for implementation, evidence and limits. This supersedes the earlier single combined sidebar entry.

Verification: 1,323 Web tests, 83 API destination/presentation fixtures plus 31 permission tests passed; final Web/Factory types and Web token/control checks passed. Browser checked alias-specific theme/order writes, navigation, Keep/Discard, exact publication review, keyboard operation and 390px light/dark layouts. No shared DS/grid files changed. Broader AAA/Factory baseline and existing domain restrictions remain documented.

**Browser released:** dark appearance and normal viewport restored, owned tab closed, owned 3105/4105 servers stopped, temporary API fixture archived outside the repository and removed. No temporary frontend page or live catalog/publication write was made.
