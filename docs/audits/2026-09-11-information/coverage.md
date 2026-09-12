# Field and capability coverage

The [machine-readable field record](evidence/field-capabilities.json) captures each fixture column, type, storage, requirement metadata, options and per-row write destination/owner. Counts include structural contract columns; UI views may omit those columns or expand repeated slots. This is a representative contract inventory, not a claim to have tested every provider category or store definition.

| Scope | Captured contract | Completed Information path | Evidence and limits |
| --- | --- | --- | --- |
| Shared product | 37 columns; parent + 2 variants; Italian/German | Family dictionary authority, parent/variant restrictions, localized prose, typed scalar/list/record/measurement editing, conditional requirements, inheritance/reset, formulas and history | Actual routes test localized and typed saves/reloads, conflicts, regional `pt-BR`, formula locale ownership. Browser tests composition validation/correction and child refresh. Reviewed definitions applied to the isolated local GALE family; production remains unchanged. |
| Amazon | 12 representative columns per account; 2 accounts × 3 aliases × 3 rows | Seller-specific product-type schema, applicability and conditional requirements, serialized validation, shared mappings and exact listing overrides/formulas | Conditional UTF-8 rejection through real save route; vocabulary tests cover selectors/uniqueness and structured serialization. Browser common-sheet read. Arbitrary nested/repeated provider objects without a supported editor are explicitly unavailable for editing and preserved; no lossy text conversion. Live seller requirements were not mutated or exhaustively sampled. |
| eBay | 32 columns per account; same account/alias/row matrix | Site/category aspects, strict/open options, multiplicity, variant applicability, identifiers/condition/content ownership, existing theme/order references | Actual option save/reload on additional-account alias; invalid value refused and siblings unchanged. Existing specification/reference tests cover category vocabulary. Browser read and rapid scope-switch check. Publication eligibility is a separate result. |
| Shopify | 37 contract columns per account; same matrix | Native product/variant controls, typed definitions and references, category/access restrictions, exact remote owners, draft CAS/recovery, locale-aware content and existing sync review | Real common-sheet/cells route with provider reads stubbed only; native title + boolean metafield save/reload, wrong-version refusal, exact new cell history, owner applicability and corrected completeness. Browser additional-store alias save/provenance/focus return. Existing gateway/reference/metaobject/sync suites pass. No live provider write or full Markets/catalog infrastructure verification. |
| Etsy | 59 contract columns per account; same matrix | Base listing facts, taxonomy properties, stable property/value IDs and scales, localized Nexus drafts, named shop references, mappings/formulas and alias overrides | Actual category/property/empty-list saves, category change preserving incompatible old values, exact history. Browser German alias saves, post-commit interrupted-response recovery and named shipping-profile selection. Resource tests cover account identity/pagination. These saves do not publish to Etsy; inventory offerings and personalization workspace remain outside this phase. |

## Actual requested page

