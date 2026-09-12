# Information page — phase one

11 September 2026. Implementation and controlled verification for Shared product, Amazon, eBay, Shopify and Etsy. The existing common Information/channel sheet remains the editor. The actual GALE Information page on localhost:3000 and controlled fixtures were verified. The new formula migration and reviewed dictionary definitions were applied only to the isolated local development database. No production catalog values or live listings were changed.

## Delivered behavior

- Account, market, locale and listing identity travel through schema/value reads, formula coordinates, overrides, drafts, recovery and newly attributed cell history. Primary and two named aliases were exercised in each of two accounts per channel; aliases reuse the same canonical products.
- Shared fields come from the family dictionary. Typed editing preserves records, lists, stable option codes, measurements, dates, zero, false, explicit empty values and inheritance. A new shared `RecordListInput` supports paired composition facts and is mirrored into Factory. Family facts, essentials, localized content and requirement/error views reduce the working field set.
- Requested and effective locales, fallback, draft/reviewed and outdated states have a coherent read/write contract. Legacy translation content remains readable. Source changes invalidate supported reviewed translations; fallback text cannot silently count as requested-language completion or become a current-language formula result.
- Channel candidates are resolved and validated before saving, including Amazon's serialized conditional byte limits and selector uniqueness. Category changes preserve historical values and expose incompatibilities. Seller/account schema identity and selected-category requirements are retained. Conditional fields stay in Required and completeness after filling; missing facts are distinguished from broken mapping rules. The environment-managed Amazon account now resolves correctly in single-profile development mode without bypassing workspace/seller checks.
- Etsy properties retain IDs/scales and shop resources use named selectors. Its localized Information writes are explicitly Nexus drafts. Shopify keeps native/variant/metafield/reference owners, store definitions, permissions, draft tokens, recovery and existing synchronization; projected validity now uses the actual displayed owner/value. A confirmed Shopify DRAFT/ARCHIVED product cannot become Live merely because it has a remote ID.
- Errors retain intended edits. Composition rejection now reports the server's exact reason, overrides green readiness, and a corrected save refreshes inherited child values. A lost save response is reconciled by reading the exact destination. Page and cell labels distinguish saved Nexus drafts from provider delivery. The Information page has no no-op publish/review button.
- Complete families are resolved in bounded batches instead of silently stopping at 250 IDs. The disposable API test resolves all 252 products; a separate batch test covers 601 unique IDs.

## Delivery records

- [Scope and field coverage](coverage.md), including supported limitations and the reviewed shared inventory.
- [Verification and limits](verification.md), automated logs, browser observations and screenshots.
- [Safe deployment and dictionary correction](migration.md), with the concrete read-only impact preview.
- [Later-phase backlog](later-phases.md).

The final full runs passed **486 API tests** and **876 web tests**, including the connected local-sheet smoke test, Shopify status correction and final conditional-requirement fixes. API/web type checks and token/mirror checks passed. These counts overlap; they should not be added together. See verification for skipped guards and accessibility limits.

## Release status

The [actual requested page](http://localhost:3000/products/cmokmy3a40078pm0p1fvnu523/edit/studio?market=GLOBAL) now loads all five scopes. Local formula migration preserved 338 Product and 999 ChannelListing rows; the reviewed family correction changed definitions only. The local connected smoke test passes. **Production migration/deployment remain unapplied**, and no live provider write/acceptance is claimed. GALE itself still has missing and incompatible saved information; the editor accurately reports those facts instead of filling or rewriting catalog values.

The AAA product-quality target is **not fully verified**. Keyboard/editor/dialog checks and responsive light/dark observations are recorded, but actual browser zoom, assistive-technology operation and exhaustive contrast/state combinations require further acceptance evidence. Existing primary-button token pairs measured below 7:1 for normal text; the new Information navigation/requirements controls use the existing secondary treatment. This is not a formal accessibility-conformance claim.
