# Direct publication from the product studio

The header action was a link to `/products/:id/list-wizard` in Master, disappeared in the channel Information sheet, and only switched tabs elsewhere. It never submitted the saved product. The legacy product-bound wizard is also blocked, so that link led away from the editor without providing a working publication path.

`PublishMenu` now opens a Nexus dialog on every studio tab. Master lets the operator choose a connected marketplace/account in place; an existing channel selection retains its account and listing alias. The review names the destination, included products, excluded count, required fixes, and Shopify visibility/location. Publication uses saved studio data and never navigates to the listing builder.

## Submission behavior

- Explicit product/family, account, marketplace and alias validation; configured content languages and the Information resolver supply the saved values.
- Separate `products.publish` permission on preview, submission and status routes. Actor and product ownership are checked when reading a durable review.
- Expiring reviews bind the resolved values and provider preparation. A changed revision requires a new review. Autosave failures and unsaved explicit editors block publication.
- Durable operation claim and database advisory lock prevent overlapping sends for the same destination. A repeated submission returns the recorded result. Interrupted responses offer a status read, and unresolved sends block fresh publication.
- Amazon validates every message before a single account-bound feed. Existing listings use partial updates; seller SKUs, the parent requirement mode, variation projection, content languages, media and inventory controls are retained. The validation client now uses the bound account's region. Feed acknowledgements are shown as **submitted**, processing reports as **accepted/rejected**; neither sets `isPublished`.
- eBay supports direct fixed-price Trading creation/revision, uses the selected account and alias, validates new listings before creation, checks existing live revisions, uses a stable request identity, and reads active presence before recording an active listing. Saved product and channel galleries are consumed.
- Shopify reuses the native content-family preview/synchronization service, preserving local/remote revision checks, saved visibility, sales-channel selections and an explicitly selected store location.

## Explicit boundaries

Live channel gates remain enforced. Etsy and WooCommerce do not have a full publication adapter in this implementation and show a blocking explanation. eBay Inventory-model listings, ended listings, Amazon-fulfilled eBay offers, shared items outside the selected family, and saved fields not supported by the Trading transport remain blocked. The eBay blockers currently include video, compatibility/regulatory content, package settings and automatic Best Offer thresholds. Shopify families with excluded variants are blocked because its native publisher synchronizes the complete family.

An unverified provider outcome is not automatically retried. A known Amazon feed can be checked from the dialog; a send whose provider receipt was lost requires channel-side reconciliation. This change does not make the legacy generic marketplace publish endpoint a content publisher.

## Verification

42 focused tests passed: 39 API tests across the studio publication plan, durable submission, provider transports, bound-account validation and existing Amazon validation suites; 3 web destination/response-matching tests. Provider writes were mocked. The existing Amazon validation suite required access to the local test database for account-region discovery; it did not publish products.

Additional checks passed:

- API TypeScript (`tsc --noEmit --incremental false`).
- Web TypeScript (`npm run typecheck --workspace=@nexus/web`).
- Shared package build.
- Token generation consistency (`npm run tokens:check`).
- Design-system conformance ratchet (`node scripts/ds-conformance-guard.mjs --check`).
- Whitespace checks on the edited integration files.

Browser verification used the real `PublishMenu`, dialog and Nexus components with the isolated mock API in `browser-fixture/`. Checked Master destination selection, preserved listing alias, submission progress/result, status recovery after a 502, stale-review refusal and refresh, mismatched account refusal, autosave protection, missing publishing permission, and Shopify draft/location controls. Light/dark presentation and 390×844 layout were inspected. No horizontal overflow; focus remained in the modal; Escape returned focus to Publish. Temporary viewport changes were reset.

Run the isolated page with `node docs/audits/2026-09-13-studio-publication/browser-fixture/server.mjs` and open `http://127.0.0.1:3166/`. Query cases include `?master=1`, `?dark=1`, and `?scenario=blocked|stale|uncertain|wrong|saving|permission|discovery|error`.

[Light review screenshot](review-light.png). No shared design-system control changes were needed, so there is no Factory mirror or design-system gap for this change. No live products were published, and no deployment was performed.

Transport reference: [eBay AddFixedPriceItem](https://developer.ebay.com/devzone/xml/docs/Reference/ebay/AddFixedPriceItem.html), [eBay ReviseFixedPriceItem](https://www.developer.ebay.com/devzone/xml/docs/reference/ebay/ReviseFixedPriceItem.html), [eBay VerifyAddFixedPriceItem](https://www.developer.ebay.com/devzone/xml/docs/reference/ebay/VerifyAddFixedPriceItem.html).
