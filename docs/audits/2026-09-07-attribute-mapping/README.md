# Attribute mapping audit — 7 September 2026

Current evidence is in [LIVE-VALIDATION.md](./LIVE-VALIDATION.md). After refreshing the live schemas and applying the resulting reviews, the 31 scopes contain 2,633 shared mappings and 2,006 listing/system sources across 4,639 fields, with zero unmapped or obsolete fields. Earlier counts below describe the preceding cached-schema pass. Source coverage does not establish product readiness.

## Completed attribute connections

All **31 cached category/market scopes** used by this catalog's product types now have a source disposition for every field. The final read-back found **2,648 shared field mappings**, **2,038 listing/system sources**, and **zero unmapped fields**, across **4,686 schema fields**. These totals count a field separately in each category/market scope; they are not counts of distinct Master attributes or populated product values.

The migration added **216 typed Master attribute definitions** (239 total) and **450 optional family attachments**. Existing definitions, options, product facts and listing overrides were preserved. New sources remain empty until verified facts are supplied. **2,620 rule changes** were committed through 31 durable impact reviews; each review scanned all **338 products**, resolved actual category/account/alias coordinates, and introduced **zero new validation errors**. The reviewed rule changes affected 68 effective field values and preserved 5,409 override occurrences. No listings were published.

| Channel / market | Completed scopes | Shared mappings | Listing / system sources |
| --- | ---: | ---: | ---: |
| Amazon DE | 6 | 536 | 445 |
| Amazon IT | 6 | 534 | 431 |
| Amazon UK | 5 | 475 | 326 |
| Amazon FR | 5 | 475 | 356 |
| Amazon ES | 5 | 475 | 356 |
| Amazon NL | 1 | 67 | 70 |
| eBay IT | 3 | 86 | 54 |

Evidence:

- [Completed field connections](completed-field-connections.json): every field, source, transformation, owner, category counts, schema freshness, listing coverage and real-product preview parity. Final verification reported zero connection failures.
- [Activation receipts](completed-activation-receipts.json): database-confirmed `MAPPING_APPLIED` records, per-review counts and superseded review IDs.
- [Imported source values](imported-source-values.json): all-product source availability and representative raw variant values.
- [Initial workspace inventory](workspace-inventory.json): the earlier GALE-JACKET parent sample across 16 markets; this is historical evidence, not the final catalog-wide result.
- [Earlier source corrections](activated-source-corrections.json): the preceding DE/IT fabric and dangerous-goods path repairs, retained separately from this completion migration.

## Why mappings appeared absent or inaccurate

The dictionary initially declared only 23 custom attributes, while channel schemas described many more product facts. Some imported facts used raw variation keys such as `Color`, `Colore`, `Size` and `Taglia`, while saved rules used canonical or legacy dotted paths. The page also mixed category fields with obsolete/generic fields and counted listing-owned settings as missing shared mappings.

The resolver now connects English/localized variation axes to canonical color and size, with explicit canonical values/nulls taking precedence and conflicting aliases reported. Legacy dotted paths follow the same parent/variant cascade as flat paths. Source samples come from Master/variant facts; another listing field's override cannot contaminate a rule's source.

Imported `Body Type` remains separate: real values such as `Uomo` describe gender and cannot safely become Amazon's apparel body-type value. Size normalization uses the selected schema's unique codes and labels, including `XL → x_l`, localized French labels and repeated option entries. Ambiguous matches are rejected. The editor displays the correction explicitly.

The imported source audit finds color on 44 products, size on 36 and style on 9. It finds no populated GTIN/EAN/UPC or item-weight values. A complete connection therefore often has an empty preview; it does not establish a product fact.

Existing operator intent remains respected. The German OUTERWEAR identifier-exemption rule reads an existing boolean Master bag key that predates dictionary registration. The final audit records this as a verified legacy source, rather than inventing a new global exemption or silently deleting the saved rule.

## Infrastructure and UI

