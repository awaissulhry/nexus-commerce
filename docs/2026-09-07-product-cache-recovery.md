# Product cache and save recovery verification

Verified on 7 September 2026. This closes the audited Information-grid cache and interrupted-save cases. It does not certify the entire product workspace.

Family changes now update ProductReadCache inside the same serializable transaction as their source records. Coverage includes attach, move, unlink, promote/demote, child creation/deletion, the protected legacy parent-delete route, and alias creation. Catalog import applies the product/listing change, cache projection, audit record and target checkpoint together. A cache failure rolls back that transaction; imports still commit per target rather than per file.

The projector batches source reads and deduplicates affected products, including both the former and current parent. This refreshes parent child counts, channel coverage and borrowed thumbnails when a child moves or disappears. Existing category paths, fulfillment derivation and other projection fields remain in use. Independent refreshes use serializable snapshots with bounded retries for projection conflicts. A bulk grid edit now refreshes its affected products as one batch rather than repeatedly projecting the same parent.

Shared product and channel sheets treat interrupted requests, server errors and malformed success acknowledgements as unconfirmed. Recovery reads verify the product, account, market, language and alias before comparing the intended value or inheritance state. They refresh concurrency metadata before releasing queued edits. Missing fields or listing version tokens remain unconfirmed; named references use the existing authoritative resolver. Recovery cannot overwrite newer typing or repaint a discarded edit. The header resolves the original pending save when recovery finishes.

Reload reviews pending, refused and unconfirmed edits in both sheet hosts. Cancel preserves local work. Confirmation discards the selected sheet's local state and re-reads storage; the explanation does not imply that Reload can undo an in-flight or completed server write. A channel conflict no longer reloads away the refused edit automatically.

Browser verification used the real local Web application through an isolated in-memory fixture. Successful API GET responses supplied the initial data. Every PATCH stayed inside the fixture; other writes were blocked. Formula metadata was simulated as empty, so these literal-value checks are not formula-recovery evidence.

| Browser case | Observed result |
| --- | --- |
| eBay title stored, acknowledgement lost | Scoped read recovered the value and both cell/header reported Saved; one write attempt |
| Next eBay title edit | Sent expected listing version 9 after recovering the version-8 attempt; acknowledged normally |
| eBay title request not stored | Kept the typed value with a refusal after comparing storage; no automatic retry |
| Reload Cancel and Escape | Kept the refused value; Escape restored focus to More |
| Confirmed Reload | Restored the second stored title and cleared the refusal without another write |
| Shared-product name stored, acknowledgement lost | Read recovered the value and header/footer reported Saved; one write attempt |
| 600×900 light and dark presentation | Confirmation measured 560×201 pixels inside the viewport; document width remained 600 pixels |

The fixture recorded four simulated writes in total, with expected versions 8, 9 and 10 for eBay and 51 for Shared product. There were no forwarded catalog writes or outbound publication. The browser viewport and initial dark theme were restored. Temporary raw evidence was saved at `/tmp/nexus-cache-recovery-browser-evidence.json`.

Verification passed:

- Full Web suite: **3,510 tests across 258 files**, no skips.
- API relationship/import/alias/account/reference/formula/cache regression: **174 tests across 13 files**. One existing opt-in manual fixture-server case was skipped and excluded from the pass count.
- Production-schema PGlite/PostgreSQL cases exercise actual projection persistence, import plus Parent SKU, old/new parent rollups, cache deletion and rollback after a database trigger rejects the cache update. Import-job fixture tests remain separate from this SQL evidence.
- Web, API and Factory TypeScript checks; Web production build; Web/Factory token guards and generated-token checks; Web conformance and primitive ratchets; design-system CSS parsing.

No shared component styles or tokens changed. The Web-only SheetWriter adapter was extended, using the existing confirmation and grid-status components. Both platform catalogs/changelogs document its boundary, and the Web grid lab includes an unconfirmed-save Reload specimen.

Remaining boundaries: bulk grid PATCH still commits its source write before the awaited cache refresh and logs refresh failure; it is not transactionally coupled like family/import writes. The existing reconciliation job now detects more version, membership and listing drift, but its default repair interval is 15 minutes. Product-list KPI statistics retain their existing 15-second cache. External search-index propagation and every legacy provider/bulk mutation path were not rewritten. Recovery verifies the value/state currently stored, not the historical cause of a mismatch. Browser closure does not provide durable local drafts. PGlite tests do not prove simultaneous multi-connection contention. Fresh seller-reference authentication and broader workspace navigation remain open in the [product sign-off record](./2026-09-07-product-experience-signoff.md).
