# Shopify linked products and custom content — implementation record

The product edit page now has **Shopify → Product family** and **Shopify → Metafields & content**. The first manages an ordered group of existing Shopify products, keeping each colour as a separate product. The second edits the selected product’s metafields, its native size variants’ metafields, and referenced reusable entries.

Choose the theme’s existing product-reference list, import a source product’s links, review the members, and save the Nexus draft. Synchronization applies the reviewed order to all members. The field name, store, products, entry types, owner types and validations come from the selected connection; the application does not assume `custom.variation_products` or a particular set of colours.

The live read check found that exact relationship field in the connected Xavia store, alongside 39 product/variant definitions, 22 metaobject definitions and five published locales. Product values, native variants, exact metafield reads, file/product/variant/page/collection searches and metaobject fields/references were read successfully through the new gateway. See [read results](live-read-results.json) and the repeatable [read-only check](read-shopify.mts).

**Editing behavior**

- Product and variant definitions stay separate. Existing values without a definition remain visible. App-owned/read-only definitions are protected. Unknown or structured types retain a raw editor; numeric lists and rich-text trees are preserved without coercion or flattening.
- File and metaobject references have searchable pickers, readable names, ordered lists and explicit removal. Common scalar/list validation is checked locally and on the API; Shopify remains authoritative for store-specific constraints.
- “Apply to family” stages a common value on every colour product. Individual changes continue to target only their selected owner.
- A shared metaobject shows its direct references (the first 100, with an explicit indication when more exist). Its fields and active/draft visibility can be edited. “Make a separate copy” creates independent content and stages its replacement reference on the selected product; nested references remain shared.
- Draft changes survive product/variant selection and are guarded when leaving the page. Conflicting local saves retain the unsaved UI values; loading the saved draft requires an explicit discard confirmation.

**Synchronization behavior**

Drafts and operation checkpoints live on the existing family/store ChannelListing, preserving other attributes and SKU/inventory relationships. Writes resolve the explicit account and family, use serializable transactions and listing-version checks, and separate view/edit/publish permissions. No database migration is required.

The complete reviewed relationship is checked against fresh Shopify values, including siblings that initially needed no change. A selected product with links to unreviewed family members cannot have those links silently replaced. Replacement imports retain observations for removed products; unlinking preserves their unrelated references. Field edits outside the reviewed product family are refused, including native variants belonging to another product.

Publication uses targeted metafield operations, persisted progress, compare digests for sets, explicit readback and resumable interrupted operations. Final verification covers the entire reviewed family, including earlier batches and initially unchanged siblings. A saved separate-product workspace is protected from the existing native-variant content publisher; a native publication already in progress blocks enabling the separate-product workspace.

Shopify supports atomic [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet) requests of up to 25 values. Larger families and mixed clear/set plans therefore have multiple operations, which the review explains. [Metafield deletion](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsDelete) and [metaobject updates](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metaobjectUpdate) do not expose the same compare-digest guard. These paths use fresh comparisons and readback; this is not a claim of global atomicity or impossibility of a concurrent Shopify edit.

**Verification**

- 109 tests passed: [51 API tests](api-tests.log), [38 web tests](web-tests.log), and [20 shared-contract tests](shared-tests.log). Coverage includes membership/order/unlinking, replacement imports, account isolation, variant ownership, definition drift, conflicting values, larger batches, lost acknowledgements, legacy publication guards, entry copies and visibility, permissions, malformed rich text, numeric preservation, and accessible ordering labels. Database and Shopify mutation responses in these tests are simulated.
- API, web and Factory TypeScript checks passed: [API](api-types.log), [web](web-types.log), [Factory](factory-types.log).
- Web/Factory token generation checks, token resolution, CSS parsing, append-only DS gaps, and primitive/hex/shadow ratchets passed. The changed OrderedList component and catalog example match in web and Factory. The broader existing Factory copy reports 13 drifted files and 143 missing upstream files; see [parity report](ds-parity.log). Those unrelated differences were preserved.
- Browser checks exercised the real StudioClient and new components against the [isolated fixture](browser-fixture/server.mjs): keyboard ordering, search/excluded products, colour-specific changes, nested image selection, copying a shared entry, variant fields, before/after review, interruption/resume, save conflicts, discard/cancel navigation guards, and light/dark layouts at 1440×1000 and 390×844. Final mobile document width equals viewport width. No browser warnings/errors were recorded after the final navigation.
- [Captured family-order requests](browser-fixture/evidence-family-order.json) show both sibling links verified. [Final captured requests](browser-fixture/evidence-final.json) show red referencing the new entry, blue retaining the original, Blue/Small receiving its own field, two distinct entries, and no remaining draft edits. These are synthetic products, not live Shopify mutations.

Screenshots: [family](screenshots/family-light.jpg), [desktop dark](screenshots/desktop-dark.jpg), [mobile light](screenshots/mobile-light.jpg), [mobile dark](screenshots/mobile-dark.jpg), [variant review](screenshots/variant-review-dark.jpg), [interruption](screenshots/interrupted.jpg).

**Rollout boundary**

This change was implemented and checked locally. No real Shopify product, field, entry, theme, inventory or publication setting was changed, and nothing was deployed. Live mutations and their storefront rendering still need a controlled validation with the store’s actual theme and permitted write settings.

This workspace manages existing Shopify products and their custom-content values. It does not implement full Shopify Admin parity: definition administration, translations, separate-product creation, a replacement core-media publishing workflow, and custom-data webhook reconciliation are not added here. Existing translations and unrelated product/media values are left untouched. The earlier [architecture proposal](../../2026-09-09-shopify-family-workspace-proposal.md) describes that wider scope; it should not be read as a completed implementation checklist.

Run the browser fixture from the repository root with `node docs/audits/2026-09-09-shopify-linked-products/browser-fixture/server.mjs`, then open `http://127.0.0.1:3142/products/store-demo/edit/studio?scope=SHOPIFY&market=GLOBAL&tab=shopify-family`.
