# Products recovery and consistency — 15 September 2026

## Recovery on the local development catalog

The 06:52 UTC deletion audit records 16 GALE standalones. Twelve match the requested cleanup: ten orange sizes (XS through 6XL), plus Nero 6XL and Giallo 6XL, created on 12 September. They remain soft-deleted and recoverable. No marketplace listings were removed.

Restored the four additional rows through the authenticated bulk-restore API:

- GALE-JACKET-VPF-NERO-VPF (`cmtxfld9x0008njl2fv0j2h0g`)
- GALE-JACKET-VPF-GIALLO-VPF (`cmtxfldam000anjl2mdym1ydc`)
- GALE-JACKET-VPF-SECOND-NERO-VPF-SECOND (`cmtxi55ic0007nj56na63ysyt`)
- GALE-JACKET-VPF-SECOND-GIALLO-VPF-SECOND (`cmtxi55im0009nj56rark2gp6`)

GALE-JACKET (`cmokmy3a40078pm0p1fvnu523`) and all 20 children are active in the catalog. Production had no deleted products; these recovery writes were local only.

## Causes and fixes

- Bulk deletion launched concurrent serializable cache refreshes. Ten logged write conflicts left deleted rows in the cache. The grid received 24–27 rows but a live count of 14, hiding unrelated products depending on sort. Deletion/restoration now updates the Product row, audit and cache in one transaction. Other refreshes and reconciliation run in batches.
- Cache eligibility previously meant any cached row existed. It now checks for missing, orphaned and stale source revisions; inconsistent projections use the live read path. Reconciliation also repairs the recycle-bin projection.
- Sales grids read Product and its relations directly, with uncached KPI counts in the same serializable snapshot. Other list consumers include catalog count/revision in KPI cache keys.
- AG server-side selection ignores native current-page select-all. LoadedRowsSelectionHeader selects explicit loaded IDs, and newly expanded rows remain unselected. Delete reviews exact SKUs and captures their IDs. Legacy saved layouts cannot restore previous destructive selections.
- Sales and Units headers now visibly include the 7-day period; sales-inclusive GET responses cannot return a stale Product-only 304.
- Local streams now use the existing development connection gate, avoiding permanently queued grid requests after sorting.
- Needs attention now uses the Product images relation and the cache photo flag, excludes listing shells from its count, and correctly labels its filter as missing photos. It previously queried nonexistent Product.photoCount.

- Sales cells, sorting and groups share one order-line calculation using purchase date (creation date only for legacy records), a common cutoff, and cancelled/future-order exclusion. Foreign-currency orders preserve units and produce an explicitly unavailable EUR amount rather than a fabricated conversion.
- Available uses StockLevel.available, after reservations, over the product and its active variants. Deleted variants retain their sales history. One reserved unit was previously overstated locally; production had no reserved stock at audit time.
- Channel filters use actual listing presence. Existing listings remain visible while connection metadata is unavailable. Direct-read listing state classification and thumbnails agree with the cache convention; video assets cannot count as photos.
- Multi-column sorts preserve their priority. Empty/null group labels share one expandable bucket. Old requests cannot overwrite newer filter totals.
- Visible tables and expanded families refresh every 30 seconds and when returning to the tab. Exports reject contradictory counts, duplicate rows and incomplete responses.

## Validation

Read-only comparison across 81 grid requests covered all 20 visible roots: identity, status, brand, type, price, update timestamp, child count, photos/thumbnail, channels, tags, total/FBA/FBM available stock, sales and units. Checked filters, ascending/descending numeric sorting, multi-column sort priority, and sum/average/min/max groups by brand, type and status. Two previously hidden untyped roots are now visible; the shell exclusion no longer excludes NULL product types.

| Local window | Units | Sales |
| --- | ---: | ---: |
| 7 days | 0 | €0.00 |
| 30 days | 84 | €6,617.31 |
| 90 days, attributed | 391 | €37,233.41 |

Local order syncing is disabled and its latest orders are from 7 September. Production independently returned 20 units and €1,872.65 for seven days. The rollback did not remove sales data or alter the calculation window. No orders were fabricated or imported to conceal the stale local snapshot.

Browser checks covered exact-SKU review, cancellation/Escape focus return, selection surviving sorting, select-all/clear by pointer and Space, and expanded variants remaining unselected. Reviewed the modal in light/dark at desktop widths and dark at 390px. Shared component source is mirrored in Factory.

Focused suites: 96 API tests and 84 web tests passed (one existing API integration test skipped). Regression coverage includes purchase-date windows, future/cancelled orders, foreign currencies, reserved/deleted stock, export completeness, response ordering, and atomic deletion rollback on cache failure, unselected products remaining intact, explicit restoration, expanded-family limits, stale cache detection using PostgreSQL, KPI revision keys and legacy saved selections. Web/API/Factory type checks and token, primitive, import-boundary, DS-conformance and fork-drift guards passed.

The browser connection became unavailable during the final recheck. Earlier interactive selection/modal checks are recorded above; the full repository push gate is the final release check. No guarantee of source freshness is implied: the local order snapshot remains intentionally unsynchronised.
