# Channel attributes: what the channels publish and what the industry does

Research date: 2026-09-26. Only public sources were used. No seller API was called, no database was touched and no repository was read. **(unconfirmed)** marks anything I could not confirm from a source. Why Nexus currently keeps channel fields in the shared scope is a question for the codebase; this research did not look at it.

## Part A: How each channel defines attributes

### A1. Amazon: Product Type Definitions (SP-API)
- **Schema per product type and store.** Amazon returns a JSON Schema for each product type and each marketplace. It "describes all requirements, attributes, and the conditionality." Requirements differ by store because "countries have different data requirements specific to that Amazon store." ([listings guide](https://developer-docs.amazon/sp-api/docs/manage-product-listings-guide), [Listings FAQ](https://developer-docs.amazon/sp-api/docs/listings-apis-faq))
- **Offer data and product data are separate.** The `requirements` parameter takes three values: `LISTING` (product facts and sales terms), `LISTING_PRODUCT_ONLY` and `LISTING_OFFER_ONLY`. ([use-case guide mirror](https://spapi.vip/en/use-case/product-type-api-use-case-guide.html))
- **Property groups.** Each definition groups its properties: offer, images, shipping, variations, safety & compliance, product identity and product details. The offer group holds `purchasable_offer`, `condition_type` and `fulfillment_availability`.
- **Conditional requirements.** An Amazon maintainer: "The required attributes on a product type are dynamic… You can find `allOf` in product type JSON schema returned, which contains the conditional requirements." ([GitHub #3713](https://github.com/amzn/selling-partner-api-models/discussions/3713))
- **Apparel sizing rules.** Apparel sizing is a set of "catalog-wide rules." Size system, size class and size value are required. Body type and height type are conditionally required, depending on the product type and the age range. ([complex attributes](https://developer-docs.amazon/sp-api/docs/listings-items-guidance-for-complex-attributes))
- **Meta-schema.** The meta-schema extends JSON Schema 2019-09 with eight extra keywords: `editable`, `hidden`, `enumNames`, `selectors`, `min/maxUniqueItems` and `min/maxUtf8ByteLength`. ([meta-schema](https://spapi.vip/en/references/product-type-definition-meta-schema.html))
- **How often schemas change.** Amazon "plans necessary updates for the last week of every month." A `PRODUCT_TYPE_DEFINITIONS_CHANGE` notification fires when a new version is available, and a `checksum` shows whether a schema changed. `$lifecycle` lists deprecated enum values. Each version is flagged `LATEST` or `RELEASE_CANDIDATE`. ([Listings FAQ](https://developer-docs.amazon/sp-api/docs/listings-apis-faq))
- **Schema sizes.** Property counts for OUTERWEAR, COAT, PANTS and GLOVES are **not published**. They have to be counted from the stored definitions **(unconfirmed)**. A developer thread complains about "stealth changes" to required elements ([#3932](https://github.com/amzn/selling-partner-api-models/discussions/3932)).

### A2. eBay: Taxonomy API
- **Aspect constraints.** `getItemAspectsForCategory` returns each aspect with these constraints: `aspectRequired`, `aspectUsage` (RECOMMENDED or OPTIONAL), `aspectMode` (FREE_TEXT or SELECTION_ONLY), `itemToAspectCardinality` (SINGLE or MULTI), `aspectEnabledForVariations`, `aspectMaxLength` and `expectedRequiredByDate`. A required aspect also reports `aspectUsage=RECOMMENDED`, so read `aspectRequired`. ([AspectConstraint](https://developer.ebay.com/api-docs/commerce/taxonomy/types/txn:AspectConstraint), [required item specifics](https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/item-specifics-requirements.html))
- **Localised names.** "Aspect names are always localized for the specified marketplace." Italy returns *Marca*, *Taglia*, *Reparto* and so on.
- **Bulk download and change tracking.** `fetchItemAspects` returns every leaf category of a category tree as one gzipped JSON file, possibly "over 100 MB, compressed". eBay's open-source [taxonomy-sdk](https://github.com/eBay/taxonomy-sdk) compares two downloads because aspects evolve "fairly rapidly": aspects are added and removed, and changes such as "OPTIONAL → RECOMMENDED" happen.
- **Requirement changes.** Seller Hub marks aspects as "Required soon" with enforcement dates ([Seller Center](https://www.ebay.com/sellercenter/listings/item-specifics)). In 2025, "Country/Region of Manufacture" was renamed "Country of Origin", and eBay made it required for listings shipping to the US ([eBay dev newsletter Q4-2025](https://developer.ebay.com/updates/newsletter/q4_2025)). GPSR data does not go in item specifics: it sits in the offer's `regulatory.manufacturer`, `responsiblePersons` and `productSafety` fields ([Inventory API notes](https://developer.ebay.com/api-docs/sell/inventory/static/release-notes.html)).
- **Categories on eBay Italy.** Source: browse URLs.

| ID | eBay Italy name | English | Notes |
|---|---|---|---|
| 177104 | Giacche e giubbotti per motociclista | Motorcycle jackets | [link](https://www.ebay.it/b/Giacche-e-giubotti-per-motociclista/177104/bn_16549005). eBay Germany uses the same ID. eBay US jackets are 177117, so **IDs differ between trees**. |
| 177101 | Altre armature e protezioni | Other armour and protection | [link](https://www.ebay.it/b/Altre-armature-e-protezioni-del-ragazzo-per-la-guida-di-veicoli/177101/bn_74735450) |
| 177109 | Pantaloni per motociclista | Motorcycle trousers | [link](https://www.ebay.it/b/Pantaloni-uomo-per-motociclista/177109/bn_81759607) |

  The parent category is 177099, *Abbigliamento per motociclista*. The gloves category ID was **not confirmed**.
- **Typical aspects for motorcycle jackets.** Brand, Type, Size, Department, Colour, Material, Exact Material, Style, Features ("CE Approved Armour", "Removable Lining"), Armour location, Certification (CE, Level 1/2), MPN, EAN and Country of Origin. On eBay Italy I saw *Marca*, *Tipo*, *Taglia*, *Reparto*, *Colore*, *Materiale del rivestimento esterno* and *Caratteristiche*. The Italian names for Certification and Season are **unconfirmed**. (Source: [eBay US browse facets](https://www.ebay.com/b/Motorcycle-Jackets/177117/bn_55168227) and eBay Italy listings.)

### A3. Shopify: Standard Product Taxonomy
Checked in the [product-taxonomy repo](https://github.com/Shopify/product-taxonomy), stable release **v2026-08** (published 2026-08-24). Shopify publishes a new release roughly every quarter.

| Category | Attributes |
|---|---|
| Apparel & Accessories > Clothing > Outerwear > **Motorcycle Outerwear** (`aa-1-10-7`) | Age group, Care instructions, Color, Fabric, Neckline, Outerwear clothing features, Pattern, Size, Size type, Sleeve length type, Target gender |
| Vehicles & Parts > … > Motorcycle Protective Gear > **Motorcycle Gloves** (`vp-1-6-1-3`) | Accessory size, Color, Glove armor placement, Glove insulation, Handwear material, **Motorcycle glove certification standard** (values: CE EN 13594:2015 Level 1/2, with or without KP), Motorcycle glove purpose, Waterproof construction, Motorcycle protective gear size system, Pattern, Protective gear features, Target gender, Vehicle type |
| … > **Motorcycle Chest & Back Protectors** (`vp-1-6-1-1`) | **Motorcycle armor certification standard** (values: EN 1621-1/-2/-3, "EN 17092 compatible"), Protector coverage area, Gear material, and others |

- **There is no motorcycle trousers category.** Rain Pants, Rain Suits and Chaps sit under Outerwear.
- **How category attributes are stored.** Category attributes are stored as **category metafields** in the `shopify` namespace, such as `shopify.color-pattern`. Their values are Shopify-managed metaobjects such as `shopify--color-pattern`, of type `list.metaobject_reference`. A merchant can add entries but cannot change the schema. ([Help: category metafields](https://help.shopify.com/en/manual/custom-data/metafields/category-metafields))
- **Category constraints.** Each standard metafield carries constraints that limit it to certain categories ([conditional definitions](https://shopify.dev/docs/apps/build/metafields/conditional-metafield-definitions)).
- **Product-level standard fields.** Title, descriptionHtml, vendor (the brand), productType (free text), tags, SEO title and description, category, options (at most 3), and for each variant the SKU, barcode, weight, price and compare-at price.

### A4. Etsy: Open API v3
Source: [the OpenAPI spec](https://www.etsy.com/openapi/generated/oas/3.0.0.json) and the [listings tutorial](https://developers.etsy.com/documentation/tutorials/listings/).
- **Category properties.** `getPropertiesByTaxonomyId` returns each property with these fields: `is_required`, `supports_attributes`, `supports_variations`, `is_multivalued`, `scales` (for example sizing systems) and `possible_values`. According to Etsy staff, "properties are not universal. They depend on the category" ([#776](https://github.com/etsy/open-api/discussions/776)).
- **Deprecated properties break old IDs.** Since 2025-04-15, the API rejects deprecated `property_id`s. Etsy says not to cache property IDs ([#1378](https://github.com/etsy/open-api/discussions/1378)).
- **Required fields for a draft listing.** quantity, title, description, price, **who_made**, **when_made** and taxonomy_id.
- **Fields only Etsy has.** `who_made` (i_did, someone_else, collective), `when_made` (made_to_order, 2020_2026, …), `is_supply`, `production_partner_ids`, `styles` (at most 2, free text), `materials` (free text), and the EU guarantee fields `ecgt_*`.
- **Missing fields.** The listing API has **no GTIN or brand field**.
- **Jacket properties.** The exact property list for a jacket category is **unconfirmed**; it needs an API key. Primary color and Secondary color are general properties.

### A5. The same concept in each channel (seed for a crosswalk)
- Amazon names are SP-API JSON attribute names. Whether each one exists in COAT, PANTS or GLOVES for each marketplace must be checked against the stored definitions **(unconfirmed per product type)**.
- "—" means the channel has no such field.
- eBay values are localised for each site.

| # | Concept | Amazon | eBay aspect (EN / IT) | Shopify | Etsy |
|---|---|---|---|---|---|
| 1 | Title | item_name | listing Title (not an aspect) | title | title |
| 2 | Description | product_description | Description (HTML) | descriptionHtml | description (plain text) |
| 3 | Key features | bullet_point | — | — | — |
| 4 | Search terms | generic_keyword | — | tags | tags |
| 5 | Brand | brand | Brand / Marca | vendor | — |
| 6 | Manufacturer (GPSR) | manufacturer, gpsr_manufacturer_reference | regulatory.manufacturer | — | — |
| 7 | EU responsible person | dsa_responsible_party_address | regulatory.responsiblePersons | — | — |
| 8 | MPN / model | part_number, model_number | MPN | — | — |
| 9 | GTIN / EAN | externally_assigned_product_identifier | EAN | variant barcode | — |
| 10 | Category | product type + recommended_browse_nodes | categoryId (177104…) | category (taxonomy ID) | taxonomy_id |
| 11 | Colour | color | Colour / Colore | shopify.color-pattern | Primary / Secondary color |
| 12 | Size | apparel_size {system, class, value, body, height} | Size / Taglia | size + size-type | Size (with scales) |
| 13 | Gender | target_gender (+ department) | Department / Reparto | target-gender | set by the category path (unconfirmed) |
| 14 | Age group | age_range_description | Department (Kids) | age-group | set by the category path |
| 15 | Outer material | fabric_type / outer material (unconfirmed) | Material / Materiale del rivestimento esterno | fabric; gloves: handwear-material | materials (free text) |
| 16 | Lining | lining_description | Lining (unconfirmed) | — | — |
| 17 | Closure | closure | Closure (unconfirmed) | — | unconfirmed |
| 18 | Type / style | style, item_type_keyword | Type / Tipo; Style | productType (free text) | styles (at most 2) |
| 19 | Pattern | pattern | Pattern (unconfirmed) | pattern | unconfirmed |
| 20 | Features | special_feature | Features / Caratteristiche | outerwear-clothing-features / protective-gear-features | — |
| 21 | Waterproof | water_resistance_level | the "Waterproof" value of Features | "Waterproof" feature; glove waterproof construction | — |
| 22 | Protection standard (EN 17092 / 13594 / 1621) | no dedicated attribute found (unconfirmed) | Certification (CE, Level) | armor or glove certification standard | — |
| 23 | Armour location | unconfirmed | Armour location / Protective Features | glove-armor-placement, protector-coverage-area | — |
| 24 | Season | unconfirmed | Season / Stagione (unconfirmed) | — | — |
| 25 | Care | care_instructions | unconfirmed | care-instructions | — |
| 26 | Fit / sleeve | fit_type, sleeve | Fit, Sleeve Length (unconfirmed) | size-type, sleeve-length-type | — |
| 27 | Country of origin | country_of_origin | Country of Origin | inventory item country of origin | — |
| 28 | Weight / dimensions | item_package_weight / _dimensions | package details | variant weight | item_weight / length / width / height |
| 29 | Price, quantity, condition | purchasable_offer, list_price, fulfillment_availability, condition_type | offer price, quantity, condition | price, inventory | price, quantity |
| 30 | Variations | variation_theme, parentage_level, child_parent_sku_relationship | aspects with aspectEnabledForVariations | options (at most 3) | properties with supports_variations |
| 31 | Etsy-only fields | — | — | — | who_made, when_made, is_supply, production partners, ecgt_* |

**Main differences:**
- **Size:** Amazon uses a structured size tied to each store's size system; the others use flat values.
- **Colour:** Shopify colours are metaobject references; Etsy colours are shop-specific value IDs.
- **Protection standards:** only Shopify (gloves and protectors) and eBay model them. For garments on Amazon, look in bullet points and special features **(unconfirmed)**.
- **Materials and styles:** Etsy takes free text.

## Part B: How other tools separate core and channel attributes

The table was built from two parallel research passes. I spot-checked the Akeneo, Zentail and Productsup quotes against the live pages.

| Tool | Where fields for one channel live | Is the core the same for every channel? | Required fields and completeness per channel | With only one channel connected | Keeping up with schema changes |
|---|---|---|---|---|---|
| **Akeneo** | Values that differ by channel use the "value per channel" (scopable) flag in the core. Marketplace-only fields are "catalog targets" in the Activation mapping ([doc](https://help.akeneo.com/akeneo-activation-app-functionalities/akeneo-activation-select-map-and-transform-your-product-data)). | Yes: "all products belonging to the same family share the same attributes." | Built in: each family lists required attributes per channel, and each channel has "a dedicated completeness" ([doc](https://help.akeneo.com/v7-discover-akeneo-concepts/v7-what-is-a-channel)). Activation also shows readiness. | The family sets the form. Marketplace targets exist only in the Activation catalogs you have set up (interpretation). | A requirement-change dashboard, "updated daily", but "not available for all retailers" ([doc](https://help.akeneo.com/akeneo-activation-app-functionalities/akeneo-activation-channel-requirements-change-dashboard)). **Promotion:** "Suggest a new attribute" asks the admin to add one. |
| **Salsify** | Organisation-wide properties, often created from a retailer's Readiness Report | Mostly | The Readiness Report for each retailer | Shows "only the properties that apply to all categories" until a category is mapped (search snippet) | Claimed in marketing ("even if they change"). "Target Schema" is unconfirmed. |
| **Plytix** | Core attributes grouped by channel (for example "Shopify fields"), plus formatting at the feed ([doc](https://help.plytix.com/en/creating-a-feed-with-plytixs-feed-management-tool-templates)) | Partly | Completeness attributes built by hand, one per channel | Families filter attributes, not channels | Merchant re-uploads the Amazon template (unconfirmed) |
| **Pimcore** | Classes, bricks and the classification store; an output configuration per channel | Depends on the implementation | Custom rules | Custom | Handed off to the Productsup adapter |
| **inRiver** | Syndicate mapping per destination | Yes (interpretation) | "See instantly which fields are required or optional for each destination" | Fieldsets limit the fields shown | Uses Amazon's JSON schemas (marketing claim) |
| **Rithum** | Marketplace templates and marketplace rules; attributes can be limited to "Classifications" (unconfirmed) | Yes | Errors per marketplace | Unconfirmed | Unconfirmed |
| **Linnworks** | A configurator per channel (attributes, categories) and listing templates per SKU and configurator; extended properties override defaults ([doc](https://help.linnworks.com/support/solutions/articles/7000059577)) | Yes | A red channel column when a template has errors | No configurator exists until the channel is connected | Unconfirmed |
| **Channable** | Import rules are global; feed mapping and rules are per channel | Yes | Each feed has "mandatory, recommended and optional fields" | You see only the channel setups you created | Manual: "you must update the mapping of your feed" |
| **Productsup** | The import stage is read-only, the intermediate stage is shared, and each export stage "contains attributes specific to one export" ([doc](https://help.productsup.com/en/29493-29494-map-your-data-from-import-to-export.html)) | Yes | Category attributes appear only after classification mapping | Only the exports you have added | New Amazon product types are added "on request" |
| **Feedonomics** | One output template and mapping per channel; "hard stops block bad exports" | Yes | Per export | Unconfirmed | Unconfirmed |
| **BaseLinker** | A "Channels data" tab on the product card, plus parameter-mapping rules ([doc](https://base.com/en-EN/help/knowledgebase/product-card/)) | Yes | Errors appear at sending | Unconfirmed | Unconfirmed |
| **Shopify Marketplace Connect** | Metafields plus attribute mapping per marketplace; three modes: single edit, bulk edit and mapping | Yes | Per marketplace | Per connected marketplace | Unconfirmed |
| **Sellbrite** | Product and listing are separate records; category templates map item specifics and lock the fields they control | Yes | Driven by the template | Per channel | Unconfirmed |
| **Zentail** | Global "SMART Types" are pre-mapped to all channels. Channel attributes are used only for "a different value on a specific channel" or an attribute "not included in the SMART Type" ([doc](https://help.zentail.com/en/articles/3281143)). | Yes | Listable or Not Listable per channel | Channel attributes appear only when needed | Automatic mapping to Amazon product types (documented) |

**Documented pattern:** every tool keeps the core record the same for every channel. Channel fields live in a mapping, template or listing layer. Required fields are worked out per channel and category. Channel values can override core values (Zentail, Linnworks, BaseLinker, Akeneo scopable values).

**My interpretation:**
- No tool documents showing fields for channels that are not connected.
- Only Akeneo documents a way to promote a channel field into the core, and even that is a suggestion workflow.
- Keeping schemas current is automatic only in paid add-ons and in Amazon's own API.

## Part C: Recommendation

1. **The shared core holds only facts that belong to the product,** whichever channel uses them:
   - brand, MPN, GTIN and SKU
   - master title and description
   - colour, size, gender and age group
   - outer and lining materials, closure, and features such as waterproof
   - protection: EN 17092 class, EN 1621 armour level and location, EN 13594 glove level
   - season, care, country of origin, weights and dimensions
   - GPSR manufacturer and responsible person (Amazon, eBay and Etsy all need them)

   Store these as Nexus code-list values and translate them per channel through value maps. Never store a channel's own vocabulary in the core.
2. **Channel-only fields go in a per-channel layer.** Key it by channel, marketplace, and category or product type. Load it from each channel's live schema: Amazon's Product Type Definitions (PTD), eBay's `fetchItemAspects`, the Shopify taxonomy release, Etsy's category properties. It holds mappings, overrides and channel-only values: bullet points, `who_made`, offer and fulfilment data. As in Zentail, a channel value is used only when it deliberately differs from the core or when no core concept exists.
3. **The user sees the family's core attributes plus fields for the channels and markets actually connected.** Required status comes from each channel's readiness, never globally. A channel that is not connected adds nothing.
4. **Promote and demote both preview and can be undone.** When two or more channels map to the same concept, suggest promoting it: create the core attribute, point each channel mapping at it, and copy values across with a preview of conflicts. Demoting copies the core value into each channel's override. Neither deletes values; both are audited.
5. **Worst cases:**
   - **Only eBay:** the core plus that site's category aspects, with localised names and "Required soon" dates. No Amazon fields appear.
   - **Only Amazon:** the core plus the PTD for each chosen product type and store. Conditional requirements (`allOf`) are evaluated live, and offer and compliance data stay in the channel layer.
   - **A channel is added later:** fetch its schema, map it automatically through the crosswalk (A5), and show a gap report with bulk fill. The core does not change.
   - **A channel is removed:** hide its fields and archive its values so they can be restored. Suggest, never force, demoting core attributes only it used.
