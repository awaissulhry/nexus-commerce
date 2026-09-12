# Nexus × Impact 7.2.0

This integration uses one Shopify product per Nexus family and native Shopify variants for its sellable children. It does not create a product for each colour. Existing linked colour products remain usable until their content is deliberately imported and their replacement family is reviewed.

## Editor and publishing

Open the product editor's Shopify media workspace with an explicit account destination. Manage reusable assets and their descriptive, translated alt text; ordered image groups and featured images; field definitions; reusable metaobject entries; and assignments to the family, option values, combinations or exact variants. Preview any variant before saving. A gallery can replace its inherited gallery or append to it. A field can inherit, override or explicitly clear its value.

Resolution uses scope specificity, followed by explicit priority within that specificity. Exact variants outrank combinations, which outrank individual options and the family. Equally specific, equally prioritized assignments with different results are reported as conflicts. A conflicting draft can be saved, but publishing is blocked. Removing an override restores inheritance. Images can be reused in multiple groups without duplicating their Nexus records.

Family information comes from the canonical parent; SKU, price and inventory come from each canonical child and its account offer overrides. The wizard now builds the full child matrix and refuses an incomplete or ambiguous mapping. The obsolete one-axis image publisher refuses writes and directs users to this workspace. Automated price and stock updates use verified native variant and inventory-item IDs. Inventory updates compare observed Shopify quantity before replacing it.

Saving a workspace is separate from synchronizing Shopify. Synchronization requires a fresh remote review and an explicit inventory location. New products are created as drafts. Updating an active product requires an explicit review of that destination. A successful run reads back variant offers, inventory, definitions, metafields and translations before reporting VERIFIED. Product, file, metafield, inventory and metaobject writes are separate Shopify operations: the workflow is **not an atomic transaction**. Failed or interrupted runs retain checkpoints and report UNVERIFIED; review and retry them before activation. New immutable metaobject handles avoid mutating entries shared with other products.

The existing Shopify write gates remain in force: `NEXUS_ENABLE_SHOPIFY_PUBLISH=true` and `SHOPIFY_PUBLISH_MODE=live`. They also gate writes to draft products. Do not enable them merely to run local tests. The supplied access check is read-only and prints no credentials.

Definitions are validated against compatible existing definitions. `nexus.family_id` identifies the family; product and variant `nexus.resolved` JSON contains the explicit storefront contract. Custom product and variant metafields retain their own namespaces/types. The collection `nexus.card_order` JSON stores independently positioned cards. Storefront-readable definitions and referenced metaobjects are required. The publisher does not silently replace incompatible definitions.

## Collections

Choose family cards, one card per selected option group (colour by default), or one card per exact variant. Multiple axes can define a group. In the collection order editor, move a card up/down, to the first/last position, or to a numbered position. Saving in Nexus and synchronizing Shopify are separate actions with revision checks. Moving blue to the first row and red to a later page does not create extra Shopify products.

Impact's main collection opts in after an order is synchronized. It fetches the native filtered collection pages, expands the matching native variants into cards, applies the stored order globally and paginates the resulting cards. A group chooses its cheapest available matching variant, or its cheapest unavailable match. Shopper price/title sorts take precedence over the merchant's featured order; other sorts retain native family order. Native filter counts remain product counts, while the added card count counts displayed cards. JavaScript is required for global ordering and pagination of expanded cards; without it, native server pages are the fallback. Failed page aggregation shows a retry state instead of a misleading partial collection.

Bounds are explicit: 250 variants per family, 250 images per family, 50 resolved gallery images/list references, 250 products and 2,000 expanded cards per collection, and at most 50 native collection pages. Oversized inputs fail visibly. Large catalogue latency still needs measurement against Shopify. Reference fields, locales and generic display recursion are also bounded by the shared schema.

## Theme behaviour and retained customizations

