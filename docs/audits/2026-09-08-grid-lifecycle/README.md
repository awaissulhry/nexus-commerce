# Product information grid lifecycle audit — 8 September 2026

Status: fixed and verified locally. No deployment or remote channel writes were performed.

## Reproduced failure

A loaded Shared product sheet encountered a temporary read failure. The error view removed AG Grid while `MasterSheet` remained mounted. Pressing **Try again** evaluated the transfer drawer's `getAllDisplayedColumns().map(...)` against the destroyed API. AG warning #26 was followed by `TypeError: Cannot read properties of undefined (reading 'map')`. A full page reload recreated the host, explaining why the reported problem disappeared.

[Before-fix browser evidence](before-retry.txt) records the exact warning and crash. Existing local application logs also contained destroyed-grid `refreshCells()` warnings from formula repaint callbacks.

## Changes

- Added `useGridLifetime` in the design system, mirrored and exported in Factory. It releases the API before destruction, rejects destroyed instances during deferred work, and tracks replacement instance identity.
- Shared and channel sheets use the live API for formula completion, repaint, selection, preferences and layout callbacks. Old band-measurement retries stop when their grid is replaced; channel event cleanup avoids destroyed APIs. Pending data writes retain their existing settlement behavior.
- Transfer fields use the existing column model's guarded membership lookup.
- Retry reapplies the selected view/chip and initializes the new grid with captured widths, pins and sorting. Channel reloads retain the current destination's schema; the existing URL match continues to exclude data from another destination.
- Failed Shopify and Etsy reads now name the correct channel, using the shared channel-label helper.

The lifecycle follows AG Grid's [pre-destruction cleanup contract](https://www.ag-grid.com/react-data-grid/grid-lifecycle/#grid-pre-destroyed).

## Verification

| Check | Result |
| --- | --- |
| Targeted grid lifetime, writer, column view and channel tests | 382 passed across 26 files |
| Web and Factory TypeScript checks | Passed |
| Web and Factory token checks | Passed |
| AG module registration guard | Passed across 2,352 source files |
| Real editor under React StrictMode: Shared, Shopify, Etsy read failure → retry | Recovered with no browser warnings or errors |
| Shared and Etsy Required views, ascending title/name sort and column widths | Identical before and after retry; [DOM measurements](column-recovery.json) |
| Keyboard title edit and Enter autosave | Acknowledged once in the isolated Etsy destination; value retained after another failure and retry |
| Scope arrow-key navigation | Selection and focus moved together |
| Light/dark presentation at 390px and 768px | Selected channel visible; document width equals viewport width |
| Live local product: Shared → Amazon → eBay → Shared | Grids loaded; observed application log window contained no destroyed-grid warning or runtime exception |

One sandboxed rerun skipped the 13 tests requiring the local API; rerunning those with local network access passed all 13. The final complete targeted run passed all 382.

Browser evidence: [Shared retry](after-shared-retry.txt), [Shopify retry](after-shopify-retry.txt), [Shopify error label](shopify-error.txt), [Etsy error label](etsy-error.txt), [final Etsy recovery](final-etsy-recovery.txt), [isolated save request](isolated-save.json), [Shopify dark at 768px](shopify-dark-768.png), [Etsy viewport measurements at 390px](narrow-viewport.json).

## Reproduce the regression check

Run `node docs/audits/2026-09-08-grid-lifecycle/browser-fixture/server.mjs`, then open `http://127.0.0.1:3136/products/store-demo/edit/studio?market=GLOBAL`.

1. Choose Shared product, Shopify or Etsy. Select Required and sort a column.
2. Click **Fail next sheet read**, then **More → Reload**.
3. Confirm the error names the selected channel, then press **Try again**.
4. Confirm column membership, width and sort are retained, editing works, and the visible browser diagnostics remain empty.

The fixture mounts the real editor with isolated in-memory responses and an error boundary. Its store samples reuse the earlier store-product-information audit fixture. Writes affect only that fixture process.

## Scope and limits

This closes the reproduced grid lifecycle defect and the related recovery inconsistencies. Shopify and Etsy recovery/write checks used isolated data because the current local workspace has no active store connections for those channels. It does not establish that all catalog data is ready to publish: the live Amazon and eBay sheets still report existing mapping and validation issues. The broader product information audit and its outstanding limits remain in [the store audit](../2026-09-08-store-product-information/README.md). The existing browser-based chrome/parity scripts were not rerun in this pass; browser checks used the supported in-app browser.