[GALE Information](http://localhost:3000/products/cmokmy3a40078pm0p1fvnu523/edit/studio?market=GLOBAL) uses the running API on port 8091 and its isolated development clone, not the disposable fixture. [Actual field/destination record](evidence/actual-page-capabilities.json) covers seven reads, each with one parent and 20 variants:

| Scope | Actual contract | Observed result |
| --- | --- | --- |
| Shared · en/de | 235 columns, including 200 family facts | German name shows Italian fallback; German bullet content shows English fallback. Requested/effective language stays explicit. New composition/size-system definitions are available. |
| Amazon · IT/DE | 161 / 163 columns; selected environment-managed account | Seller PTDs load. Required preset and completeness include active conditions. Missing repeated values point to required slots, not every optional slot. Existing conflicting/missing facts remain flagged. Belgium returned provider access denied and was accurately shown as requirements unavailable. |
| eBay · IT | 51 columns; category 177104 | Primary xaviaracing and additional motovento accounts show independent values and requirement counts. Primary is Blocked despite 100% required-field population because variant values are invalid. |
| Shopify · GLOBAL/en | 73 contract columns | GALE has no persisted remote Shopify owner; this checks the unlinked Nexus draft path and store definitions. Remote-owner saves are covered by controlled fixtures. |
| Etsy · GLOBAL/en | 57 columns | Base fields and local draft state load; GALE has no selected Etsy category. Category-property editing is covered by the controlled selected-category fixture. |

No actual GALE field values were edited. Named-alias mutation checks remain on controlled fixtures; the real-page observations do not claim live provider delivery.

## Value/editing contract

| Value or operation | Behavior |
| --- | --- |
| Text, long text, numbers, boolean, date, select/multiselect | Existing typed Nexus editors; dictionary or selected provider options/constraints; false and zero remain present values. |
| Lists and explicit empty list | Arrays stay arrays; slot writes retain siblings. Resetting an inherited list clears the whole owned override, with explicit confirmation. |
| Measurements | Typed value/unit contracts; stable units and bounds. Historical separate value/unit fields remain available without rewriting saved bags. |
| Structured composition | Repeatable material-code/percentage records; pairing and unknown properties preserved; total, bounds, required members and uniqueness validated. |
| Unsupported historic/provider structures | Saved data remains visible/preserved, with an accurate unavailable editor explanation. No automatic conversion. |
| References | Existing typed provider pickers; Shopify product/variant/metaobject identities and Etsy named resources. A missing Nexus adapter is explained as an adapter limitation, not a provider prohibition. |
| Inheritance and override | Missing, fallback, inherited, explicit override, explicit null/empty and reset remain distinct. Clear override returns to the applicable parent/shared/mapping source. |
| Paste/fill/bulk/formula | Existing shared engine routes through type validation and exact account/alias identity. Formula database tests cover independent account/alias/locale writes, replay, recalculation, conflicts and undo/recovery. Canonical fields get one formula across locale views; channel formulas cannot write canonical facts. Shopify continues its existing typed draft path. |
| History | Newly attributed product, localized, formula and Shopify cell events are filtered by exact field/account/alias/locale. Older events without a trustworthy destination are retained, not reassigned. Shopify history marks whether its before-value came from a Nexus draft or provider baseline. |

## Shared inventory disposition

The [198-definition Jackets review](../2026-09-11-pim-management/shared-attribute-review.md) remains the per-attribute disposition record: 14 core facts, 19 overlapping concepts, 23 measurement/size facts, 55 conditional compliance/battery/expiry facts, 47 optional merchandising facts, 12 ambiguous concepts, 27 other-family facts and one channel-owned default. Those are review categories, not bulk-delete instructions.

Core identity, brand/manufacturer/model, material/composition, variant color/size, audience/fit, origin, care and warranty remain reusable facts. This phase adds an optional composition record and size-system code, makes care/fabric/warranty prose localizable, preserves stable variant ownership, and improves existing numeric/unit definitions. No channel schema was copied wholesale into Shared product. Family requiredness is authoritative; provider-only family requirements do not become universal requirements.

Overlaps such as exact/standardized/branded color, pattern/type, pocket counts, package quantities and temperature wording retain their old keys and mappings. No equivalence was inferred solely from similar names. Compliance/battery extensions use applicable conditions where configured. Optional/other-family historical facts remain available through the full view; imported shells receive no automatic family. `shopify_product_type` remains historical content and a candidate for a deliberate Shopify mapping correction, not an automatically deleted field.

## Provider contracts checked

- Amazon's custom vocabulary and seller requirements: [PTD meta-schema](https://developer-docs.amazon/sp-api/docs/product-type-definition-meta-schema), [retrieve a product-type definition](https://developer-docs.amazon/sp-api/docs/retrieve-a-product-type-definition).
- eBay category requirements: [item-specific requirements](https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/item-specifics-requirements.html).
- Shopify definitions, app access and category constraints: [definitions](https://shopify.dev/docs/apps/build/metafields/definitions), [admin access](https://shopify.dev/docs/api/admin-graphql/latest/enums/MetafieldAdminAccess), [conditional definitions](https://shopify.dev/docs/apps/build/metafields/conditional-metafield-definitions). Repository API contract remains pinned to 2026-07.
- Etsy taxonomy/resources/content: [Open API reference](https://developer.etsy.com/documentation/reference), [listing tutorial](https://developers.etsy.com/documentation/tutorials/listings/). Language choices do not invent independent market inventory or publication states.