- The updated 7.2.0 export remains the base. Its settings and original product template are preserved. A separate `product.nexus` template binds the managed content.
- The earlier 6.11.2 export supplies the merchant CSS for the desktop gallery (100px sticky offset, containment within the product section, horizontal thumbnails) and desktop hover thumbnail strip. A scoped grid correction reserves space for the thumbnail row inside the sticky viewport and removes the media item’s intrinsic minimum height; both image and thumbnails fit their allocated rows. A small thumbnail inset clears the loyalty launcher. The old CSS explicitly disabled touch/hold reveal; its dormant touch script is not ported.
- Native Impact image option selectors and size dropdowns are retained. Managed thumbnail axes use numeric option indexes, avoiding dependence on translated colour labels.
- Clicking a card thumbnail replaces the entire server-rendered card, including images, price, availability, links and quick-buy. Keyboard focus, filtered options and merchant placement are retained. The old script changed only images and links and could leave an inconsistent price/cart destination.
- Managed galleries use ordered numeric media IDs. Alt text remains descriptive and translatable. Product gallery, custom sections and variant form update from the same option response. Superseded responses are ignored. Pending/failed selections cannot add an old variant to the cart.
- Existing custom content placements are reused for concise description, button, accordion entries, features and eight configured metaobject sections. Generic supported metafields can be displayed in the product details. Native recommendations keep their existing product-level associations.
- Features retain the merchant's two-column rounded image cards, dark title bars and outer Impact dropdown. Four cards appear initially. A full-width disclosure shows the remaining count, has a minimum 48px tap area, and switches to Show less without losing the reader's viewport position. Keyboard expansion moves to the first newly revealed card. Cards open native dialogs with a persistent 44px Close control, Tab/Shift+Tab containment, Escape, focus return and background scroll locking. Large popup images load only when opened. The original Features liquid block and managed template use the same renderer; metaobject descriptions and variant overrides remain the source. `nexus-features.css` is bundled into the existing customization asset, with no new asset request.
- While the mobile navigation is open, Shopify Inbox, CWILL/Loloyal launchers and the Klaviyo teaser are hidden and inert. They are restored when it closes. This targets widget hosts observed on the real store; app changes to those hosts require rechecking.
- A separate header setting, “Show country/currency in mobile menu,” defaults on. It uses Impact's native localization control when multiple countries are available, independently of the desktop header setting.
- The first eligible collection images have explicit eager/high loading priority. The first slideshow section skips its initial reveal delay. Empty legacy carousels are guarded, widget rescans run only while navigation is open, and card sizing batches measurements before changing layout. Responsive image sources and later-card lazy loading remain intact. Real-store lab results remain variable and expose substantial app costs; these changes are not a speed guarantee.
- Pinch zoom, focus outlines, reduced-motion handling and native accordion keyboard interaction are retained. This is not a claim of WCAG AAA certification or exact visual parity on every device.

Supported editable field types are single/multiline/rich text, boolean, integer, decimal, colour, URL, JSON, file references, file-reference lists, metaobject references and metaobject-reference lists. Imports warn about unsupported types; they are not silently converted. Structural reference values are shared between locales, while textual content and image alt text can be translated. Added UI messages cover the store's English, Italian, French, German and Spanish languages. Other installed theme locales use explicit English fallbacks. Product option labels continue to use Shopify's native translations.

## Rebuilding and future Impact updates

From the repository root:

```sh
python3 integrations/shopify/impact/build-theme.py \
  /path/to/updated-impact-7.2.0.zip \
  --customizations /path/to/previous-customized-impact-6.11.2.zip \
  --output output/shopify-impact-2026-09-08
```

The build validates versions and exact insertion hooks. It writes the uploadable ZIP (with reproducible archive metadata), an identically sourced shorter-name ZIP, the extracted theme, a complete `theme.patch`, and `changes.json` with ZIP/file SHA-256 hashes and custom section bindings. The patch preserves files without final newlines. The builder never overwrites either input ZIP. Use a fresh output directory when updating sources; it does not remove unrelated stale files from an existing output directory.

For a later Impact release, compare the new upstream variant-picker, product rerender, product gallery, cards, collection and import-map hooks before changing the version guard. Reapply the merchant CSS separately; do not copy the old compiled `theme.js` over a new release. Review dynamic block bindings in the merchant product template again. Keep unknown merchant customization changes separate from upstream release changes.

Platform UI composes the Nexus design system. No new shared design-system primitive was needed, so there is no new Factory primitive to mirror. Both applications' type and token checks are part of verification.

## Verification and real-store rollout

