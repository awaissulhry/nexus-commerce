# Product editor attribute foundation — implementation and acceptance record

Implemented 2026-09-05 after the approved attribute audit. The editor now derives Master specifications from product families and channel specifications from the selected marketplace category. This replaces the Amazon-derived Master field union and separates shared facts from listing overrides. The current field-by-field manifest is [the attribute inventory](2026-09-05-product-attribute-inventory.md); the [initial audit](2026-09-05-product-attribute-audit.md) records the earlier state.

The foundation is implemented and locally verified. Complete marketplace capability coverage and publication acceptance are **not yet established**. The remaining work is recorded below, including an actual eBay authentication blocker.

## Product model and editing behavior

Use three existing concepts with separate responsibilities:

| Concept | Responsibility | Behavior in the editor |
| --- | --- | --- |
| Product family | Shared attribute template with additive inheritance | Master shows universal fields plus the effective family definitions. |
| Internal category tree | Classification and merchandising | Classification selects a primary category and additional memberships. A category can suggest a family; applying that suggestion is explicit. |
| Channel category per marketplace | Amazon product type or eBay leaf category | Selects channel fields, options, limits and requirements. Existing listing assignments take precedence over category defaults. |

The existing family, attribute, category and mapping tables remain the authority. Classification saves check the record version and update classification transactionally. Unassigned variations inherit the root classification; explicit child classifications remain supported by the existing model. Changing the classification retains stored attributes. Unclassified products show incomplete setup instead of borrowing an Amazon schema as their Master template.

Master edits shared facts; an Amazon or eBay attribute edit targets the selected listing layer. Shared native facts inherit in every content locale. Dotted attribute mappings also honor parent inheritance when a variation has no own value. Channels use declared semantic mappings and exact saved Master keys as defaults; existing operator mappings retain precedence. Explicit listing overrides win, and restoring Follow Master ignores stale synced snapshots and old override columns. Decimal prices stay numeric and zero stock remains a real value. Brand uses the same store for reading and writing. Account and alias coordinates remain explicit. Ambiguous requests to write one category attribute into several different listing contexts are refused. Missing channel metadata cannot make an unknown channel field fall back to a Master write.

Shared bullet points are one ordered list with no marketplace-specific count limit. Channel categories apply their own limits to listing content. Lists retain arrays, measurements retain value/unit pairs, and impact protectors retain zone/standard/level records. The record drawer and grid have matching structured controls. Localization saves preserve other languages, support the selected content locale, and check concurrent versions.

## Organization

| Scope | Default group sequence |
| --- | --- |
| Master | Identity → Content → Specifications → Identifiers → Dimensions and weight → Compliance and traceability → Pricing → Inventory → Additional saved attributes |
| Amazon | Identity → Classification → Product identity → Product details → Variations → Images → Safety and compliance → Offer → Shipping |
| eBay | Identity → Classification → Content → Item specifics → Variations → Images and media → Offer → Shipping → Policies |

Required fields lead within their group. Related fields then follow a deliberate sequence: model/material and sizing; weight and its unit; length/width/height and their shared unit; offer condition/price/quantity; certification and notified-body details. Remaining external schema fields sort alphabetically. Expanded slots stay together and receive distinct numbered labels. The grid, column picker and export share the server order; saved personal layouts are retained.

Mixed-family rows carry their own effective family ID, applicability and requiredness. A glove variation does not acquire jacket-only requirements. Family ordering is retained within groups; a mixed-family header uses the earliest declared position deterministically. Family and category selection have dedicated Classification controls. Media and variation relationships also retain their dedicated surfaces. Their absence from a particular attribute group does not imply that the product model lacks them.

## Inheritance and preview consistency follow-up

The Studio cell, mapping preview and mapping validation now use the same effective channel result. Explicit target-field overrides win even when an operator mapping reads another source. Deliberately cleared overrides remain empty. Stored channel-only settings appear in preview even without a saved mapping. Lists keep their shape; validation checks each enum member, count, character and UTF-8 byte limit. Required counts include populated fields once, and transforms/defaults run before validation.

Studio evaluates mapping separately for each listing alias and selects its category and listing store. The primary listing no longer supplies every alias preview. The scope readiness service runs the same mapping evaluation, and reports unavailable if that evaluation fails. The existing outbound marketplace-specific serializers still require the capability acceptance described below; this change does not certify every publisher.

