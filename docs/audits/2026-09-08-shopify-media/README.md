# Shopify as the Nexus media default

Implemented in the working tree on 2026-09-08. Open `/marketing/content` in Nexus to load the connected store’s Shopify Files library. Both product image pickers use the same source selector and library component.

## Behavior

- A single connected Shopify store is the default. With multiple stores, the unique primary is the default; without a unique primary, Nexus asks for a store instead of guessing. The library can explicitly browse and upload to another connected store. A Shopify `accountId` in the current page URL selects that store in the picker.
- Images, videos, documents and 3D models load directly from Shopify with filename search, type filters, cursor pagination and refresh. Images and MP4 video renditions preview in Nexus. Other files have a labeled placeholder and an Open file link. Missing thumbnails, failed previews, processing files, failed processing, empty results and connection failures have separate states.
- The shared upload endpoint and product image/video uploads default to Shopify. Selecting **Nexus assets** explicitly retains its existing upload provider. A failed Shopify request never silently sends bytes to Cloudinary.
- Library uploads use the selected store and return per-file progress. Files are public on Shopify; the dialog states that before upload. This implementation accepts up to 20 files per selection, 20 MiB per image/document and 200 MiB per video/model, with an explicit format allowlist.
- Adding an image references its Shopify URL and file identity. Nexus checks the file again before attaching it. References include workspace and account identity; repeat and overlapping imports reuse the same product image. Reuse refreshes delivery metadata while preserving product-specific role, description and position. Product upload hashes preserve existing duplicate detection.
- Stable, content-derived upload filenames and Shopify’s duplicate rejection avoid overwrites. If registration loses its response, Nexus attempts a read reconciliation rather than repeating the mutation. Uploads still processing after the bounded wait remain in Shopify and return instructions for retrying attachment.

## Access and integration

The server uses the existing workspace-scoped connection resolver and Shopify Admin client, API version `2026-07`. The browser never receives a Shopify access token. Library routes inherit the session, CSRF, workspace and `assets.manage` gates and send `Cache-Control: private, no-store`.

Browsing needs Shopify Files access; uploads also need `write_files` and the existing Shopify write gate enabled. The connector already requests these scopes. Older connections that did not grant them need reconnection through Connections. No new database migration is required: Shopify references use the existing DigitalAsset, ProductImage and AssetUsage tables.

The library covers resources exposed through Shopify Files. It does not enumerate theme source files or externally hosted product videos. Product associations are revalidated on use; this change does not introduce a background subscription that automatically updates every previously attached image after an edit in Shopify.

## Validation

All final checks listed here passed:

| Check | Result |
| --- | --- |
| API service and HTTP tests | 48 passed across three files |
| Web Shopify CDN tests | 2 passed |
| Factory mirrored CDN tests | 2 passed using Factory’s `__tests__/*.test.ts` convention |
| Scoped TypeScript | API, Web and Factory changed entry points plus transitive imports passed |
| Shared package build | Passed |
| Generated token checks | Web and Factory passed |
| Semantic token guards | Web and Factory passed |
| Design-system conformance and raw-control ratchets | Passed |
| Design-system CSS parser | Passed |
| Shared component/helper/catalog parity | Matching Web and Factory implementations |

The API tests cover default-store selection, workspace rejection, permission gates, strict file identity, filename-query escaping, pagination, all supported media types, safe delivery URLs, processing states, concurrent reuse, changed delivery metadata, upload limits, staging without Shopify credentials, lost-response reconciliation, and image/video/shared upload behavior with Cloudinary disabled.

Browser verification used the real shared feature and design-system components against the isolated synthetic fixture in `browser-fixture/`. It covered store switching, pagination, keyboard filtering, image-only selection, successful reuse feedback, rejection of a deleted file, filename search/loading feedback, source-error retry, file-error retry, empty/disconnected/ambiguous states, video keyboard access and focus restoration, document copy/open actions, and a synthetic upload sent specifically to `store-b`.

The library was inspected at 320, 768 and desktop widths in light/dark presentation. Recorded 320 px and 768 px layouts had no horizontal page overflow. The sampled library labels, controls and card text measured at least **8.02:1** contrast; controls retain normal Nexus dimensions (approximately 29–31 px). These are scoped UI measurements, not a whole-platform accessibility certification.

- [Mobile light](mobile-light.png), [mobile dark](mobile-dark.png)
- [Desktop light](desktop-light.png), [desktop dark](desktop-dark.png)
- [Measured contrast and layout](contrast-layout.json)
- [Synthetic request/upload evidence](browser-requests.json)
- [Final check output](checks.txt)

Run the fixture with `node docs/audits/2026-09-08-shopify-media/browser-fixture/server.mjs`, then open `http://127.0.0.1:4139`. `?picker=1` exercises image selection and `?theme=dark` selects dark mode. Its document/model URLs are synthetic stand-ins; document download contents and 3D rendering are not claimed as browser-tested. The video fixture is a real, generated two-second MP4.

## Verification boundary

The implementation and automated checks are local. No production deployment or live-store acceptance test was performed. No customer files were uploaded during verification. Actual account authorization, live file retrieval and Shopify processing still need verification in the connected environment. Full workspace builds were not run; TypeScript validation was scoped to the changed paths and their imports.

## Shopify references

The file query and type normalization follow Shopify’s [Files query](https://shopify.dev/docs/api/admin-graphql/latest/queries/files), [MediaImage](https://shopify.dev/docs/api/admin-graphql/latest/objects/MediaImage), [Video](https://shopify.dev/docs/api/admin-graphql/latest/objects/Video), [GenericFile](https://shopify.dev/docs/api/admin-graphql/latest/objects/GenericFile) and [Model3d](https://shopify.dev/docs/api/admin-graphql/latest/objects/Model3d) documentation.

Upload staging and registration follow [stagedUploadsCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/stagedUploadsCreate) and [fileCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fileCreate). Durable image delivery URLs are used instead of the short-lived [MediaImage original-source URL](https://shopify.dev/docs/api/admin-graphql/latest/objects/MediaImageOriginalSource). The public-file notice follows Shopify’s [file-upload guidance](https://help.shopify.com/en/manual/shopify-admin/productivity-tools/file-uploads).
