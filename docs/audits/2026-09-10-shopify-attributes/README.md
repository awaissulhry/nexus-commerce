# Shopify product attributes

Scope: add missing Shopify Information columns, keep familiar channel labels, and discover metafields from the selected connected store. The example on port 3144 was not copied. The completed mapping follow-up is documented in [MAPPING.md](./MAPPING.md); publication remains a separate action.

The behavior below records the original column-discovery phase. The mapping follow-up supersedes its empty/unmapped placeholders with the canonical resolver wherever a verified source exists.

## Behavior

- The shared registry declares 30 native attributes. Product and variant metafields come exclusively from the store's paginated definitions, including Shopify category metafields. No fixed custom-field list remains.
- Display names use the live definition name. Stable identities use owner type, namespace and key, so a rename preserves column preferences and product/variant fields cannot collide. Native labels align with the existing channel vocabulary: Title, Description, SKU, Cost, SEO title, SEO description, URL handle and Theme template. Vendor remains distinct from Brand; names do not imply mappings.
- Signed Shopify metafield-definition creation, update and deletion notifications publish a business- and account-scoped refresh hint through the existing event stream. The editor re-reads the complete schema. It also refreshes on focus, reconnect and every 30 seconds while visible.
- Concurrent hints coalesce with a follow-up read. Old account responses are aborted. Failures retain the last good columns and the draft; edits remain blocked until current values are available.
- New definitions add visible columns; renames update labels; deleted definitions remove columns. Pending edits remain available for review. Stale open editors and transfer previews cannot apply against a changed definition, and the server rejects deleted definitions even if Shopify retains their stored values.
- Unlinked products keep their existing Nexus authoring columns and gain the same discovered attributes. Additional fields remain empty and read-only until a Shopify product identity is linked. The adapter does not invent remote values, mappings or write destinations.

## Verification

Read-only discovery against the connected `xaviaracing.myshopify.com` store found **39 metafield definitions**, giving **69 logical attributes** (70 grid columns because inventory has available and on-hand columns). `live-schema.json` captures that discovery; its native labels were recorded before the final naming alignment. The real local product editor also rendered the discovered attributes through its unlinked-product sheet.

Passing checks:

- API Shopify suite and existing webhook event tests: **133 tests**.
- Shared Shopify Information / linked-products contracts: **38 tests**.
- Web editing, schema refresh races and unlinked-column isolation: **13 tests**.
- Event catalogue: **19 tests**.
- API and web TypeScript checks; shared and events builds.
- Web and factory token consistency; AG Grid import boundary; raw primitive ratchet.

The independent browser fixture imports the production grid, schema hook and event-stream consumer. Its synthetic store events verified addition, rename with the same column ID, deletion, separate store definitions, refresh failure/recovery, preservation of a staged Material value, and blocked application of a deleted field while its unsaved input stayed visible. F2 opened the cell editor; Escape cancelled it. At 390px the dark column chooser stayed within the viewport with no page overflow. Empty search groups are omitted. Normal viewport was restored afterward. `browser-evidence.json` records fixture reads/events; no Shopify product writes were made during verification.

Run the fixture with `node docs/audits/2026-09-10-shopify-attributes/browser-fixture/server.mjs`, then open `http://127.0.0.1:3156`.

## Operational boundary

This work is local and has not been deployed. The local API address is HTTP, so live Shopify webhook subscriptions cannot activate here. The actual editor displays that condition and uses the 30-second fallback. A deployed public HTTPS callback and successful Shopify subscription registration are required to verify immediate delivery against the live store. Existing account permissions and Shopify server write settings still apply; the test fixture's live subscription response is synthetic.

Shopify's supported notification topics are documented in [metafield-definition webhooks](https://shopify.dev/changelog/metafield-definition-webhooks); definitions are read through the [Admin GraphQL metafieldDefinitions query](https://shopify.dev/docs/api/admin-graphql/latest/queries/metafielddefinitions).
