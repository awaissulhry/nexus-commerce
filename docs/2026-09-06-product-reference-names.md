The product Information grids now consume readable reference names separately from stored IDs. Text references use the same name for rendering, sorting, filtering and ordinary grid clipboard/export formatting. Pasting an unambiguous known name resolves back to its ID. The existing import-ready export retains its raw values.

Name sources:

- eBay categories: saved category mapping paths and the selected market's taxonomy breadcrumbs. A missing local taxonomy result does not borrow another market's category name.
- eBay policies: the selected seller's policy snapshot; the editor and grid share the same account-and-market cache. UK uses the policy API's `EBAY_GB` identifier.
- Description themes: the existing theme catalog, with a Nexus select panel for choosing by name.
- Amazon product types: the existing product-type catalog.
- Amazon schema references, including browse-node labels: cached category metadata, also available for additional saved attributes in the shared-product grid.
- Amazon shipping templates: a separate seller-qualified definition lookup. Its names are cached by account, marketplace and product type; seller schemas are never written to the shared category cache. The existing Amazon client supports the primary account, so other accounts do not borrow its names.
- Marketplace IDs and fulfillment codes: marketplace metadata and readable fulfillment labels.

Lookups run independently of the sheet read. Label updates preserve the grid's row objects and saved IDs; failed or unknown lookups keep the original value visible. Full scalar names and their IDs remain available in tooltips. Existing Nexus primitives and grid editors are reused, with no shared design-system or CSS changes.

Verification:

- Information sheet suite: 31 files, 451 tests passed. The first sandbox run could not bind the dead-port test server; the approved rerun passed.
- API name lookup and channel schema suites: 3 files, 43 tests passed.
- Full web and API TypeScript checks passed.
- Web and factory token checks passed.
- Browser: Amazon `OUTERWEAR` displayed as `Outerwear (Jackets, Coats)`; the saved eBay theme displayed as `Xavia Modernist`. The named theme picker opened from Enter, supported arrow navigation and closed with Escape without saving. Light desktop and dark 900px layouts were checked, with no page overflow. Searching the display-only phrase `Jackets, Coats` found all 21 Amazon rows. Search, theme and viewport were restored.

The live environment still prevents some names from resolving. eBay policy lookup returns `Credential blob failed authentication`; its taxonomy lookup returns no breadcrumbs for the product's category `177104`. The product's saved category mapping paths are null. Amazon returned no shipping-template names, and the cached schema did not name the product's browse node `2420941031`. These values therefore still display their IDs. The implementation is ready to use names once the connection/metadata sources supply them; these live lookups are not recorded as passes.

An unrelated temporary `VariationOrderTab` export error interrupted the browser/type checks during development. It was resolved in the shared workspace and final checks passed. No product values, listings, credentials, or publication state were changed by this work. No deployment or commit was made.
