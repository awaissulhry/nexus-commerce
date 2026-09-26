# Channel mappings — study and proposal (`feat/channel-mappings`)

**Status: 🟡 STUDY ONLY. No code is changed. Waiting for the Owner's approval (§10).**
Written 2026-09-26. Worktree `/private/tmp/nexus-channel-mappings`, branch `feat/channel-mappings`, based on
`feat/attributes` = `origin/main` `4f2e860b8`.

Labels: **read** = seen in code or in a file · **measured** = counted by a script on the real files ·
**inferred** = follows from the code, not run. Every number below was measured on 2026-09-26 unless it cites
an older record.

## Summary

- **Your question: "have we mapped each and everything?"** The answer is **yes for import, no for the rest.**
  - **Import works.** The channel file import (CFI, live since 2026-09-25) gives every filled cell of the 89 corpus files a
    decision. The last proof counted 273,125 cell decisions, 0 unaccounted, and 45,083 / 45,083 values back out of the
    product sheet's own export (`docs/channel-file-import/records/proof/2026-09-25-proof-3-final.md`).
  - **A decision is not always a mapping.** A cell is imported, kept out on purpose (price, stock, parentage) or refused
    with a reason.
  - **The mappings live in code, in about 37 places** (about 20 for Amazon, 17 for eBay). They do not agree. §4.4
    lists 10 places where the same field is mapped two ways.
  - **No mapping knows the template version.** Amazon files carry a template ID and a version (`2026.0713`). The code
    reads the ID only to store the file. Nothing records which version a file or a push used.
  - **The way back is missing.** Nexus cannot yet write a native Amazon or eBay file from the store that the import
    fills (CFI step "E-1" is not built). So there is no native round trip: file → Nexus → the same file.
  - **No test reads a real file.** All mapping tests build small files in memory. Only the manual CFI proof script
    reads your Desktop folder.
- **The files show facts that disagree between channels.** On the same GALE jacket, Amazon says the package is
  36 × 29 × 9 cm and 1.6 kg. eBay says 45 × 30 × 8 cm and 2 kg (§5).
- **Amazon workarounds leak into eBay.** AIREON uses Amazon's `team_name` for "Giacca / Pantaloni" and `athlete` for
  "Uomo". The GALE eBay file carries eBay item specifics `team name = Giacca`, `athlete = Unisex`, `body type = Regolare`.
- **Attribute changes on this branch: none yet.** `feat/attributes` has 0 commits of its own. Its plan is approved
  (P0 in progress) but is not committed. It is at `/private/tmp/nexus-attributes/docs/attributes/PLAN.md`. This study
  builds on that plan and does not repeat it.
- **The proposal (§8):**
  - Mappings become **versioned data**, one source of truth. Import, export and push all read it.
  - **Round-trip tests use the real files** (with care: the GitHub repo is **public**, §8.6).
  - **A new channel or template version is a new mapping, not new code.**
  - **The mapping screen** (`/channels/mapping`, which already exists) shows the unmapped and required fields for each
    template version.
- **Two decisions for you — §10.**

---

## 1. What I studied

