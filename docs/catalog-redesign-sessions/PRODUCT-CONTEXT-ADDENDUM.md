# Product workspace and shared libraries — channel branches, 2026-09-06

Latest owner revision: retain Amazon and eBay branches inside the product sidebar, excluding mappings, and split the combined eBay Presentation page into separate Description themes and Variation order pages. Rebuild their product-facing layouts using the Nexus design system. The existing scope row still owns account and market selection; each page retains the selected listing alias. Preserve the shell, shared grid, domain owners and uncommitted work. This supersedes the earlier single-entry navigation decision.

## Intended interaction

A normal task link in the product sidebar stays within the same product/family workspace. It retains the product identity, Products return link, save state, applicable scope controls and the same product secondary sidebar. Its primary operations affect only the explicit product/family, account, market and listing selection shown on that page.

- Amazon Information → supported listing defaults: browse compatible reusable presets and review/apply supported listing defaults to this product's selected Amazon destination. Keep existing product/listing exceptions unless an explicit reviewed action replaces them. Applying a preset does not edit the reusable preset definition or activate a standing rule.
- eBay Information → supported listing defaults: the same product-specific behavior for the selected eBay destination.
- eBay → Description themes: select an inherited theme or customize the theme assignment for this product's selected eBay listing(s), with buyer-facing preview. Removing the override restores the applicable rule/default. Selection does not edit the theme used by other products.
- eBay → Variation order: customize buyer-facing axis/value ordering for the indicated product/family and destination, independently of grid sorting and shared variant creation. Keep inheritance and explicit overrides distinct.
- A product-scoped mappings view explains applicable rules and effective values and offers supported product/listing exceptions through the canonical writer. Opening or changing a standing shared rule is an explicit shared-management action, with its broader scope and impact review visible.

The product tasks remain Information, Media, Needs attention, Performance and Activity. Connected Amazon/eBay branches offer Listing information for that channel. eBay additionally has separate Description themes and Variation order links. Description themes retains the existing tab=presentation URL for compatibility; Variation order uses tab=variation-order. Both are product workspace pages, with no duplicate top-level Presentation link. Variation ordering is edited directly on its page; shared theme definitions remain explicit shared management. Variant editing stays in the existing Information family grid; a dedicated Variants destination must reuse that surface and is not part of this completed navigation increment. Do not create another variant editor or relabel global library administration as product work. Listing-preset application is still bound to the existing wizard; do not expose a product assignment control until its real destination/review contract is integrated.

A task change preserves the product, channel, account, market, language and listing coordinates. Channel changes belong to the existing scope selector, which clears incompatible coordinates. Do not take an eBay account ID into Amazon or silently use another store.

Shared-source edits continue to write shared product facts when the existing per-cell write contract says so. Product-scoped navigation does not convert those facts into channel overrides or change pricing/inventory ownership. A family operation must show whether it affects the parent, selected variants or all variants and which destination listings; do not imply one listing when the actual operation fans out.

## Reusable management stays available

Central libraries and rules remain necessary for catalog-scale management and future matching products. The accepted next phase places reusable configuration in main Channels navigation (connected accounts, category/attribute mappings, listing presets, eBay description themes and variation-order rules); main Listings handles cross-product destination status, review, publication and synchronization. Complete Products and product editing first. This phase does not add a Channels hub, change primary navigation or create placeholder destinations. Keep the existing listing-preset model, canonical /channels/mapping engine, theme service and ordering rules. Do not create a duplicate preset/theme/mapping engine per product.

Use an explicit action such as “Manage shared presets,” “Manage shared description themes,” or “Edit shared rule” to leave product-specific work for reusable management. Clearly state that definition changes can affect other products and retain reviewed activation/publication rules. Reusable library saving and marketplace publication remain separate operations.

A preview product is not an update target. A productId query parameter or a product-looking sidebar must not make an otherwise global editor appear product-scoped. If product-only theme-design customization is not supported by persisted domain behavior, do not expose the shared-definition editor as if it were product-only; provide the supported assignment/customization controls and explicitly label shared management.

Product-context pages retain the product sidebar because they belong to that workspace. This does not restore the earlier catalog sidebar on /products/next or add a global sidebar to every channel/library route. Standalone management remains broader in scope and must clearly indicate when the product workspace has been left.

## Implementation and ownership

The latest navigation revision restores branches using the existing WorkspaceSubheader groups. Same-channel links preserve account/listing scope. Cross-channel links clear incompatible account/listing/record coordinates and select a supported market, using one guarded history operation. Shared-library destinations and pending product-preset integration are not substituted for supported product work.

Inspection before this increment:

- Studio channelLibraryGroups links directly to /channels/listing-presets, /channels/ebay/description-themes and /channels/mapping, carrying channel/market but no product/account context. Those broad sidebar shortcuts have now been removed; the libraries remain intact.
- ListingPresetsClient administers shared WizardTemplate definitions. Its current apply review is tied to a wizard. It must not be embedded unchanged and labeled a product-only preset editor. Reuse its compatible picker and the domain preview/apply services, with an explicit product/destination binding and review.
- Product Presentation already provides an assignment surface inside Studio. Session 3 delivered partial account/alias support with the remaining restrictions recorded in its handoff. Coordinate with that implementation; do not overwrite it or remove guards before the supporting services are verified.

Session 3 delivered the reviewed mapping/theme-assignment increment with explicit unfinished requirements in handoff-03.md. Session 1 owns Studio navigation/scope/tab integration, previously removed the channel-library branches and has integrated and checked the exact source-metadata patch and Session 2 import patches. The current README follow-up assignments explicitly transfer product preset/defaults and wizard draft integration to Session 2, and the required eBay presentation/order consumers to Session 3. Their original delivered increments remain preserved. Shared-file ownership stays with Session 1. Broad preset rules and the remaining listing lifecycle retain their unfinished status; the later Session 4 must use the same product/destination bindings.

## Acceptance checks

1. Following product task links retains product identity, sidebar and explicit destination. Presentation appears only in eBay scope. Amazon/eBay branch links open existing product-scoped work; mappings and ordinary global-library links are excluded. Browser Back/return and new-tab deep links resolve the same product work view.
2. Applying/changing a preset or theme on product A cannot mutate product B or the reusable definition. Test two products plus multiple accounts/markets and aliases with different existing overrides.
3. Product-specific assignments and exceptions use canonical validation, effective-value resolution, versions and write targets. Removing an override restores current inheritance.
4. Choosing a reusable preset that contains other destinations cannot silently update those destinations from one channel's product page. Review the exact supported target set or refuse the incompatible operation.
5. The legacy variation-order modal cannot be launched from product Presentation until its save and publication consumers honor explicit account/listing destinations and versions. Shared management is visibly broader, retains its real preview/activation semantics and never silently publishes. Returning from it restores the product context where supported.
6. No placeholder destinations, duplicated editor engines or grid rewrite. Preserve overlay geometry, keyboard behavior and design-system requirements. Do not label any pending product-preset integration complete.
