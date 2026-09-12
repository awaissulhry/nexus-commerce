Shopify product families and custom data — architecture recommendation, 9 September 2026

Recommend a dedicated **Shopify → Product family** page in the product editor. Keep colour products separate on Shopify, with Nexus managing their shared family, membership, order and content inheritance. Make the grouping strategy configurable per connected store and family; colour is the initial use case, not a platform-wide assumption.

The merchant subsequently asked whether native variants can also provide colour-specific galleries and metafield/metaobject content. **Yes: this content requirement does not itself require separate Shopify products.** The recommendation to preserve separate products follows the original requested listing structure; the family workspace should support either structure.

For native variants, a proposed product-specific reusable entry such as “Jacket / Red content” can hold red gallery references and red feature/media-with-text entries. Red/S, Red/M and Red/L can reference that same entry, while blue sizes reference “Jacket / Blue content.” Nexus lets the operator edit the colour group once and manages the variant references. Shared defaults and explicit size-specific overrides remain possible. Do not place product-specific galleries inside a global “Red” swatch entry reused by unrelated products.

Shopify [supports one directly assigned image per native variant](https://help.shopify.com/en/manual/products/product-media/add-images-variants); additional images belong to the product gallery. Showing only the selected colour's image group requires theme/app logic. Likewise, storing variant metafields or references does not automatically make product-level theme sections switch content. Every relevant section must resolve the selected variant's content and update on colour changes. Shopify also supports [metafield-linked option values](https://shopify.dev/docs/apps/build/product-merchandising/products-and-collections/metafield-linked), which can supply stable reusable option identities; that feature alone is not a complete colour-content renderer.

The existing [Nexus Impact integration](../integrations/shopify/impact/README.md) and content resolver already contain option-targeted galleries, fields, metaobject references and exact-variant overrides. This is a useful native-variant foundation, subject to the field-coverage gaps below and fresh end-to-end verification. Existing product-level metafield definitions do not become variant definitions automatically; any mapping or extension needs an explicit owner-aware design.

Native variants retain one underlying product identity for product-level fields such as title, handle and SEO. Separate colour products provide independent product identities for those fields. Select the strategy based on those merchandising requirements and storefront compatibility, rather than assuming colour-specific custom content is impossible with native variants.

This is a source audit and implementation proposal. No application code, database, Shopify products or themes were changed. It does not certify the connected store's current schema or claim complete Shopify editing parity. The earlier [migration rollback record](audits/2026-09-09-shopify-family-migration/README.md) remains historical evidence, not an instruction to resume consolidation.

| Product editor destination | Responsibility |
| --- | --- |
| Shopify → Listing information | Native product and sellable-variant attributes, with an explicit Shopify product/variant target. |
| Shopify → Product family | Separate Shopify products, grouping axes, membership, linked options, swatch labels/assets, ordering, native size variants, destination IDs and sync status. |
| Shopify → Metafields & content | Product/variant metafield values, reference pickers, reusable metaobject entries, translations and inheritance. |
| Media → Shopify | Gallery membership, ordering and featured media for the selected Shopify product or variant, using the same mappings as the family page. |
| Connected Shopify store settings | Store-wide definition discovery/management, relationship-field mappings and storefront compatibility. Shared entries also need a store-wide library, accessible from the product editor. |

The existing sub-sidebar already has channel-specific tasks for eBay in [StudioSubheader](../apps/web/src/app/products/[id]/edit/_studio/StudioSubheader.tsx). Its Shopify group currently has only Listing information. Shopify's Media route opens the combined content workspace; moving content authoring to a clear destination should preserve shared state and deep links.

**Confirmed gaps in the current implementation**

| Evidence | Consequence |
| --- | --- |
| [content-workspace.service.ts](../apps/api/src/services/shopify/content-workspace.service.ts) resolves child editors to the primary family listing and makes family children native variants. [content-sync.service.ts](../apps/api/src/services/shopify/content-sync.service.ts) publishes one product and maps its variant IDs to the children. | It cannot express several colour products within one shared Nexus family through this content workflow. |
| [content-import.service.ts](../apps/api/src/services/shopify/content-import.service.ts) explicitly skips keys `variation_products` and `variation_value`, as well as `shopify*` namespaces. | Existing linked-product fields and category metafields are excluded from this import. |
| [shopify-content.ts](../packages/shared/shopify-content.ts) allows 14 field types. Product references, variant references, dates, measurements, ratings and ordinary text lists are absent. | Many Shopify attributes cannot be authored through this workspace. Shopify's [type catalogue](https://shopify.dev/docs/apps/build/metafields/list-of-data-types) documents these additional types. |
| The import reads populated product metafields and referenced metaobject definitions. It does not enumerate all store definitions or import variant metafield values; most definition validations are not retained. | Empty fields, variant-only fields and store-specific validation cannot be represented faithfully. |
| The content schema has one field-definition list without an owner type. [ensureContentDefinitions](../apps/api/src/services/shopify/content-publisher.ts) applies it to both PRODUCT and PRODUCTVARIANT and expects storefront-readable definitions. | Product and variant definitions cannot vary independently; private operational metadata does not fit this storefront publishing contract. |
| [shopifyProductSpec](../apps/api/src/services/pim/channel-specs/store.ts) declares ten core Information fields. It stores `vendor` and `productType`, while content synchronization reads `shopifyVendor` and `shopifyProductType`. | An Information edit is not consistently consumed by the content publisher. That publisher also does not consume the Information fields for category, SEO, handle and template suffix. Saving a field locally is not proof of remote support. |

There are useful foundations to retain: workspace/account resolution, guarded catalog family operations, local revision checks, explicit clears and inheritance, reference resolution, publication checkpoints, metafield compare-and-set and remote readback. The work extends and reconciles these foundations. It must also audit other Shopify write paths; the findings above concern the inspected editor/content workflow, not an exhaustive certification of every legacy adapter.

**Backend model**

One shared Nexus family can contain Black/S, Black/M, Grey/S and Grey/M sellable SKUs. Store A can project it as two Shopify products, Black and Grey, each with native size variants. Store B can project the same family as one product with colour/size variants. Amazon and eBay retain their own listing structures. Presentation grouping must not create a second inventory identity for a SKU.

Use the existing catalog parent/child relationship for the shared family. The database's existing `ProductFamily` model is an attribute-classification family, such as motorcycle jackets; it is not the same relationship. Do not repurpose it or introduce nested catalog children merely to represent Shopify colour groups.

Persist explicit store-scoped group membership and bindings from Nexus SKU IDs to Shopify product, variant and inventory-item GIDs. Identify remote resources by workspace, account and GID. SKU, title, handle and translated colour labels are matching aids, not durable identity. Store membership ordering and selected grouping axes explicitly. Keep Shopify Markets and locales as contexts within the store, rather than inventing duplicate remote product identities for each market.

The relationship configuration must describe which discovered fields hold sibling products, labels and swatches, whether a list includes its owner, and whether it represents siblings, related products or another relationship. Do not infer that every product-reference list is a colour family, rewrite asymmetric lists automatically, or bake `custom.variation_products` into the generic domain model. Ambiguous existing links require a reviewable import decision.

A storefront adapter translates those bindings into the store's existing metafields/metaobjects. The theme must consume them correctly; creating references alone does not implement a colour selector. Native Combined Listings can be a separate capability when the store is eligible; Shopify's [developer documentation](https://shopify.dev/docs/apps/build/product-merchandising/combined-listings) limits it to Plus stores, so it is not the baseline for this architecture.

**Dynamic fields and editing**

Discover the connected store's [metafield definitions](https://shopify.dev/docs/api/admin-graphql/latest/queries/metafieldDefinitions) and [metaobject definitions](https://shopify.dev/docs/api/admin-graphql/latest/queries/metaobjectDefinitions), including unused definitions and existing unstructured values. Preserve owner type, namespace/key, remote definition ID, type, validations, access, capabilities and category applicability. Resolve actual locale and market settings rather than using the current Italian/English defaults as store configuration.

Use one field contract for Information, content editing, import/export, validation, change preview and the publisher. Add typed controls and reference pickers through the Nexus design system. Support eligible definition and entry creation, updates and deletion as store-level operations, with reference-impact previews and capability checks. Updating a shared metaobject must show all known affected products; copying it creates an independent entry when desired.

Keep observed Shopify values, the last synchronized baseline and local draft edits distinct. Preserve unknown types and inaccessible values without coercion or deletion. Show unsupported or restricted fields with a reason. Shopify [ownership and access rules](https://shopify.dev/docs/apps/build/metafields) mean some app-owned data cannot be edited by Nexus, even when it is visible elsewhere in Admin. Full parity needs an explicit capability inventory, not a blanket promise.

Resolve inheritance from shared family defaults through store/family defaults, Shopify product group and sellable variant, with locale/market overrides only where supported. Show the effective value and its source. Distinguish unchanged, explicit empty/clear, and inherit. Inheritance does not authorize writing product-only fields to variant owners. Media uses the same target and source rules while keeping each channel's assignments independent.

**Consistency and acceptance**

Save local membership and mappings transactionally. Publish from a persisted operation plan containing the exact resources, dependencies and changes. Create missing products as drafts, resolve references after their targets exist, and reconcile ambiguous API responses before retrying. A family is synchronized only after every intended binding and value is read back. Partial completion remains visible and recoverable.

Use Shopify compare-and-set where available: [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet) is atomic for a request of at most 25 metafields and supports `compareDigest`. That is not a transaction across all family products, metaobjects and media. A promise of zero temporary divergence across all those requests would be inaccurate. Changes need checkpoints, conflict detection and explicit recovery.

Receive external changes through authenticated, account-scoped webhooks and periodic reconciliation, including definitions and shared entries. Handle duplicate and out-of-order events, tombstones and edits from Shopify Admin without overwriting a pending local draft. Follow targeted write semantics; Shopify's [productSet](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet) reconciles supplied lists, so incomplete imported lists must never become replacement inputs. The existing native publisher already guards against removing unmatched variants; retain that protection.

Acceptance requires evidence for:

- Two stores with different schemas and grouping strategies; identical namespace/key pairs with different owner types or validations; no cross-store or cross-workspace access.
- Import/edit/publish/readback of product and variant fields, ordered/nested references, empty values, false/zero, translations, private fields and unknown types without data loss.
- Add, move, reorder, unlink and archive a colour product; preserve stable IDs, inventory ownership and unrelated product references. Do not automatically delete shared entries when unlinking.
- Shopify-side concurrent edits, schema changes, throttling, timeout after a successful write, interrupted jobs and replayed events; retries must not duplicate products or silently overwrite external edits.
- Shared-entry edits affecting several families; complete pagination; realistic larger families and latency rather than treating the current 250-item content limit as Shopify's universal limit.
- Storefront colour/size navigation, URLs, gallery/content, availability and cart variant identity; keyboard operation and responsive light/dark Nexus UI. Mirror shared design-system changes into Factory and run the required type/token checks.

Recommended implementation order: reconcile the native field contract and build read-only store/schema discovery; add explicit family projections and validated import; implement custom-data and family editing; add resumable synchronization and external-change reconciliation; verify representative stores and storefronts. The first connected-store audit supplies the exact missing-attribute inventory and relationship mappings. No live-store verification or test execution was performed for this proposal.