| Source | What |
|---|---|
| Amazon files | `LISTNGS/JACKETS/Gale/Amazon/**` (the Owner's local corpus, not in the repository) (IT, DE, FR, ES, and `LISTINGS/*/FINAL`) and the whole `LISTNGS` corpus: 85 readable spreadsheets + 4 Excel lock files. Read only, with openpyxl in a scratch folder. |
| eBay files | `LISTNGS/JACKETS/Gale/eBay/IT/GALE IT.xlsx`, the 9 other `ebay_it` workbooks and the 6 root `XAVIA-eBay-IT-<FAMILY>.xlsx` files. |
| Earlier work | `docs/channel-file-import/**` (CFI plan, progress, corpus record, coverage, proofs). |
| Code | Every Amazon and eBay mapping place in `apps/api` and `apps/web` (two read-only helpers did the first pass; I re-checked the claims marked ✓ myself). |
| Attribute model | `packages/database/prisma/schema.prisma` and the approved attributes plan (`/private/tmp/nexus-attributes/docs/attributes/PLAN.md`, not committed). |

**What "bulk import format" and "legacy Excel" mean here.** I found no eBay bulk format that Nexus imports other than
our own workbook. I take these meanings (please correct me if wrong):

- **Our eBay bulk import format** = the `ebay_it` workbook, 79 columns. The eBay flat-file page exports it and CFI imports it.
- **Our legacy eBay Excel file** = the root `XAVIA-eBay-IT-<FAMILY>.xlsx` files, 66 columns. This is the same page's
  column set from before 2026-07-19. No code in the repo writes it.

## 2. Amazon templates

### 2.1 Versions in the corpus (measured)

54 files use Amazon's NEW template shape (plus `GALE IT.xlsx`, which is Strict OOXML and which openpyxl cannot open).
12 files use the OLD flat-file shape. The upload-ready files ("FINAL (upload this)") use one template per market:

| Market | Template version | Template ID (first 8) | Product types | Columns | Built-in value dictionary |
|---|---|---|---|---|---|
| IT | 2026.0713 | `a0fb4d0d` | COAT, PANTS | 344 | 226 fields |
| DE | 2026.0715 | `83de5919` | COAT, PANTS | 352 | 227 fields |
| FR | 2026.0715 | `10719676` | COAT, PANTS | 344 | 226 fields |
| ES | 2026.0715 | `64229c5a` | COAT, PANTS | 344 | 226 fields |
| IT (X-RACING suit) | 2026.0715 | `76ba3650` | APPAREL | 252 | 141 fields |

- **Every market has its own template ID.** The ID changes when Amazon issues a new version.
- **Older copies in the corpus use 5 older versions** (2025.0505, 0506, 0511, 0512, 0719), with 274–331 columns. Their
  value dictionary has only 8–9 fields. Two more copies use the 2026.0713 template with English headers.
- **Product types in the corpus:** COAT (all jackets), PANTS (AIREON trousers) and APPAREL (X-RACING suit). OUTERWEAR
  appears only in `amazon_OUTERWEAR_IT(.filled).xlsx`. That file is a flat attribute sheet with 151 columns, not an
  Amazon template.
- **Some families have no Amazon file in the corpus.** Gloves, protectors, leather pants and the helmet bag have no
  listing spreadsheet. The knee sliders have eBay files only.

### 2.2 What one template file carries (measured)

A NEW template is its own machine-readable contract:

- **Row 1 = settings.** Split over `settings`, `settings2` … `settings24`.
  - Identity: `templateIdentifier`, `Version`, `TemplateSignature` (the product types), `timestamp`, `umpVersion`.
  - Layout: `labelRow=4`, `attributeRow=5`, `dataRow=7`.
  - Market and language: `primaryMarketplaceId`, `contentLanguageTag`, `headerLanguageTag`.
  - `ptds` (the product types) and `browseClassifications` (the allowed browse nodes for each product type).
  - `attributeSettings`: for each field, the **localized label → Amazon code** list. Examples:
    - `Nuovo → new_new`, `Neu → new_new`
    - `Impermeabile → waterproof`, `Wasserdicht → waterproof`
    - `FORMATO/COLORE → SIZE/COLOR`, `GRÖSSE/FARBE → SIZE/COLOR`
  - `AttributeDefaultValues`: the default record action (full update).
- **Row 4 = labels** in the market language. **Row 5 = keys**: the SP-API attribute paths with qualifiers, for example
  `item_name[marketplace_id=APJ6JRA9NG5V4][language_tag=it_IT]#1.value`.
- **The data definitions sheet** (`Definizioni dati` / `Datendefinitionen` / …) gives each field a requirement level:
  required, conditionally required, recommended or optional.
- **Other sheets:**
  - `Valori validi` (valid values)
  - `Conditions List` (the values that switch conditional rules)
  - `AttributePTDMAP` (which field belongs to which product type)
  - `Dropdown Lists`

**This matters for the design.** The template keys are the SP-API schema paths. So a mapping keyed by the path works
in every market and survives most version changes. The template's own label ↔ code list replaces hand-made word
lists.

### 2.3 Requirement levels per market (measured, GALE FINAL files)

| Level | IT | DE | FR | ES | APPAREL (IT) |
|---|---|---|---|---|---|
| Required | 10 | 10 | 10 | 10 | 10 |
| Conditionally required | 82 | 81 | 82 | 82 | 52 |
| Recommended | 18 | 18 | 18 | 18 | 14 |
| Optional | 124 | 129 | 124 | 124 | 100 |

- **The 10 required fields are the same in all 5 templates:**
  - `contribution_sku` (SKU), `product_type`, `item_name`, `brand`
  - `amzn1.volt.ca.product_id_type` (EAN or GTIN exemption)
  - `product_description`, `bullet_point`, `fabric_type`, `country_of_origin`
  - `supplier_declared_dg_hz_regulation` (dangerous goods)
- **Main conditional fields (COAT/PANTS):**
  - Variation: parent SKU and variation theme.
  - Descriptive: model name, manufacturer, style, department, target gender, age range, colour and standard colour,
    weave type, care instructions, closure type, outer material, water resistance, item type name, number of items,
    special size type.
  - Size: the whole `apparel_size` record (system, class, size, size to, body type, height type). PANTS also need the
    `bottoms_size` record (plus waist and inseam).
  - Offer: list price, condition, fulfilment channel, quantity, shipping group.
  - Package: dimensions and weight, each with a unit.
  - Batteries and hazmat: about 25 fields.
  - The suit workaround fields: `team_name` and `athlete` (§2.5).
- **Recommended:**
  - collar style, model number, material, lining, item length, fit, pocket, pattern
  - sport, league, chest size, seasons, sleeve type, coat silhouette, inseam, pants form
- **DE has 5 fields that the others do not have.** All are optional: `epr_eco_fee_eubr` (value and currency),
  `regulatory_compliance_certification` (value and type) and `uvp_list_price`. DE lacks `ghs` classification.
- **APPAREL uses `size#1.value` (a plain size), not the `apparel_size` record.** So the same idea ("size") goes to
  different Amazon keys for each product type.

### 2.4 What changes between markets (measured, GALE, 21 SKUs × 4 markets)

- **16 fields are identical in all 4 files:**
  - SKU, product type, parent SKU, brand, manufacturer, number of items, the ASIN
  - the 5 image URLs
  - the package dimension and weight numbers
- **About 50 fields differ.** They fall into three kinds:
  1. **Same meaning, different language.** Condition `Nuovo / Neu / Nouveau / Nuevo`, colour `Nero / Schwarz / Noir / Negro`,
     units `Centimetri / Zentimeter / Centimètres / Centímetros`, yes/no `No / Nein / Non / No`. The template dictionary turns
     these into one code.
  2. **Free text in the market language, with no common code.** In the dictionary the code equals the label:
     - department `Uomo / Herren / Homme / Hombre`
     - closure `Cerniera / Reißverschluss / Fermeture éclair / Cremallera`
     - style `Militare / Militärmantel / Manteau militaire / Abrigo militar`
     - collar, care, item type name, special features
  3. **Real per-market choices:**
     - browse node (IT `2420941031`, DE `82838031`, FR `2429656031`, ES `2425315031`)
     - size system (`IT`, `DE/NL/SE/PL`, `FR/ES`) and FR size labels (`3TG` for `3XL`)
     - prices (ES 105, others 99) and list prices
     - special features in a different order in ES
     - fabric type `Poliestere` (IT) vs `100% Polyester` (DE, FR)
     - model name `Gale` (IT) vs `GALE`
     - search keywords only in IT
     - record action words

### 2.5 Template workarounds (measured)

AIREON is a jacket + trousers set. To vary by piece, its files use Amazon's sports fields:

| Field | IT | DE | FR | ES |
|---|---|---|---|---|
| `team_name` | Giacca / Pantaloni | Jacke / Hose | Veste / Pantalon | Chaqueta / Pantalón |
| `athlete` | Uomo | Herren | Homme | Hombre |

- The idea "piece of the set" has no field of its own in Nexus. Amazon gets it through `team_name`.
- The same values then appear on eBay as custom specifics (§3.3).

### 2.6 The OLD flat files (12)

- Keys are on row 3, and the market and language are in cell D1 (`settings=`).
- CFI converts about 75 old keys to new paths through one hard-coded table (`template-workbook.ts:365-445`,
  `LEGACY_RENAMES`). Example: `item_sku → contribution_sku#1.value`.
- A key that is not on the list becomes `<key>#1.value`.

## 3. eBay files

### 3.1 Two shapes, both from our eBay flat-file page (measured + read)

| | `ebay_it` workbook (current) | `XAVIA-eBay-IT-<FAMILY>` (legacy) |
|---|---|---|
| Files | 10 (sheet `ebay_it`) | 6 (sheet named by family) |
| Columns | 79, headers on row 1 | 66, headers on row 1 |
| Only here | Action, Follow, Buffer, Video ID, Max Per Buyer, Merchant Location, Description Theme, 7 `⚠` columns | the old generic `Price (EUR)` |
| Item IDs | on parents and children | none |

- **The column set comes from `apps/web/src/app/products/ebay-flat-file/ebay-columns.ts`:**
  - Fixed columns: `:136-555`.
  - Market columns: `:570-641`.
  - Aspects from eBay's taxonomy at run time: `:681-698`.
  - Ghost columns: `:834-853`.
- **The server writes the XLSX** (`routes/ebay-flat-file.routes.ts:2973-3014`, `services/export/renderers.ts:113-127`).
- **Both corpus shapes were saved by openpyxl, not by our renderer** (their `docProps/app.xml`). Only the column sets
  come from our code.
- **Header marks** (✓ read `ebay-columns.ts:688`):
  - `*` = eBay requires the aspect.
  - `○` = eBay recommends it.
  - `↕` = it can be a variation axis.
  - `⚠` = a "ghost": the rows carry it, but no loaded category schema declares it.
- **Since 2026-07-25 (`6d1d31db4`) aspect headers put English first**, for example `Color (Colore)`. Every corpus file
  was made before that, so all of them show `Colore (Color)`.

### 3.2 Required eBay fields, category 177104 (jackets), IT (measured from the headers + read)

- **Aspects:**
  - Required: `Marca` (Brand).
  - Recommended: `Adatto a` (department), `Taglia` (size), `Materiale` (material).
  - Can be a variation axis: `Taglia`, `Colore`, `Scollatura`.
- **Listing fields our eBay spec marks required** (`channel-specs/ebay.ts:106-114`):
  - price
  - quantity
  - title (80 characters or fewer)
  - description
  - condition (a strict list)
  - Subtitle is 55 characters or fewer.

### 3.3 What `GALE IT.xlsx` (eBay) holds (measured)

- **105 rows = 5 parent listings.** They share the same 20 child SKUs (the Shared-SKU setting is `True`). One product is
  in 5 eBay listings.
- **Multi-value aspects are one text with commas:**
  - `Materiale = Poliestere, Nylon`
  - `Caratteristiche = Ventilato, Imbottitura rimovibile, Leggero, …`
  - Amazon holds the same facts as separate numbered fields.
- **Colour is in three columns with the same value** (`Colore`, `Colore specifico`, `Colore esatto`). The same is true
  of gender (`Adatto a` and `Genere ⚠`).
- **The 7 `⚠` columns:**
  - `Genere = Uomo`
  - `Livello di protezione = CE Livello 2`
  - `Paese di fabbricazione = Pakistan`
  - `Tipo di giacca = Da moto`
  - `athlete = Unisex`
  - `body type = Regolare`
  - `team name = Giacca`
  - The last three are Amazon field names (§2.5) that became eBay item specifics.
- **CFI now imports the `⚠` columns as custom item specifics** (`catalog-ebay-workbook.ts:270-274`; proof 3:
  1,266 / 1,266). That reverses the 2026-09-15 import, which left them out. CFI flagged this for your decision
  (`docs/channel-file-import/lane-requests.md:17-24`). It is still open.

### 3.4 Other eBay formats in the code (read)

| Format | Where | Direction |
|---|---|---|
| File Exchange CSV (one family) | `routes/ebay-cockpit.routes.ts:718-822` | export only |
| Sell Feed `INVENTORY_TASK` (NDJSON) | `services/ebay-feed.service.ts:91-115` | push |
| `bulk_update_price_quantity` | `outbound-sync.service.ts:1732` | price and quantity only |

- There is no File Exchange import.
- There is no Seller Hub template.
- There is no `bulkCreateOrReplaceInventoryItem` call.

## 4. Our mappings today (read)

### 4.1 Amazon — about 20 places

| Direction | Place | Defined by |
|---|---|---|
| Import (CFI) | `pim/catalog-amazon-workbook.ts:128-179` | Built at run time from the cached SP-API schema (`CategorySchema`). Price, quantity, parentage and identifier roots are hard-coded (`:78-80, :133-138`). Values: the file's own dictionary first, then the schema's enum names, then word lists (`BOOLEAN_WORDS :87-92`, `LEGACY_UNITS :104-107`). |
| Import (old files) | `amazon/template-workbook.ts:365-445` `LEGACY_RENAMES` | About 75 keys, hard-coded. |
| Import (FX wizard) and vault export | `amazon/flat-file-mapping.ts:90-160` | Hard-coded `TEMPLATE_PATH_ALIASES` and `AMAZON_ALIAS_MAP` (about 35 supplier aliases). |
| Read-back into master text | `pim/reverse-mapping.service.ts:160-165` | Hard-coded 4 keys. It skips DE, FR and ES (`:64-70`). |
| Export (native `.xlsm`) | `amazon/template-vault.service.ts:214-263` → `template-workbook.ts:806` | The FX mapping in reverse. The rows come from the flat-file page, **not** from the store the import fills. |
| Export (grid rows) | `amazon/flat-file.service.ts:2146-2512` | A hard-coded row (`:2340-2395`), then the remaining attributes. |
| Push (flat-file feed) | `flat-file.service.ts:2772` and a second copy at `:3639-3740` | Two hard-coded key lists. |
| Push (product sheet) | `pim/studio-publication-amazon.ts:34-163` | Rules from `Marketplace.schemaMapping`, defaults from `mapping/master-default-rule.ts:5-20` and `channel-specs/amazon.ts:45-73`, value maps from `FieldValueMap`. |
| Push (patch) | `outbound-sync.service.ts:317-365` | Hard-coded. |
| Read-back and drift | `amazon/flat-file-pull.service.ts:250-275`, `channel-drift/amazon-content-compare.ts:20`, and 3 more | Hard-coded key lists. |

- **Template identity:** `templateIdentifier` is read (`template-workbook.ts:748`) ✓. It is used only as the storage key
  of `AmazonTemplateVault`.
- **Not stored:** the `Version` and the settings timestamp. CFI records no template identity at all.

### 4.2 eBay — 17 places

| Direction | Place | Defined by |
|---|---|---|
| Schema | `ebay-category.service.ts:963-983`, `channel-specs/ebay.ts:103-196` | eBay taxonomy at run time (per category + market, cached for 24 h). English names come from a static list `ebay-aspect-names.ts`. |
| Page ↔ workbook | `ebay-columns.ts`, `EbayImportWizard.tsx`, `importAspects.pure.ts:38-53` | TS constants + a synonym table |
| Import (CFI) | `pim/catalog-ebay-workbook.ts:48-68, 238-274` | 26 fixed columns in code. Aspects are matched by the header's first name against the stored localized name. An unmatched header becomes a custom specific. |
| Push (Inventory API) | `ebay-variation-push.service.ts:1270-1330` | Synonyms (`ebay-theme-axes.ts:47-73`), axis renames, a per-market brand table |
| Push (Trading API) | `ebay-shared-listing-push.service.ts:194-238`, `studio-publication-ebay-changes.ts:78-201` | Code + the ChannelSpec |
| Push (mapping engine) | `pim/mapping/prepare-dispatch.ts:45-58` | ChannelSpec |
| Push (feed mode) | `ebay-feed.service.ts:99-107` | English aspect names hard-coded (Brand, Colour, Size, Material …) |
| Rules and value maps | `Marketplace.schemaMapping`, `FieldValueMap` (AI-seeded, reviewed) | DB |
| Read-back | `ebay-import.service.ts:70, 108-117` | Hard-coded name lists |
| Amazon → eBay rows | `ebay-flat-file.routes.ts:3829-3852` | Hard-coded |

### 4.3 What already exists that the design can reuse (read)

- **`/channels/mapping`** (web `apps/web/src/app/channels/mapping/**`, API `routes/channel-mapping.routes.ts`).
  - Filters: mapped / unmapped / owned.
  - Priorities: required / required if relevant / best practice / optional.
  - Drawers: auto-map, clone, history, business rules, and an impact review before a rule is applied.
  - **It edits push rules only.** File import and file export do not read them.
- **`Marketplace.schemaMapping`** (JSON, `schema-mapping.service.ts:36-148`):
  - `version`, `fields`, `byProductType` overlays, named formulas, variation rules.
  - Transforms: `valueMap`, `sizeScale`, `unit`, `numberFormat`, `template`, `channelLimit`, `translate`, `expr` and
    string ops.
- **`MappingRevision`**: a snapshot before each edit (`mapping-revision.service.ts`).
  - It is kept per marketplace, **not per template version**.
  - Only the **last 30** are kept (`MAX_REVISIONS = 30`) ✓.
- **Other tables:**
  - `FieldValueMap` (value maps per channel · market · attribute, with confidence and review)
  - `SizeScaleMap`
  - `CategoryChannelMapping` (category ↔ product type or eBay category, and the browse node)
  - `AmazonTemplateVault` (template bytes by template ID)
  - `CategorySchema` (cached channel schema with `schemaVersion`)
  - `SchemaChange`

### 4.4 Where the same field is mapped two ways

| # | Field | Place A | Place B | Checked |
|---|---|---|---|---|
| 1 | Sale price | CFI + old-file table + patch: `purchasable_offer#1.discounted_price…` (`template-workbook.ts:405`, `catalog-amazon-workbook.ts:148`) | FX page + feed: `purchasable_offer[…]#1.sale_price…` (`flat-file.service.ts:1044-1052`) | ✓. The real templates use `discounted_price`, so the FX page's path cannot match a template column (inferred, not run). |
| 2 | Seller SKU per market | CFI plan: `ChannelListing.channelSku` | Built: `platformAttributes.sellerSku` | ✓. The column exists only on `VariantChannelListing` (`schema.prisma:1482`). |
| 3 | Parent SKU | grid export: the parent **product** SKU (`flat-file.service.ts:2332`) | product-sheet push: the parent's **seller** SKU (`studio-publication-amazon.ts:139`) | read |
| 4 | Best Offer | spec labels: floor = "auto-accept", ceiling = "auto-decline" (`channel-specs/ebay.ts:123-124`) | page + push: floor = auto-**decline**, ceiling = auto-**accept** (`ebay-columns.ts:329-342`) | ✓. The product sheet shows the wrong meaning. |
| 5 | eBay aspect headers | page export since 07-25: `Color (Colore)` | CFI keeps the first name (`catalog-ebay-workbook.ts:68`) and compares it with the stored localized name | ✓ read. A new export would import `Color` as a new custom specific (inferred, not run). |
| 6 | Best Offer store | cockpit: `bestOfferEnabled` … | flat file: `bestOffer` … | read |
| 7 | Language tag | feed: `LANGUAGE_TAG_MAP`, falls back to `it_IT` | content: from the Marketplace row | read |
| 8 | Identifier | CFI: `merchant_suggested_asin` | FX: `::external_product_id`, new rows only | read |
| 9 | Yes/no words, synonyms | `BOOLEAN_WORDS`; web synonym table | coerce tokens; server synonym table (with extra DE/FR entries) | read |
| 10 | Content keys | 4 copies (`reverse-mapping`, `AMAZON_CONTENT_KEYS`, `CONTENT_ROOTS`, `APPLY_SNAPSHOT_KEY`) | — | read |

### 4.5 Tests today (read)

- **All mapping tests build their files in memory.** The eBay test header says so: "the Owner's own files are never
  read by a test". So do the CFI fixtures (`catalog-transfer-test/channel-file-fixtures.ts`).
- **The real corpus is read only by scripts:**
  - `apps/api/scripts/cfi-corpus-proof.mts` (manual, needs a local DB whose name contains "test")
  - `_parse3-files.mts`
- **The CFI round trip is file → Nexus → the product sheet's own export.** It is not file → Nexus → the channel's file.

## 5. The same jacket on two channels (measured, `GALE-JACKET-BLACK-MEN-M`, Amazon IT vs eBay IT)

| Fact | Amazon IT | eBay IT | One fact? |
|---|---|---|---|
| Brand | XAVIA RACING WWW.XAVIARACING.IT | Xavia Racing | should be one brand, or a deliberate per-channel name |
| Colour | Nero | Nero | ✓ |
| Size | M (code `m`), size system IT | M | ✓ |
| Material | Poliestere; Nylon (2 fields) | "Poliestere, Nylon" (1 text) | same list, different shape |
| Features | 5 numbered fields | 1 comma text | same list, different shape |
| Closure, collar, care, country | same words | same words | ✓ |
| Gender / department | Maschio / Uomo | Genere ⚠ Uomo / Adatto a Uomo | ✓ (two concepts) |
| Style | Militare | Da motociclista | ✗ different |
| Season, protection | — | Tutte le stagioni, CE Livello 2 | eBay only today |
| Package weight | 1.6 kg | 2 kg | ✗ **a physical fact that differs** |
| Package size | 36 × 29 × 9 cm | 45 × 30 × 8 cm | ✗ **a physical fact that differs** |
| Price | 99 | 105 | per channel (fine) |
| Main image | Shopify CDN URL | Amazon media URL | different source, maybe the same picture |
| Category | browse node 2420941031 | category 177104 | per channel (fine) |

## 6. Verdict: is everything mapped?

| Question | Answer |
|---|---|
| Does every filled cell of the corpus reach a decision on import? | **Yes** (CFI proof 3: 0 unaccounted of 273,125). |
| Is every column mapped to a Nexus field? | **No.** Price, stock, parentage, record action and identifiers are kept out or sent to other doors, on purpose. The FINAL + eBay files gave 859 refusals, each with a reason (for example 518 unadopted eBay `-ALT` shells on the test copy, and 170 shipping-template checks). |
| Is there one mapping per field? | **No.** About 37 places. 10 known disagreements (§4.4). |
| Can Nexus write the same Amazon or eBay file back? | **No.** E-1 is not built. The native export reads the flat-file page's store, not the store that the import fills. |
| Does Nexus know which template version it mapped? | **No.** |
| Are the channels' own values consistent for one product? | **No.** See §5 and the leaked `⚠` specifics. |
| Is it proven by tests on the real files? | **No.** Only by a manual script. |

## 7. What the attribute model needs

This adds to the attributes plan (concept catalogue, `semanticKey`, `optionMode`, one required engine). It lists only
what the files prove.

### 7.1 Missing fields (concepts)

| Concept | Why (evidence) |
|---|---|
| **Seller SKU per channel + market** | MOSS is `IT-MOSS-JACKET` in IT and `MOSS-JACKET` in DE/FR/ES. MISANO uses Amazon-made SKUs. It is stored today inside `platformAttributes.sellerSku`, not in a column. |
| **Package dimensions and weight as one physical fact** (measure + unit) | Amazon and eBay disagree (§5). Amazon requires them when shipping applies. |
| **Size as a record**: system, class, size, size-to, body type, height type (+ waist and inseam for trousers) | Amazon `apparel_size` / `bottoms_size`. The system changes per market (`IT`, `DE/NL/SE/PL`, `FR/ES`), and so does the label (FR `3TG`). APPAREL uses one plain `size` instead. |
| **Piece of a set** (jacket / trousers) | AIREON misuses `team_name` for it on Amazon, and it leaks to eBay (§2.5, §3.3). |
| **Protection level** (for example CE Level 2) | eBay `Protezione` and `Livello di protezione`. Amazon has it only in bullet text. |
| **Season** | eBay `Stagione`; Amazon `seasons` (recommended). |
| **Features** as an ordered list | Amazon `special_feature` 1–5 (order differs per market); eBay one comma text. |
| **Materials** as an ordered list, plus outer material and fabric-type text | Amazon `material` 1–3, `outer.material`, `fabric_type` (required, with free text such as "100% Polyester"). |
| **Dangerous goods, batteries, GHS, safety data sheet** | `supplier_declared_dg_hz_regulation` is required. Batteries: 2 fields in every file, about 25 more conditional. |
| **Compliance media** | 818 filled cells (`compliance_media.source_location`). |
| **EU / DE compliance** | DE EPR eco fee, regulatory certification, UVP list price. The OUTERWEAR sheet also has GPSR manufacturer reference, safety attestation and responsible-party address. |
| **Browse node and category per market** | 4 different Amazon browse nodes for GALE. `CategoryChannelMapping` has `browseNodeId` and a `marketplace` column, so it can hold one per market. How it is filled today was not measured (M0). |
| **Product ID or GTIN exemption** | `product_id_type` is required. GALE uses "GTIN exemption". |
| **Department** (market-language text) as its own concept, apart from gender and age | Amazon has all three. On eBay, `Adatto a` = department. |

### 7.2 Types

| Type | Example | Today |
|---|---|---|
| Text | model name | yes |
| Text per language | title, bullets, description, keywords | yes (translations) |
| HTML vs plain text | eBay description is HTML; Amazon is plain text | not checked |
| **Code list with per-market labels** | condition, water resistance, gender, variation theme | partly. The template's own label ↔ code list is not stored. |
| **Market-language list with no code** | department, closure, style, collar, care | not modelled. It needs a value map per market. |
| **Ordered list with positions** | bullets 1–5, features 1–5, images PS01–05, materials | partly. eBay needs join and split rules. |
| **Measure** (value + unit) | package size and weight | yes (`validation.unit`). Units are spelled per channel (`Centimetri`, `CENTIMETER`, `cm`). |
| **Record** (several linked parts) | apparel size | no typed shape |
| **Identifier** | seller SKU per market, ASIN, eBay Item ID, EAN or exemption | scattered |
| **Per-market reference ID** | browse node, eBay category, policy IDs, shipping group | scattered |
| Money | list price, price, sale window | the price door (keep it) |
| Yes/no with local words | `No / Nein / Non` | 2 different word lists (§4.4 #9) |

### 7.3 Validation

- **Allowed values per channel + market + template version.** Take them from the template dictionary and from eBay
  (`SELECTION_ONLY` vs `FREE_TEXT`), not from hand lists. Use the attributes plan's one "open dropdown" rule: save
  anything, flag the channel.
- **Lengths:** eBay title 80, subtitle 55 (our spec). Amazon lengths come from the SP-API schema (`maxLength`,
  `maxUtf8ByteLength`), which `channel-specs/amazon.ts:296` already reads.
- **Counts:** bullets 5, features 5, product images 5 + main, materials 3 (template columns).
- **Conditional rules.** Amazon has 52–82 conditional fields for each template. Examples: a child needs a parent SKU and
  the axis values of its variation theme, and batteries need about 25 fields. The attributes plan puts these in one
  engine (its §4.6). Mapping must feed that engine the same keys.
- **Language:** text must be in the market language (CFI already refuses other languages).
- **Across fields:**
  - one parent per child
  - every axis filled on every child
  - one seller SKU per listing per market
  - physical facts (weight, size) equal on every channel unless an override is on purpose

### 7.4 Required fields per channel (for the jacket family)

| Channel · market · type | Required | Conditionally required (main ones) |
|---|---|---|
| Amazon IT/DE/FR/ES · COAT | the 10 in §2.3 | parent SKU, variation theme, colour, size record, department, gender, age range, style, closure, outer material, water resistance, list price, condition, package dimensions and weight, fulfilment channel |
| Amazon IT/DE/FR/ES · PANTS | the same 10 | as COAT + the `bottoms_size` record, leg style, rise style |
| Amazon IT · APPAREL | the same 10 | 52 in total; plain `size` |
| eBay IT · 177104 | Brand; title ≤ 80, description, condition, price, quantity | recommended: department, size, material; variation axes: size, colour, neckline |

## 8. Proposed mapping design

### 8.1 Rules

1. **One source of truth.** Import, export, push and read-back all read the same mapping data. No second key list
   anywhere.
2. **Mappings are versioned data.**
   - An active version never changes. An edit makes a new version.
   - Every import, export and push records the version it used.
3. **A new channel or template version is a new mapping, not new code.** Code is needed only for:
   - a new file shape (for example, the first time we read a Shopify CSV)
   - a new kind of transform
4. **Round-trip tests on the real files** prove each active version.
5. **The screen shows what is unmapped and what is required** for each version, before anything is activated.

### 8.2 What a mapping version holds

One **mapping set** = one channel · market · form. A form is one of these:
- An Amazon template (product types + template ID + version).
- An SP-API product type (for push).
- An eBay category + our workbook layout.

| Part | Content |
|---|---|
| Identity | channel, market, language, product types or category, template ID, template version, layout (label, key and data rows), a fingerprint of the key row |
| Status | draft → active → retired. One active set per channel · market · form. `basedOn` = the version it was copied from. |
| Channel dictionary | the template's own label ↔ code lists and requirement levels, copied from the file (Amazon) or from eBay's taxonomy. It is read-only and versioned with the set. |
| Field rows | one per channel field: key (for Amazon, the schema path without market qualifiers), localized label, requirement, **target** (a Nexus attribute or concept, a listing field, a managed door such as price or stock, identity, or "ignore"), scope (shared / language / channel · market), **transform**, direction (in / out / both), **state** (mapped / ignored with a reason / managed elsewhere / unmapped) |
| Value maps | a Nexus option ↔ a channel value, per market. These stay in `FieldValueMap`, because a business choice ("Nero → black") must outlive a template version. The set references them and reports how many values are covered. |

**The transforms are a closed list.** Each is code written once. A mapping picks it by name.
- copy
- value map
- template dictionary (label ↔ code)
- list, split or join (with position)
- measure (value + unit)
- record (for example, the size record)
- selector (for example, size system)
- yes/no words
- date
- constant
- formula (the existing `expr`)
- the existing string ops

### 8.3 How a new template version arrives

1. **A file arrives.** Nexus reads its template ID and version. When no active set has them, Nexus makes a **draft**:
   - It copies the nearest active set (same channel, market and product types).
   - It matches fields by schema path, because Amazon paths rarely change.
   - It loads the file's own dictionary and requirement levels.
2. **The draft shows the difference:**
   - new fields
   - removed fields
   - fields whose requirement changed
   - value lists that changed
3. **The import of that file runs only if every filled column is mapped, ignored or managed elsewhere.** If not, it
   stops with "N columns are not mapped" and a link to the screen.
4. **You review and activate.** Activation is refused while a required field is unmapped. The round-trip test (§8.6)
   runs on activation.

**A new channel follows the same path.** The attributes plan's adapter reads the channel's rules into the common
`ChannelSpec`. The first mapping set starts from the concept catalogue's channel links, then from the screen.

### 8.4 One engine

- **Import:** the CFI readers stop using their own tables. They ask the active set for each column: `LEGACY_RENAMES`,
  the fixed eBay columns and the header matching.
- **Export (this delivers E-1):** the native Amazon `.xlsm` and our eBay workbook are written from the product-sheet
  store through the **same** set, in the file's own template (`AmazonTemplateVault` already keeps the bytes).
- **Push:** `schemaMapping` rules become field rows of the SP-API-product-type set. The existing `/channels/mapping`
  history and impact review keep working on top.
- **Read-back and drift:** read the same set.
- **Deletion:** every hard-coded key list in §4.1–4.2 is deleted when its reader has moved. The deletion is the proof
  that there is one source.

### 8.5 Where the data lives

- **New business-owned tables:**
  - `ChannelMappingSet` (identity, status, basedOn, dictionary)
  - `ChannelMappingField` (the field rows)
- They follow the tenant checklist in `packages/database/CLAUDE.md`: `workspaceId`, RLS policy, ownership and
  scoped-key entries.
- They are additive. Nothing is dropped.
- **Shipped defaults:** the first sets are seeded from JSON files in the repo, generated once from today's code tables
  and the corpus templates.
- **Carried over from today's tables:** `Marketplace.schemaMapping` stays readable during the move. `MappingRevision`
  history is kept.

### 8.6 Round-trip tests on the real files

- **The golden set** (7–9 files, each for a reason):

  | File | Why |
  |---|---|
  | GALE IT, DE, FR, ES FINAL | 4 markets, one template version each |
  | AIREON DE FINAL | COAT + PANTS, and the `team_name` workaround |
  | X-RACING IT | APPAREL |
  | MOSS DE FINAL | per-market parent SKU |
  | one OLD flat file | the old shape |
  | `GALE IT.xlsx` (eBay) | shared SKUs and custom specifics |
  | one `XAVIA-eBay-IT` file | the legacy shape |

- **Four checks for each file:**
  1. **Nothing unmapped.** Every filled cell is mapped, ignored with a reason, or managed elsewhere. This is the CFI
     ledger, now read from the set.
  2. **Native round trip.** File → import (on a disposable DB) → export in the same template with the same set → the
     same cells as the original. The only allowed differences are named in the set (for example: record action blank,
     FBA quantity blank). A planted change must be caught.
  3. **Version pin.** Each golden file names the set version it expects. A change to the set shows exactly which cells
     move.
  4. **Push parity.** The SP-API payload built for the imported product equals the file's values after the dictionary
     turns labels into codes. It is offline: nothing is sent.
- **Where the files live — a decision (§10, D2).** The GitHub repo `awaissulhry/nexus-commerce` is **public** (checked
  2026-09-26). The real files hold your seller contributor ID, eBay policy and item IDs, prices and stock. **They must
  not be committed.**

### 8.7 The mapping screen (extend `/channels/mapping`)

- **Pick a form:** channel · market · product type or category · template version. Each version has a badge: active,
  draft or retired.
- **Counters on top:**
  - required unmapped (red)
  - conditional unmapped
  - value misses
  - ignored
  - "changed in this version"
- **One row per channel field**, with these columns:
  - the channel label and key
  - the requirement, in the template's own words and in ours
  - the Nexus field
  - the transform
  - value coverage (for example 12 / 15)
  - a sample value from a real product
  - the state
- **Filters:** unmapped · required · value misses · changed in this version · ignored.
- **Actions:**
  - map
  - ignore with a reason
  - open the value map
  - compare two versions
  - activate (refused while a required field is unmapped; runs the §8.6 checks first)
- **Build rules:** design-system components only (`apps/web/src/design-system`), keyboard use, light and dark themes,
  7:1 contrast. Any missing control goes into the design system first.

### 8.8 Steps and proof

Every step:
- a DB copy whose name contains `test`
- `tsc` for the API, web and `packages/shared`
- a positive control (a planted change the test must catch)
- a claim row in `docs/pes-claims.md` before the first edit

| # | Step | Done when |
|---|---|---|
| M0 | **Measure.** Count today's `schemaMapping` rules, `FieldValueMap` rows, vault entries and `CategoryChannelMapping` rows (read-only). Run the §8.6 check 2 by hand on GALE IT to get today's baseline. | The numbers are written into this file. No code changes. |
| M1 | **Tables + seed.** The two tables, the tenant checklist, and JSON defaults generated from the code tables and the corpus templates. | The GALE IT/DE/FR/ES and eBay IT sets exist as drafts. RLS tests pass. |
| M2 | **Import reads the sets.** Both CFI readers. Each import records the set version it used. | CFI proof 3 gives the same numbers from the sets. `LEGACY_RENAMES` and the fixed eBay column map are deleted. |
| M3 | **Export from the same store (E-1).** Native `.xlsm` and eBay workbook through the sets. | §8.6 check 2 passes on the golden set. |
| M4 | **Push reads the sets.** Product-sheet push, flat-file feed, patch and eBay pushes. | §8.6 check 4 passes. The second feed key list and the English feed aspects are deleted. |
| M5 | **Golden tests in CI.** | Checks 1–4 run on every change to a set or to the engine. |
| M6 | **The screen.** | Every §8.7 element is checked in a real browser (light, dark, 390 px, keyboard). A new template version can be taken from draft to active with no code change. |
| M7 | **Clean-up.** The remaining key lists in §4.1–4.2 are removed. The §4.4 drifts are closed. | A grep finds no second list. §4.4 has 0 open rows. |

### 8.9 Who owns what (to agree before M1)

- **Attributes lane** (`feat/attributes`): `pim/mapping/**`, `FieldValueMap`, the channel specs, the required engine.
  This plan uses them. The concept catalogue becomes the default target of the field rows.
- **PSIE lane** (product-sheet import/export, `/private/tmp/nexus-product-sheet-import-export`): the product-sheet
  import/export files. E-1 (M3) touches the same store.
- **CFI code:** `catalog-*-workbook.ts`, `channel-file-sniff.ts` and `template-workbook.ts`.
- **This lane** would own the new tables, the set engine, the golden tests and the screen extension.

## 9. Risks

- **A push migrates prod.** The tables are additive. No push or deploy happens without your word.
- **Moving the push to the sets (M4) can change what Amazon or eBay receives.** Payloads must be compared before and
  after, offline, before each switch.
- **Template dictionaries are large** (about half a megabyte of settings text per file). Store them once per template ID, not per set
  copy.
- **The public repo.** Committed fixtures must be anonymised (§10, D2). This study quotes no contributor ID, policy ID
  or item ID.
- **The eBay header change (§4.4 #5) may already mis-import new exports.** This should be checked with one real export
  before any other step. It is read in code, not run.

## 10. Decisions for you

**D1 — Where the mapping versions live.**
- **A (recommended): tables per business, seeded from shipped JSON defaults, edited on the screen.** A version is
  frozen once active. Every file and push names its version. This is the only way the screen can change a mapping with
  no code release.
- **B: JSON files in the repo, changed by a commit.** Git gives the history. But every mapping change needs a code
  release, and the screen can only read.

**D2 — Real files for the tests (the repo is public).**
- **A (recommended): two layers.**
  - Anonymised copies of the golden files are committed. They keep the same template bytes and keys, with made-up
    SKUs, IDs, prices and text. CI runs on them.
  - The real files stay in a private place. They run as the gate before a mapping version is activated.
- **B: real files on this Mac only**, run by hand as today's CFI proof. CI tests only the in-memory fixtures.

Also open, from CFI: should eBay `⚠` custom specifics (for example `team name = Giacca`) be kept or dropped
(`docs/channel-file-import/lane-requests.md:23-24`)? This study suggests dropping the three Amazon workaround names and
modelling "piece of a set" as a real concept (§7.1).
