# LX Step 0 — production measurement and decision record

Measured **2026-09-12 00:15:23–00:15:36 Europe/Rome** (2026-09-11 22:15:23–22:15:36 UTC).
Status: **Step 0 measured; D1–D7 remain unanswered. Steps 1–7 have not started.**

Executed through Railway's production `@nexus/api` environment with `--no-local`. PostgreSQL reported
`transaction_read_only=on` and `transaction_isolation=repeatable read`. The transaction was rolled back.
The production role can see the full catalogue; RLS visibility was checked explicitly. Production still uses
the schema before workspace columns, which the evidence labels `(pre-workspace-schema)`.

## Baseline

| Measurement | Result |
|---|---:|
| Products / root products | 338 / 37 |
| Channel listings | 977 |
| Marketplace rows / distinct languages | 20 / 9 |
| ProductTranslation rows | 1, English |
| Product.localizedContent slots | 676 |
| Empty JSON slots | 675 |
| JSON slots with text | 1, Italian title on GALE-JACKET |
| Slots with `_meta` review metadata | 0 |
| Nonempty titleOverride / descriptionOverride | 0 / 0 |
| Nonempty bulletPointsOverride | 512 |
| Cross-channel groups with identical bytes | 4 |
| Cross-channel groups with different bytes | 286 |
| Groups represented in only one channel | 21,358 |
| Observations lacking a language authority | 0 |

| Language | JSON slots | Empty slots | Slots with text | Translation rows |
|---|---:|---:|---:|---:|
| en | 338 | 338 | 0 | 1 |
| it | 338 | 337 | 1 | 0 |

The sole Italian JSON title is byte-identical to GALE-JACKET's native `Product.name` (127 bytes).
The existing English translation overlaps an **empty** English JSON slot; no field has competing authored
values in those two stores. Under the build prompt's “every slot” requirement, the expected target is 676
translation rows: 675 new row keys plus the existing row retained. Empty slot counts must remain distinct
from translated-content counts. These are backfill expectations, not a performed backfill or dry-run result.

Cross-channel comparisons are keyed by product, field and normalized language, preserving workspace and
listing/account/alias attribution. All 290 comparable groups are Italian Amazon/eBay text: 183 titles
(179 different, 4 identical) and 107 descriptions (all different). “Different” means different stored bytes;
this measurement cannot determine whether customization was intentional. HTML, whitespace, Unicode and
array order are preserved. Every stored candidate is retained, including differences within a listing;
this is an inventory of stored values, not the Step 3 old/new resolver shadow comparison. The 21,358
single-channel groups include channel-native language-tagged attributes and cannot prove cross-channel parity.

## Every marketplace row

All rows have a scalar `language`; the `languages` array column is absent.

| Channel | Market | Language | Active |
|---|---|---|---|
| AMAZON | BE | nl | yes |
| AMAZON | DE | de | yes |
| AMAZON | ES | es | yes |
| AMAZON | FR | fr | yes |
| AMAZON | IE | en | yes |
| AMAZON | IT | it | yes |
| AMAZON | NL | nl | yes |
| AMAZON | PL | pl | yes |
| AMAZON | SE | sv | yes |
| AMAZON | TR | tr | yes |
| AMAZON | UK | en | yes |
| AMAZON | US | en | no |
| EBAY | DE | de | yes |
| EBAY | ES | es | yes |
| EBAY | FR | fr | yes |
| EBAY | IT | it | yes |
| EBAY | UK | en | yes |
| ETSY | GLOBAL | en | yes |
| SHOPIFY | GLOBAL | en | yes |
| WOOCOMMERCE | GLOBAL | en | yes |

## Locale stores and migration sequencing

Regional tags occur in 587 ChannelListing rows and 72 APlusContent rows. The listing scan found 12,518
`it_IT`, 7,190 `de_DE`, 2,131 `fr_FR` and 2,701 `es_ES` occurrences in named locale/tag fields or flat-file
language selectors. All 72 APlusContent rows use `it-IT`. These are occurrences, not counts of translations.
The full evidence retains each row ID and JSON path. The scanner excludes ordinary field names such as
`fit_type`, `de_qty` and `end_at`; positive and negative controls cover that distinction.

No regional tags were found in Product locale bags or ProductTranslation.language. ProductSeo, BrandStory,
ProductAiDraft, CellFormula and AssetLocaleOverlay each contain zero rows. The Etsy information, Shopify
information and media locale bags each contain zero slots. Linked-product locale fields and the verbatim
flat-file snapshot were scanned recursively. Flat-file snapshots were only read.

Production has 425 applied migrations; this working tree has 433 migration folders. Eight local folders
are pending, with no unfinished migration records:

1. `20260908_amazon_media_workspace`
2. `20260908a_business_workspaces`
3. `20260908b_workspace_data_isolation`
4. `20260908c_sync_log_result_columns`
5. `20260908d_profile_directory_pagination`
6. `20260908e_guarded_account_assignment`
7. `20260911020000_information_formula_destination`
8. `20260911_category_taxonomies`

The four main tables lack the `workspaceId` columns declared in the working Prisma schema. Before applying
LX migrations, reconcile this deployment prerequisite with the existing migration plan. A broad
`migrate deploy` would also apply the eight unrelated folders. This audit applied zero migrations.

## Owner decisions required by the supplied build prompt

The design's recommendations remain appropriate for implementation; this audit makes no new UX decisions.

| Decision | Recommended answer from design §14 |
|---|---|
| D1 | Channels inherit shared language text by default; moving a pin to shared content requires acknowledgement. |
| D2 | Use ProductTranslation as the store of truth for non-primary text. |
| D3 | Add ordered Marketplace.languages now; Belgium starts with Dutch then French. |
| D4 | Store language-only keys (`de`); derive regional publish tags. |
| D5 | Store factual attribute codes with localized labels, under a separate gate after Step 5. |
| D6 | Retire the legacy edit page once the Languages view is visibly verified. |
| D7 | Require review before machine-generated translations can publish. |

**Next gated work: Step 1, dependent on D2.** The build prompt §2.6 says: “The seven decisions in design §14
must be answered by the Owner before the step that needs them.” Design §11 also requires each step's
measured record to reach the Owner before the next step. This document is the Step 0 record for that review.

## Verification and artifacts

`measure.mjs --self-test`: **13/13 positive and negative controls passed**, exit 0. `node --check`: exit 0.
The final Railway production run: exit 0, ten required store tables read, named fixture positive control
present, full-catalogue visibility verified, transaction rolled back. The script's SHA is embedded in the
baseline; artifact mtimes and SHA-256 hashes are recorded in `manifest.json`.

- [Measurement script](measure.mjs): rerunnable read-only production probe with controls in the same run.
- [Baseline JSON](production-baseline.json): counts, all marketplace IDs, schema coverage, migration drift,
  transaction receipt and compressed-detail checksum.
- [Full per-group and per-path evidence](production-details.json.gz): JSON containing `comparisons`,
  `regionalTags` and `slotDetails`. Text values are represented by hashes and byte lengths.
- [Manifest](manifest.json): file mtimes and hashes, including the ledger snapshot after the final entry.

No application files changed, no database writes, no migrations, no commits. There is no screen gate for this
read-only step. The existing mock remains at `/design/language-axis`; this audit makes no new visual claim.