`verification/preview` is a local fixture using the actual editor and generated theme assets, with simulated offers and APIs. It is useful for regression diagnosis, not evidence of Shopify API acceptance, Markets behaviour, app compatibility or live checkout. `verification/collection.test.mjs` exercises global card ordering. API tests mock GraphQL responses and verify request composition, conflict checks and readback handling.

The output directory's `IMPLEMENTATION-AND-VERIFICATION.md` records precisely what was tested; `PERFORMANCE-AUDIT.md` contains repeated real PageSpeed measurements and the remaining work. The user authorized uploading, publishing and testing the real store. The current release is **Nexus Impact 7.2.0 - feature cards**, theme `200486879559` (assets `/cdn/shop/t/95/`). The initial uploaded package was published as `200481964359`. After the native file chooser stalled, that theme was duplicated and the refinement was saved through Shopify's draft code editor, verified on Shopify, then published. A subsequent checked card-layout optimization was saved to the same release. The initial release and original theme `200351678791` remain available for rollback.

Real existing-product tests cover desktop/mobile gallery containment, restored Features cards/native dialogs, hover colour replacement, widget hiding/restoration, US/Italy currency switching, Italian localization and cart variant identity. The test cart was restored empty. A Nexus-managed family, synchronized collection order and server-side publication still require a usable Nexus Shopify destination. Theme installation alone does not deploy Nexus or consolidate existing Shopify products. Content migration and application deployment must be tracked separately.

Shopify references: [productSet](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet), [metafield capabilities](https://shopify.dev/docs/apps/build/metafields/use-metafield-capabilities), [dynamic sources](https://shopify.dev/docs/storefronts/themes/architecture/settings/dynamic-sources), [variant matching](https://shopify.dev/docs/api/liquid/objects/variant), [native pagination](https://shopify.dev/docs/api/liquid/tags/paginate).

## Published feature-card revision

After the merchant rejected the interim inline Features rows, theme **Nexus Impact 7.2.0 - feature cards** (`200486879559`) was created as a duplicate of the refined theme. The cards/disclosure/dialogs were tested on the actual Shopify preview, then published under the merchant's existing authorization. Shopify confirms it is Active. Public product HTML contains eight feature cards (four initially visible), zero interim feature rows, and the new t/95 assets. Native size M updates to 52531150553415 while retaining all 8 cards and no interim rows. Features and the adjacent Description/Shipping accordions share one divider and zero inter-block gap in both expanded and collapsed states on desktop and 390px mobile.

Four files differ from the interim release: `snippets/nexus-impact-features.liquid`, `assets/nexus-impact.js`, `assets/nexus-xavia-customizations.css` and `assets/nexus-menu-widgets.js`. The generated ZIP packages the latest release. Theme `200483930439` retains the interim row presentation as another rollback option.

The mobile promotion bug was reproduced: Klaviyo's child visibility reset kept its text and Close control painted even though its host was hidden and inert. The drawer now uses `display: none` on floating hosts. Fixed overlays containing Klaviyo forms are discovered while the menu is open, including those inserted later; embedded newsletter forms retain their layout. The mobile teaser is constrained between 88px side reservations for the observed loyalty/chat launchers, and its Close button is inside the banner with a 44px target. These overrides preserve app timing and dismissals. At 390px and 320px, live currency/language hit testing is unobstructed, and chat/loyalty hosts restore when the drawer closes. After diagnosis, Klaviyo stopped rendering the teaser in this browser session; its compact appearance and a delayed full-popup insertion still need a real-app recheck. No app state or visitor storage was reset to manufacture that result.
# Performance release, 8 September 2026

The focused performance update is live as **Nexus Impact 7.2.0 - performance** (`200489992519`); the prior feature-card theme (`200486879559`) is retained for rollback. The complete record, reproducible ZIP, patch and measurement evidence are in [`output/shopify-impact-performance-2026-09-08`](../../../output/shopify-impact-performance-2026-09-08/PERFORMANCE-RESULTS.md). Mobile performance targets remain unmet; do not describe this release as fully performance-verified.

The builder now delivers the merchant/Nexus customization CSS inside `theme.css`, forwards selected-media preloads, defers size-guide HTML until the drawer opens, and removes bulk viewport-triggered variant prefetch. Keep the standalone customization source for review, but rebuild the bundle when changing it. Do not link both CSS files or append the customization bundle twice. The performance pass does not change Nexus platform UI or deploy the Nexus publisher.
