# PR.8 toolbar — P-TOOLBAR complete

Signed in, GALE-JACKET (`cmokmy3a40078pm0p1fvnu523`), localhost:3000, 1440×900, light and dark. Clean screen window 19:09:48–19:16:02Z on 2026-09-13. No source saves during the window: full web/factory/API source mtime census found zero changes. Console: zero errors, zero recompiles, eight positive info/connection entries. HMR connections followed full navigations; no Fast Refresh occurred.

No product, view or channel write was performed. Dialogs were opened and cancelled; Requirements was never refreshed. The environment probe names local `127.0.0.1:55439/nexus_development` from API CWD and Neon production from root CWD. Browser API-origin identification remains required before any future write rehearsal.

## Before / after, same measurements in both themes

| Measurement | Before | After |
| --- | --- | --- |
| Live frame | 49 + 40 = 89px | 49 + 40 = 89px |
| Toolbar | x67, y146, 1372×40px | x67, y146, 1372×40px |
| Toolbar client / scroll width | 1372 / 1372px | 1372 / 1372px |
| Shared Warnings | `1 column` | `21 cells` |
| Amazon affected chips | Column breadth printed as count | `342 cells`, `42 cells`, `126 cells`, `127 cells` |
| Filter detail | Cells / columns / rows | Preserved, independently counted |
| Shared trailing command | Classification button, 106.39×28px | No status on these rows; Classification in ⋯ |
| Amazon trailing command | Requirements button, 107.67×28px | Requirements status, 102.33×28px; command in ⋯ |
| Requirements status interaction | Opens a modal | Explanation tooltip, zero modals |
| Requirements command | Toolbar control | ⋯ opens actual 560×194.80px dialog |
| Views trigger | Replaced while naming | 124.14px trigger remains |
| Save-view prompt | Inline 345px group, 180px input | Portalled 320×126px, 292px input |
| Required movement on prompt open | x606.52 → 770.19, +163.66px | x832.27 → 832.27, 0px |
| Find width during prompt | 317 → 259.76px | 317px |
| Sheet padding | 0px 6px | 0px 6px |
| Actual route fallback | 48 + 44 + 34 = 126px | 49 + 40 = 89px |

The fixed Required/Languages controls select columns and retain column units: Shared `1 column` / `64 columns`; Amazon `31 columns` / `13 columns`. The affected-cell ViewChips now print their producer's quantity. Null means not counted; measured zero keeps its unit. The Owner-approved test prints `63 cells` and still asserts `3 columns` and `21 rows` in the filter detail. Separate tests prove the renderer does not infer the count from affected cells/columns and cover variants and axes.

The typed slot accepts readonly `SheetStatus[]`, not a React node or command callback; compile-negative assertions cover both violations. Its DS detail affordance may show the fact's explanation. Classification and Requirements open from the existing overflow, and their dialogs are mounted outside the bar. Pending writes add `Wait for the pending write to finish.` in both title and keyboard-reachable description, preserving each unblocked item's prior reason.

## Padding and skeleton

Before: generic `.nds-gridcard .nds-toolbar {padding:14px 16px}` competed with `.nds-grid-sheet .nds-toolbar {padding:0 6px}`, both specificity (0,2,0). Neither literal was in a studio stylesheet. After: PR.6's `.nds-gridcard.nds-grid-sheet .nds-toolbar` has specificity (0,3,0) and owns `padding-block:0; padding-inline:var(--nds-space-6)`. Obsolete sheet padding declarations were deleted in both DS mirrors. The existing ≤1279px block-padding override remains; D23's ladder/gutter decisions were not changed. CSSOM positive controls show generic and specific rules, computed 0px 6px, and no inspection errors in both themes.

PR.7 removed the dead tabStrip/mergedRow blocks and the third skeleton band. The old 129px audit figure double-counted borders: actual before was 126px, 37px taller than the live frame. The after fallback itself was measured at 49+40. Its dark screenshot captures the skeleton. The light transient DOM also measured 49+40; the subsequent screenshot had advanced into sheet loading and is explicitly named `clean-after-light-fallback-navigation.png`, not claimed as a light skeleton screenshot.

## Evidence and validation

- Actual applied full web tsc, private build-info: **exit 0, zero diagnostics** — `web-final-tsc.log` / `.exit`.
- Actual node-only Vitest: **8 files, 63 tests passed, exit 0** — `toolbar-final-tests.log` / `.exit`. Rendering uses react-dom/server; no browser test environment.
- Clean screen files start `clean-`: master/Amazon light/dark measurements, filters, modal screenshots, prompt geometry, padding CSSOM, fallback samples, and `clean-console.json`.
- Before files start `before-`, plus `before.json`. `status-final.diff` records the paired status changes; `paired-source-hashes.json` records 22 applied paths.
- `after-*` files are historical interim evidence from a disturbed earlier run, superseded by `clean-*`. Earlier validation/history remains in `README-before-clean.md`.

## Decisions and handoffs

D23 Owner question resolved by “I'll go with your recommendations, so please get it all done.” Producer quantity was applied. PR.6 supplied typed status, compact detail, portalled Views with Menu.selectedId, pending-write description support and padding ownership; its W2-DS DONE was read at 19:14:23Z. PR.7 explicitly released the exact producer/dialog compatibility hunks; the paired save landed and paths were returned. PR.7 owns the skeleton/CSS cleanup. Closed Matrix lanes allowed additive count/status compatibility only.

ASSUMED: Listings will follow the mounted Matrix under THIS PRODUCT and precede Listing information in each channel group. Matrix was witnessed between Information and Variants. Exact future nav/type/tab-host/master-scope patch requests remain in the ledger. No Listings mount, full Listings gate or PR.8 AT-WAVE-4 is claimed. W2-READ and W3-API remain required; W2-WIRE and W2-DS are complete. The legacy Listing Hub is untouched. Nothing committed.
