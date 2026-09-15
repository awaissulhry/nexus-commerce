# Product sheet Graphify follow-up — 2026-09-15

This extends the [autosave and publication investigation](2026-09-15-product-sheet-autosave-diagnosis.md). The changes remain local and uncommitted. No production deployment or marketplace write was performed.

## Trace and scope

Graphify's existing 68,345-node index located the sheet, drawer, navigation and history dependencies quickly. It is a baseline index: findings and implementation decisions were checked against the current source, including functions subsequently extracted into new files.

```sh
graphify query 'getStudioSheet resolveWorkspaceDestination useChannelSheet useMasterSheet' --budget 1500
graphify explain 'apps/api/src/services/pim/studio-sheet.service.ts::getStudioSheet'
graphify explain 'apps/api/src/services/pim/cell-history.service.ts::getCellHistory'
graphify query 'RecordField FormulaField getCellHistory useInFlightGuard' --budget 1200
```

The review followed sheet resolution and editing into the save ledger, record drawer, formula composer, navigation guards, product studio routes, workspace destination resolution and content audit writers. The last query returned 190 connected nodes; its displayed output was deliberately bounded. This is a review of those paths, not an exhaustive certification of the product.

## Confirmed defects and corrections

| Defect | Correction and files to access |
| --- | --- |
| A refused edit could stop having an active request and then allow an account, market or language change that removed its editor. | `sheet/useSheetPublicationGuard.ts` checks unconfirmed tracker changes as well as pending writes and live editing. Regression tests cover refused, conflicted and uncertain states. |
| A formula draft could lose the keystrokes that opened formula mode. | `drawer/fields/RecordField.tsx` passes the typed draft separately from its saved baseline to `FormulaField.tsx`. Cancel restores the baseline; a new formula starts with the triggering text. |
| An unfinished or refused formula was absent from the publication and scope-change barriers. Closing a record through router history could bypass editor protection. | `FormulaField.tsx` registers live guards, retaining protection after failure and releasing it after successful application or explicit cancellation. `recordClose.ts` and `contracts.tsx` check the same editor guard before either record-close route. |
| Tab/page exit, in-app navigation and profile switching only considered active requests. A formula draft or refused edit could therefore be lost when no request was running. | `useInFlightGuard.ts` reads the live workspace publication blocker at the event boundary. Eligible links retain the existing explicit leave confirmation. Exempt clicks are checked before querying the blocker because editor checks may flush a queued literal save. Profile switching remains blocked until the change is resolved; its existing discard action stays disabled because the editor registry does not provide a safe discard operation. |
| History opened from a widened language column could request the currently selected language instead of the column's language. | `drawer/fieldHistorySelection.ts` and `RecordDrawer.tsx` derive the canonical field and locale from the selected column. |
| Current source, translation and listing-pin writes could be missing from history, lose their previous value, or be attributed to an incorrect language. A child inspected through a root listing could miss its alias-specific pin history. | `cell-history.service.ts` recognizes the current audit formats and scopes listing IDs by inspected product, account, market and alias. `content-write.ts` captures source values before mutation; `master-content.service.ts` records those values and distinguishes source from translation cascade audits. Translation cascade events are excluded to avoid duplicating the actual language write. Generic factual edits remain visible across content languages. |
| Numbered schema keys such as `feature_200` could be treated as the 200th element of a list and render as empty. | History first matches an exact canonical audit key. List-slot extraction applies only when the stored event names the base list. |
| Malformed requested or recorded locales and a non-finite history limit could cause errors or misleading results. | Requested locales are validated with a 400 response; malformed recorded locales are excluded from a localized request; limits are finite integers bounded to 1–200. |
| The drawer rendered a variation-theme object as editable `[object Object]`, although its generic save endpoint refuses variation-axis writes. | `RecordField.tsx` reuses the design system's `variationThemeText()` formatter, renders an accurate read-only summary, suppresses generic write affordances, and directs editing to the sheet's dedicated control. |

## Verification

- New disposable PostgreSQL tests exercise the actual content writers and history reader, independently reading the resulting audit entries. They cover source previous values, custom attributes, translation isolation, account/alias isolation, pin reset, child/root coordinates, exact numbered keys and malformed input. The readiness producer is mocked in these history-specific tests; autosave readiness has its own database regression.
- Frontend regressions exercise the actual guard hooks with controlled event/contract harnesses, the live save store, record-close routing, formula lifecycle and language selection. A server-rendered real `RecordField` fixture proves the variation summary and read-only semantics. Confirmed failures were observed before the corresponding fixes.
- Final combined API selection: **34 files passed; 454 tests passed; one existing opt-in browser fixture skipped**. The skipped test serves the isolated workspace-scope browser fixture only when `NEXUS_WORKSPACE_SCOPE_BROWSER=1`; it is not a failed assertion or a newly weakened check. Log: `/private/tmp/nexus-sheet-api-final.log`.
- Final web selection, covering the product studio and shared grid: **227 files passed; 3,055 tests passed; one existing conditional test skipped**. Together the final API and web selections passed **3,509 tests**. No test was disabled by these changes. Log: `/private/tmp/nexus-sheet-wide-web.log`.
- API and web TypeScript checks, token generation consistency, the raw-control ratchet and `git diff --check` passed. Typecheck logs: `/private/tmp/nexus-sheet-api-types.log` and `/private/tmp/nexus-sheet-web-types.log`. Design guard logs: `/private/tmp/nexus-sheet-token-check.log` and `/private/tmp/nexus-sheet-raw-controls.log`.
- The API suite initially failed during disposable database setup because the sandbox denied listening on `127.0.0.1`. Its approved rerun passed with exit code 0. Channel transports remained mocked.
- Browser verification used the local existing test product `NEW-20260729-L5C8`. An incomplete `=upper(` draft retained its text when formula mode opened; Close kept the record and draft open; Cancel then Close released it. No valid formula or product edit was deliberately saved. The variation field displays `No axes set`, is read-only, and points to the sheet editor. The drawer was inspected at desktop and 390×844 in light and dark themes; mobile document width remained 390 pixels with no page overflow. No console errors were observed in the inspected log window. Theme and viewport were restored.
- Independent review covered the history changes and frontend guards. Root review additionally found and corrected the exit guard's unrelated-click flush side effect before final validation.

No shared design-system source changed; the drawer consumes existing primitives and formatting. Historical audit rows without enough attribution are not backfilled or presented as complete history. Production latency and actual Amazon/eBay processing and read-back still require deployment and a controlled live listing verification; local passing tests do not establish those results.