Configured custom-field constraints are carried into bulk writes, localization and readiness: string min/max length and pattern; numeric minimum/maximum, exclusive bounds and decimal multiples; list min/max count, uniqueness and per-item length. Clearing an optional fact remains supported. This is a defined validation vocabulary, not an interpreter for arbitrary JSON.

Existing mapping rules are intentionally retained. For example, the fixture's Amazon `fabric_type` rule reads `categoryAttributes.material`, which is empty even though a historical `fabric_type` value exists. The grid now shows that mapping's empty result and required error consistently with preview. Correct the mapping or fill the actual source as part of catalog review; do not hide the conflict by displaying a different value.

## Catalog changes applied

Added 10 families, 23 shared attribute definitions in two groups, and 10 corresponding internal category branches using the existing models. The 23 definitions include existing native stores for origin, customs and protective-equipment facts; they do not create parallel text copies of those native values.

| Family | Parent | Effective dictionary attributes | Directly assigned roots |
| --- | --- | ---: | ---: |
| General product | — | 6 | 0 |
| Apparel | General product | 14 | 0 |
| Protective apparel | Apparel | 18 | 0 |
| Jackets | Protective apparel | 20 | 8 |
| Gloves | Protective apparel | 21 | 2 |
| Suits | Protective apparel | 20 | 1 |
| Trousers | Protective apparel | 20 | 0 |
| Rainwear | Apparel | 14 | 1 |
| Coats | Apparel | 14 | 0 |
| Accessories | General product | 6 | 2 |

