# Mapping live-validation pass — 7 September 2026

The reviewed mapping scopes are fully connected and aligned with current provider requirements. The catalog is **not fully ready for publication**: 976 of 977 listing coordinates have product-data or local validation issues. Nothing in this pass published a listing or deployed code.

## What changed

- Amazon schema downloads now verify the provider's Base64 MD5 checksum before parsing or touching the cache. Missing integrity metadata, invalid documents, HTTP errors and timeouts preserve the previous requirements.
- Content fingerprints replace provider-only version labels for refreshed Amazon schemas. The provider label, checksum, marketplace, requirements and locale remain in provenance metadata. A changed document or property group invalidates reviewed manifests even if Amazon keeps its version label. Concurrent refreshes of identical content use an upsert.
- Shared schemas remain scoped by channel, marketplace and category. Seller-specific acceptance is checked against the exact account at dispatch. This change does not introduce a global seller-specific cache.
- Removed obsolete AWS signing-credential requirements from the legacy Amazon client. The actual client uses LWA credentials.
- Refreshed all 31 reviewed category/market schemas successfully. Applied 22 schema-alignment reviews, removing obsolete category rules and connecting newly exposed fields, including temperature value/unit sources. Reviews introduced zero invalid values and changed no listing payloads.
- Corrected a live-discovered Amazon validation false positive: HTTP errors or unrecognized responses can no longer authorize publication. Validation requires a recognized result for the requested SKU; INVALID remains blocked even without issue details.
- Closed the two omitted queue handles during shutdown. Synthetic queue delivery, duplicate-job suppression and transient retry recovery passed against isolated Redis.
- Restored missing Factory tooltip tokens and fixed the token scanner's handling of actual runtime style objects. The mapping toolbar now distinguishes no preview, pending/unavailable preview, and the selected product's errors. Shared component export order is aligned.

## Evidence and practical limits

| Check | Result |
| --- | --- |
| Live schema refresh | 31/31 succeeded; all 28 Amazon documents passed checksum verification |
| Field source coverage | 2,633 shared mappings + 2,006 listing/system sources = 4,639 fields; zero unmapped or obsolete fields |
| Listing category coverage | All 725 Amazon listings; 249/252 eBay listings |
| Preview/resolver parity | No differences for the two representative SKUs on Amazon and eBay |
| Amazon local schema compilation | 117 active cached documents compiled/evaluated; zero unavailable validators, including retained historical versions |
| Live Amazon preview | Selected brand/color patches accepted for six product types in IT; this does not validate every field or the entire catalog |
| Negative request control | Incomplete full request returned HTTP 400 and was blocked; it is no longer reported as a valid preview |
| Deliberate type probe | Amazon returned VALID for a numeric brand patch; local type/schema validation remains essential |
| eBay reads | AIRMESH inventory SKU, category and offer matched the selected account; three unclassified drafts had no category-bearing offer |
| Automated checks | 284 API tests across 38 files; 3 Web mapping contract tests; 12 token-scanner self-tests |
| Types and design system | API, Web and Factory types passed; both generated token checks, token resolution and shared-file drift checks passed |
| Browser | Keyboard SKU selection, actionable errors, Escape dismissal, clearing validation state, new field mapping, light/dark and 390px presentation checked; no document overflow at 390px |
| Local queue integration | Redis ready; one job after duplicate enqueue; one deliberate failure recovered on retry |
| Deployed infrastructure | Existing Railway endpoint reports healthy API/database/Redis, enabled workers and immediate BullMQ dispatch; this is health evidence, not a production delivery test |

The database integration suite initially could not start its temporary test server inside the filesystem/network sandbox. It passed all 13 tests when rerun with local socket access. No failing assertion was waived. The TypeScript token generator also required its local IPC socket.

The configured custom API hostname `api.xavia.it` returned ENOTFOUND here. The existing Railway address `nexusapi-production-b7bb.up.railway.app` responded successfully. DNS was not changed. The local preview on port 8094 uses the tested isolated Redis on 6387, with background channel jobs disabled; it uses test authentication and is not evidence of production authorization behavior.

eBay's Inventory API has no equivalent validation-preview call used by this adapter. Trading Verify calls do not certify existing Inventory API listings. Do not describe successful inventory reads or local category checks as successful eBay publication validation.

## Product data still needed

The full audit resolved all 977 exact account/market/listing coordinates without an audit error. The remaining issues include missing package measurements, manufacturer/model facts, identifiers, materials, care, origin and sizing; missing descriptions; and values that violate channel limits. These are prospective mapped payload checks, not a claim that all current live listings are broken. For example, AIRMESH's live eBay title is 80 characters and its live description exists, while its current Master-derived proposal has an overlong title and an empty description.

Three eBay drafts still require a category: `1J-EYE5-Y0TW`, `UD-LVLM-1H8T`, and `xracing`. Their live Inventory/Offer reads did not supply an authoritative category, so none was guessed.

The user needs to identify the authoritative supplier/manufacturer specification source before missing physical or compliance facts can be completed. Existing channel data can be reconciled with that source, preserving exact SKU/account/market provenance and explicit overrides. Then rerun full payload validation; any actual publishing trial needs a concrete reviewed payload and authorization.

## Receipts and reruns

- [Live schemas](./live-schema-refresh.json), [reviewed plan](./schema-alignment-plan.json), [activation receipts](./schema-alignment-receipts.json), [final verification](./refreshed-mapping-verification.json).
- [Product readiness summary](./product-readiness-summary.json) and [every listing's missing/invalid facts](./product-facts-needed.json).
- [Live mapping validation](./live-mapping-validation.json), [type-probe result](./amazon-preview-type-probe.json), [queue delivery](./queue-delivery-live.json), [deployed queue health](./deployed-queue-live.json), [custom-domain failure](./custom-domain-health.json).

From the repository root, run the audit scripts with `node --import tsx docs/audits/2026-09-07-attribute-mapping/<script>.mts`: `refresh-live-schemas`, `product-readiness-check`, and `live-mapping-validation`. Refresh changes cached requirements; the other two do not edit product values or publish listings. Their receipts go to `/tmp` for review. Run `queue-delivery-check.mts` only with a disposable Redis on port 6387. It consumes synthetic jobs, never application channel work.

The saved alignment plan is an audit artifact, not a future activation command: schema and mapping tokens are checked before activation, so generate a new plan after any subsequent changes.

Provider references: [Amazon schema checksum model](https://github.com/amzn/selling-partner-api-models/blob/main/models/product-type-definitions-api-model/definitionsProductTypes_2020-09-01.json), [Amazon product type definition scope](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/retrieve-a-product-type-definition), [LWA without AWS signing](https://developer-docs.amazon/sp-api/lang-de_DE/changelog/sp-api-will-no-longer-require-aws-iam-or-aws-signature-version-4), [eBay Inventory/Trading API limits](https://developer.ebay.com/api-docs/sell/static/inventory/pbse-phase1-rest-workflows.html).
