# PR.6 — Presence design system

Status: **incomplete; no W2-DS DONE, P-A11Y DONE or PR.6 AT-WAVE-4 posted.** The earlier W2-DS-TYPES DONE gate stands. Nothing committed or pushed; no database or channel writes. Tests use Node and local React-only catalog state.

The contract, Menu adapters, renderers, confirmation component, named token repairs, focus/disabled styling and shared Factory mirrors are implemented. TypeScript: web **exit 0**, Factory **exit 0** with private build-info. DS Vitest: **108 files / 1,356 tests passed**, exit 0, maxWorkers=2. Declaration builds: web and Factory exit 0. Final web freshness check: **260/260**. Factory emitted declarations: **191/191** byte-matched the private build. All copied source ages exceeded 120 seconds; 25 web and 190 Factory paths were declared before copying, with zero skipped sources. The source catalogue/tests/tools/CSS are excluded from declaration emit by the existing config.

## Final verification series

The table records the 20:02 local sequence against unchanged application source. Uptime was read before each command; nothing launched over load 8. Contrast output was reformatted to two decimals and candidates added at 20:06, without another application change. Empty tsc logs mean exit 0 from the captured process, not an inferred successful run. Full logs and commands are beside this file.

| Command | Exit | Load before launch |
|---|---:|---:|
| node scripts/check-focus-visible.mjs | 0 | 6.53 |
| node scripts/check-token-role.mjs | 0 | 6.53 |
| node scripts/check-silent-disabled.mjs | 1 | 6.53 |
| node scripts/check-ds-dts-fresh.mjs --check | 0 | 6.53 |
| node scripts/check-ds-fork-drift.mjs --check | 0 | 6.33 |
| node scripts/check-grid-swatch-contrast.mjs --check | 0 | 6.33 |
| node scripts/check-dark-alias-scope.mjs --check | 0 | 5.66 |
| node scripts/check-dark-pin-parity.mjs | 0 | 5.66 |
| node scripts/check-token-resolution.mjs --check | 1 | 5.66 |
| node scripts/check-css-parse.mjs | 0 | 5.66 |
| node scripts/check-css-hex-ratchet.mjs --check | 1 | 5.66 |
| node scripts/check-css-radius-ratchet.mjs --check | 0 | 5.66 |
| node scripts/check-css-ds-shadow-ratchet.mjs --check | 0 | 5.66 |
| node scripts/check-ag-grid-import-boundary.mjs | 0 | 5.66 |
| node docs/audits/2026-09-13-presence/pr6/contrast.mjs --check --suggest | 1 | 5.61 |

The swatch result consumes PR.1's W0-GATES repair and positive/negative proof. Its earlier selector-parser crash convicted nothing. The new focus and token-role guards were seeded RED before source fixes; archived seed logs remain. Final focus census:15 stylesheets,114 focus rules,104 real outlines,4 delegates,0 glow-only failures. Final token-role census:15 stylesheets,1,196 color declarations,84 text-role controls,0 bare status-fill tokens used as text. Fork guard:215 shared source files,208 identical,7 pre-existing differences,0 new drift; no baseline raised.

## Remaining failures and decisions

- **Silent disabled:** widened roots were measured under the old detector first (ads21, webDS10, Factory8), then the native+aria exemption was removed in a separate write. Current ads22/21, webDS12/10, Factory10/8. ScopeBar and ModeNotches are newly exposed native-disabled/title sites. ScopeBar changes are explicitly forbidden by PR.6; ModeNotches is outside §D. The Owner scope question is pending. Add axis was repaired after MX closed. Menu's conditional native OFF arm is also counted by the deliberately conservative AST detector; the D1 description-bearing held arm is verified keyboard-reachable and guarded. No exception or baseline increase hides these readings.
- **Token resolution:** one undefined token, --nds-surface-2, at five sites in untracked app/design/variation-projection/variation-projection.module.css. That page is outside PR.6 and was not edited. This is an unrelated guard failure, not evidence against the new DS token uses.
- **Hex ratchet:** shared-shell.css31→32. The named formula-text change replaces its old cyan alias with the required#0a5165 light pin. The pending review patch converts an existing identical#98a2b3 rail-chevron literal to var(--nds-grey-450), with no resolved-color change and no new token. It is NOT applied; the Owner's token-scope question is pending.
- **Broader AAA matrix:** the required named panel/hover/child/selected/danger-soft grounds all clear7:1 for the text repairs. The conservative cross-product of every declared cell-state wash with every row ground exposes six below-7:1 minima for danger/warning/formula. Applicability of each stacked combination to each renderer is not established. The script deliberately remains RED rather than claiming universal AAA. Candidate values are printed, not applied; moving warning-text would exceed the named token authority.

## Measured contrast

All ratios use source-declared grounds, compositing alpha in sRGB. Columns are panel, surface-hover, child, selected primary-soft, danger-soft. No white-only inference.