These counts exclude universal editor fields and historical saved attributes. Certification fields start empty and optional; the seed makes no product certification claims. Garment class and structured garment protectors belong to jackets, suits and trousers. Gloves instead add certification standard, protection level and knuckle impact protection. This distinction follows the separate garment and glove schemes described by SATRA: [EN 17092 garments](https://www.satra.com/ppe/EN17092.php) and [EN 13594 gloves](https://www.satra.com/ppe/EN13594_mc.php). Rainwear does not inherit the protective-equipment template.

Fourteen known roots were classified. Twenty-two eBay listing shells and one untitled root remain unassigned because the available identity does not establish an appropriate product family. Their data was retained.

Twelve category-to-channel defaults were imported from consistent existing assignments and remain marked as unreviewed. Four Amazon Jackets mappings—IT, DE, FR and ES—had conflicting `COAT` and `OUTERWEAR` evidence. No arbitrary default was created for those coordinates; existing listing assignments and legacy Amazon defaults remain usable. A new listing in those coordinates still needs an explicit product type or a reviewed category mapping.

No product attribute values were changed by the setup scripts or validation checks. Root classification was the intentional product-data change. No listings were published. The native origin/legacy origin conflict scan found zero conflicting nonempty pairs. Other historical facts are preserved under Additional saved attributes until their meaning can be reconciled; similar labels alone are insufficient grounds to merge or delete values.

## Corrections to the audited gaps

| Initial gap | Current behavior |
| --- | --- |
| Master imported marketplace attributes | Master uses effective family definitions and retains saved historical values separately. |
| Native compliance facts absent | Existing origin, customs, PPE, notified-body, declaration and protector stores are available through applicable family definitions. |
| Confusing duplicate controls | Foreign channel controls removed; shared bullets consolidated; image slots numbered; package dimensions share one unit control; saved camel-case keys receive readable labels. |
| Different category contexts across consumers | Listing/category context is carried through sheet generation, row applicability, mapping, bulk validation and readiness; mapping/preview validation respects the primary connection. |
| eBay schemas unioned across categories | Cached specs are loaded per leaf category. Row editors and validators project that category's actual requirements, options and cardinality. Missing schemas are explicit. |
| eBay listing fields and representations incomplete | Listing price/quantity added; stored condition, format, duration and unit values normalized; seller-policy and category selectors added. Exhaustive outbound capability coverage remains open. |
| Unsafe shape/localized writes | Structured controls, typed boolean/number coercion, list validation, category slot limits and localized version checks prevent the tested losses and misroutes. |
| Metadata freshness invisible | Requirements panel shows selected category and fetch time, supports refresh, preserves cached requirements on failure and keeps errors visible. |
| Duplicate variation axes | Known translated Color/Size identifiers normalize to two canonical axes. Sparse historical axis values are retained. |

## Verification

- 325 focused API tests pass across 26 files, covering schema construction, stores, category isolation, family definitions, localization, classification concurrency, refresh behavior, values, readiness and mapping catalogues.
- 270 focused web tests pass across 15 files. Full API and web TypeScript checks pass; shared package build passes.
- Existing live channel suites pass 13 checks for Amazon and 13 for eBay against the local API.
- Eighteen live bulk dry-run checks pass, including title length boundaries, zero quantity, typed false, invalid quantity/enums, structured protectors, large shared bullet lists, foreign fields, ambiguous channel fan-out and oversized channel slots.
- All three live scopes have unique keys and labels, a cell for every declared column, and no editable/writable channel cell targeting Master. Every mapped display value equals its preview value, and no readiness field carries both a warning and a blocking error. GALE-JACKET has 21 rows and 56 Master, 162 Amazon and 49 eBay contract columns. SKU is in the identity band, so the pickers show 55, 161 and 48.
- The catalog audit verifies all 10 effective family profiles, including garment/glove/rainwear separation, 14 classified roots and 12 mappings.
- Browser review covers all three scopes, classification save, grouped attributes, the record drawer's structured list/protector controls, and the persistent eBay refresh failure state. The follow-up also exercises the actual Reconnect action: the popup opens, then the connection page reports `Credential blob failed authentication` before eBay sign-in.

The live bulk cases use `dryRun: true`; they verify validation and routing contracts without altering attribute values. They do not substitute for saved-value round trips through every marketplace field or an external publication validation.

Reproducible scripts: `apps/api/scripts/audit-attribute-foundation.mts`, `seed-attribute-foundation.mts`, `initialize-product-classification.mts`, and `verify-attribute-foundation.mts`. Seed and initialization default to plans and require `--apply` for catalog changes. Initialization skips already classified roots and leaves conflicting mappings unresolved.

## Remaining acceptance work

The catalog import/export workflow and responsive toolbar follow-up now have a separate [implementation and review guide](2026-09-05-catalog-transfer.md), including the file contract, live verification and current batch limits.

1. **Restore the local eBay connection.** Refresh for category `177104` returns HTTP 503. The connection token service reports `Credential blob failed authentication`, and application-credential fallback is unavailable. The stored ChannelApp client-secret bundle cannot be decrypted by the local environment. Restore the matching `NEXUS_CREDENTIAL_ENC_KEY` locally before retrying Reconnect; the user should not paste the key into chat. Signing in alone cannot fix a failure that occurs before OAuth starts. Fresh category policies and seller-policy options then need verification. Do not bypass credential authentication. The editor retains the cache fetched 2026-08-20; the Amazon OUTERWEAR cache used in verification was fetched 2026-09-04.
2. **Complete category and product evidence review.** Resolve the four Amazon Jackets mapping conflicts, review the 12 imported defaults, classify genuine products currently represented by unassigned shells, and decide which family attributes the catalog team requires. The seed does not invent required facts or infer certification values.
3. **Finish full channel capability and payload coverage.** The current eBay adapter represents 20 cached aspects plus 28 listing fields for the verified leaf; it is not an exhaustive Inventory/Trading/regulatory/identifier capability inventory. Amazon conditional requirements are represented as candidates, but full conditional JSON Schema evaluation and lossless round trips for every nested record/selector combination are not implemented or proven. Unknown shapes are protected from unsafe generic editing.
4. **Finish validation and publisher extensions.** Exact per-family applicability, requiredness, ordering, and the supported custom-field constraints are now implemented and tested. Nonstandard validation JSON outside that vocabulary and arbitrary constraints attached to native structured fields still need explicit adapters. Full Amazon conditional/nested schema validation remains in the channel-capability work above.
5. **Validate representative saved products and outbound payloads.** Exercise supported families/markets with fresh schemas and actual saved read → edit → reload → preview consistency, then marketplace validation. Alias-specific mapping evaluation is implemented with regression coverage for primary/alias isolation; representative saved alias round trips remain part of external acceptance. Broad semantic data deduplication must follow a reviewed conflict report.

These are the remaining conditions for an end-to-end “nothing missing / AAA complete” claim. The implemented category-driven foundation removes the audited Master/channel confusion, while this record keeps the remaining software and external verification gaps visible.