- One resolver supplies the mapping grid, payload preview and publish validation. Real-product checks across Amazon/eBay IT found no differences between populated grid cells and payload previews.
- Source definitions preserve scalar/list types, including numeric zero and boolean false in lists. Package measures are separate from item measures; amount/unit expressions reject incomplete or incompatible units. Different list cardinalities use explicit transformations rather than discarding members.
- Pricing, inventory, media, policies, variation setup and other listing settings have explicit owners. Shared coverage excludes these fields. Required-value errors remain separate from missing connections.
- Category-specific schemas determine the field set. Exact-category obsolete rules were removed through impact review; unrelated categories and authored mappings were preserved.
- Impact work uses bounded product/listing pages, durable checkpoints and one bulk chunk insert per checkpoint. Account and alias overrides retain precedence. Interrupted jobs resume from stored checkpoints.
- Activation checks all resolution inputs and the mapping revision in the same serializable transaction as the mapping, review receipt and history. Full-row SHA-256 digests run in PostgreSQL and return only keys/hashes in 250-row pages. The connected-database transaction check measured **2.427 seconds**. Tests cover unversioned edits, deletions, composite-key pagination and account-selection changes.
- Serialization conflicts receive at most two retries, repeating every input/revision check. Stale inputs and validation refusals are not retried as successful writes. The coat reviews caught the body-type and size issues before activation; a rolled-back Dutch activation completed on retry.
- The rollout processes at most three independent market queues. Categories within a market remain sequential, and local audit receipts use serialized atomic file replacement.
- The mapping UI uses Nexus controls and semantic tokens. Sources, empty values, listing overrides and corrections are distinct. Keyboard SKU selection, Escape/focus behavior, desktop light/dark and a 390px drawer were checked. Long source paths truncate within the drawer and retain their full title text.
- The earlier shared dark information/tonal contrast correction is mirrored to Factory with catalog, changelog and DS-gap records. No additional shared design-system primitives were required for this completion pass.

## Remaining data and connection gaps

The final audit covers **all 725 Amazon listings** and **249 of 252 eBay Italy listings**. The remaining three are unclassified drafts:

| SKU | Product | Status |
| --- | --- | --- |
| 1J-EYE5-Y0TW | Xavia Riser motorcycle gloves | DRAFT |
| UD-LVLM-1H8T | Xavia Evo motorcycle gloves | DRAFT |
| xracing | Xavia X-Racing motorcycle suit | DRAFT |

The eBay taxonomy lookup failed because the stored credential blob could not be authenticated and no usable fallback credentials were available. Reconnect eBay Italy in Channels & accounts, fetch the appropriate category schemas, assign these drafts and review their field connections. Their missing category fields have not been fabricated from a different cached category.

Amazon PL, IE, SE, TR, BE and US, and eBay DE, FR, ES and UK have no existing listings in this audit and no relevant cached scopes in the completion plan. They are not certified by the 31-scope result. Schema freshness remains visible; cached scope completion does not assert that an old remote schema is current.

Missing descriptions, bullets, fabric/identity facts and channel settings remain content work. For example, AIRMESH-JACKET-BLACK-MEN-XL has a working size/color mapping. The earlier leaf-only check reported three missing required Amazon IT values; the subsequent full conditional-schema validation exposes additional required facts. See the [workflow quality follow-up](WORKFLOW-QUALITY.md). Existing eBay title-length and missing-description errors remain visible. GALE-JACKET-YELLOW-MEN-XXS stores Master size `XS` and an explicit eBay size `XXS`; the resolver preserves that exception and does not infer a replacement from the SKU. Product readiness must be assessed separately from source coverage.

## Editor architecture

Keep the searchable mapping table as the primary editor. Hundreds of fields across categories and markets benefit from filtering, comparison, keyboard access and explicit provenance. A focused dependency view can help explain a complex formula later, using the same saved rules and resolver.

Productsup itself provides [Dataflow](https://help.productsup.com/docs/help-center/map-and-optimize-your-data/dataflow/use-dataflow-to-map-your-attributes-from-import-to-export) and [table-based Data View workflows](https://help.productsup.com/docs/help-center/map-and-optimize-your-data). The choice of a table for Nexus is an architectural judgment for this workload, not a claim that node interfaces are universally inferior.

## Verification and repeatability

- API mapping suite: **25 files / 196 tests passed**.
- Attribute resolver / studio variation-axis regression checks: **2 files / 44 tests passed**.
- Attribute/family/list/value-map/catalog-transfer checks: **5 files / 61 tests passed**.
- Web mapping contracts: **3 tests passed**.
- API, Web and Factory typechecks and generated token checks passed. Web token guard passed. Full Web production build passed.
- The subsequent workflow quality pass corrected all **54 Factory platform-alias violations** by matching Web’s semantic design-system tokens. Both token guards now pass; this is not a whole-product accessibility certification.

The reviewed planner and read-only verifier are in `apps/api/scripts/complete-channel-mapping.mts` and `apps/api/scripts/verify-complete-channel-mapping.mts`. Plan first with `--plan <file>`; `--apply <file>` installs definitions and uses normal impact reviews/activation. The verifier accepts the plan path and an output JSON path. Re-running a plan never bypasses stale-input or introduced-error guards.

Local verified preview: http://localhost:3114/channels/mapping?channel=AMAZON&market=IT&category=COAT&product=cmokmy2fo0053pm0pwafjwwk6