| Text ink | Light | Dark |
|---|---|---|
| danger-text |8.55 /7.75 /7.55 /7.44 /7.28|8.26 /7.66 /8.58 /7.29 /8.36|
| success-text |10.24 /9.28 /9.04 /8.91 /8.72|9.90 /9.19 /10.29 /8.74 /10.02|
| warning-text |8.87 /8.04 /7.83 /7.72 /7.55|8.30 /7.70 /8.62 /7.32 /8.40|
| formula foreground |8.83 /8.01 /7.80 /7.69 /7.52|8.43 /7.82 /8.76 /7.43 /8.53|

Success's conservative minimum over80 grounds/theme is7.50 light/7.89 dark; no exception needed. All named changes are monotonic on every computed ground. Focus now uses existing --nds-text, minimum11.35/10.14 over the same matrix. Browser inheritance REFUTED proposal C17's claim that var(--nds-primary) at the use-site escapes a descendant light pin: actual dark primary#1f6fde was3.18 on panel and2.81 on selected; the final outline is#e7ebf1. Pinned/override SVGs now use existing provenance inherited ink; all eight SVG minima exceed3:1 (full output in contrast.log). CellSaveMark uses text-colored glyphs and distinct solid/dashed/square rings; waiting and unknown may retain the same wash because their shapes differ.

## Browser evidence

The owned localhost:3000/design-system tab was tested at1440×900 and390×844, both themes, after a hydrated Primary click changed its result. Selected danger Menu ink is#8b2a25 light/#f2aea7 dark on actual primary-soft. Real ArrowUp focuses the held verb (nativeDisabled=false,aria-disabled=true); Enter preserves the result/menu. Enabled Enter is the positive control. Escape returns to the trigger. Declaration order remains Inspect / held Remove / Reset / separator / Check.

ActionConfirm initially focuses Cancel, rejects lower-case catalog-1 and missing acknowledgement, accepts exact CATALOG-1 plus acknowledgement, and confirms only the React demonstration. At390px, its width and scrollWidth are350px and its full534.05px height fits; screenshots were visually inspected in both themes. Four new fixture buttons inherit three overflow-hidden shell ancestors; their observed outlines do not meet the clip edge. This is not a claim that every platform consumer was browser-tested.

The Views prompt initially failed at left=-108.06px. With the existing start-placement/clamp it measures left62.00/right382.00 at390px and547.95/867.95 at1440px. Keyboard save reports the local view name. The existing DS ToastProvider now owns the fixture; final dev error log0 after17:58Z. AsOf's initial SSR/browser locale hydration mismatch was repaired; no final hydration error. All browser holds have FINISHED, original dark theme/viewport restored and owned tab closed.

## ASSUMED / QUESTION / REQUEST reconciliation

- ASSUMED: reach/reversal remain optional for legacy declarations, per the corrected additions-only sketch; typed Presence/nonlocal declarations are validated. This is a contract enhancement: the audit REFUTED inability to express reversibility as a defect.
- ASSUMED: canonical intent is LIVE per the explicit PR.6 brief, operator label Listed/info. HELD controls sends, so no channel observation verifies the hold itself. PR.7 acknowledged LIVE; no local readiness converter exists.
- ASSUMED: no new menu-description token; existing --nds-text supplies the required contrast. No ScopeBar behavior change. Web-only Views host/catalog integration stays web-only; shared DS components/styles and declared outputs are mirrored.
- QUESTION FOR OWNER: ScopeBar/ModeNotches exact accessibility repair scope; pending.
- QUESTION FOR OWNER: value-preserving rail-chevron alias in review-pending.patch; pending.
- QUESTION FOR OWNER: if the six conservative stacked-ground combinations must be accepted as mounted grounds, authorize the further candidate text-token values (including warning-text), or establish the renderer-specific applicability. No new token or candidate is applied.
- REQUEST MX.F grid CSS/barrel hunks: resolved by explicit MX close-out; both forks applied. The earlier ownership question is obsolete because of that receipt, not elapsed time.
- REQUEST PR.7/PR.8 pending-write sentence: “Wait for the pending write to finish.” in both description and title; delivered. Producer/consumer mounting remains theirs.
- REQUEST PR.7: mount CellSaveMark beside CellSaveReason in sheet cells. Delivered; mount verification is outside PR.6.
- REQUEST PR.7/PR.8: repoint seven inline-message sites: MasterSheet, FamilyVariants, FamilyBar, FamilySelectionBar, SheetToolbar, GridViewsMenu, GdsScenarios. PR.6's GridViewsMenu now uses nds-inline-error; other owners retain their files. InventoryGrid keeps the stock class.
- REQUEST PR.8: SheetStatuses exports and padding specificity repair delivered; desktop0/6px retains the existing <=1279px padding-block6 policy. No new collapse ladder, Transfer merge or gutter.
- REQUEST PR.7 formatter move: ago/when moved once into DS format and the old drawer path re-exports them; atomic paired save acknowledged.
- REQUEST PR.4: optional built shared-runtime move of presenceVerdict must be atomic with DS re-export and retain canonical type imports. No acceptance/move observed; current DS function remains authoritative.
- REQUEST PR.7 REFUSED/null timestamp: fixed and pinned by test; Could not ask stays distinct from Not checked.

No production/channel/DB operation, no commit, no ScopeBar edit, no baseline increase. The catalogue README append missed its separate exact-path pre-claim; this procedural error is disclosed in the ledger, with the exact read showing only closed prior claims.
