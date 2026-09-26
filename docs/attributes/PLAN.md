# Attributes — audit and plan (`feat/attributes`)

**Status: 🟢 APPROVED by the Owner 2026-09-26** ("Go ahead, I'll go with your recommendations").
Decision 1 = **A** (keep the JSON value stores + GIN index). Decision 2 = **A** (readiness catches up after a big save).
Progress is in §10 at the end of this file.
Written 2026-09-26. Worktree `/private/tmp/nexus-attributes`, branch `feat/attributes`, based on `origin/main` `4f2e860b8`.
Lane: the attribute system — schema, shared types, API logic. The product-sheet UI and import/export belong to other
sessions (§7).

## Summary

- **Keep the scopes you like.** Shared (master) values, then channel and market overrides, is the right model. It is
  also the model that the best PIM tools use. We keep it. We fix what is under it.
- **The problems are under the hood, not in the idea:**
  - A bulk edit sends one SQL statement for each product.
  - Up to 9 different readers can answer "what is this value", and some give different answers.
  - Channel links only work when two names match exactly.
  - A dropdown value that is not on the list is refused, warned about, or blocked, depending on which screen you use.
  - Amazon is the only channel whose rules the nightly job refreshes, and that job is off unless an env flag turns it on.
- **The plan has 8 parts:**
  1. One attribute dictionary for each business, plus a shipped catalogue of common "concepts" (colour, size, material…) that already know their Amazon, eBay, Shopify and Etsy names.
  2. One rule reader for each channel. Channel rules refresh themselves.
  3. Automatic links and value maps. A person reviews only the unsure ones.
  4. One "open dropdown" rule everywhere: pick a value, type your own, or save it as a new option. Nothing is lost. A problem value gets a flag and a fix button.
  5. Keep the value stores. One writer and one reader.
  6. One engine for required fields. Its results are stored, so filters are instant.
  7. Set-based bulk writes. Readiness is rebuilt after the save, not inside it.
  8. Tenant safety tests for every attribute table.
- **All schema changes are additive.** No table is dropped and no data is moved in this plan.
- **Two decisions for you** — §8.

---

## 1. Your question: shared scope + channel scopes, or only channel-specific attributes?

**Keep the shared scope with channel and market overrides.** Reasons:

1. **One fact, one edit.** "Colour = Black" is one fact about the jacket. With only channel-specific attributes you must
   type it 4 times (Amazon, eBay, Shopify, Etsy) and again for each market. The copies drift apart.
2. **You can still choose different values.** An override on Amazon IT wins over the shared value only there.
   "Follow master" removes the override. This already works (`docs/2026-09-06-master-first-implementation.md`).
3. **It is the proven model.** Akeneo (values "per channel and per locale" on one product), Salsify and Plytix all work
   this way: one product record, channel views over it, and overrides only where needed.
4. **Channel differences go in the mapping, not in copies.** Amazon wants `black`, eBay IT wants `Nero`. A value map
   does that once for every product. No product is edited.

So the structure stays. The changes below are in the engine under it.

## 2. What we have today (audit)

Read from code on 2026-09-26. Three read-only helpers did the first pass. I re-checked the facts marked ✓ in the code myself.

### 2.1 Definitions (the dictionary)

| Fact | Where |
|---|---|
| Business-owned dictionary exists: `AttributeGroup`, `CustomAttribute` (type, validation JSON, localizable, scope global/per_variant), `AttributeOption` (code + label), `FamilyAttribute` (required + channels[]), `ProductFamily` with parent inheritance | `schema.prisma:549-750` ✓ |
| Select values are stored by option **code**; labels are per language in `metadata.labels` | `family-sheet-schema.ts:88-89` ✓ |
| Shape (list/measure) lives inside the `validation` JSON, not in a typed column | `family-sheet-schema.ts:92` ✓ |
| CRUD API: 13 routes in `attributes.routes.ts`, 15 in `families.routes.ts`. **No bulk create/update** for attributes or options | helper report |
| No attribute types or zod schemas in `packages/shared`; the real contract (`ChannelFieldSpec`) lives in the API; web keeps hand-made copies | `channel-specs/types.ts:57-160` ✓ |

### 2.2 Channel rules

| Fact | Where |
|---|---|
| One adapter per channel exists: Amazon, eBay, Shopify, Etsy. One output shape (`ChannelSpec`), with `mode: strict|open` | `channel-specs/*.ts` ✓ |
| Conformance test covers Amazon and eBay only; Etsy and Shopify hard-code `unrecognised: []` | helper report |
| **About 9 other walkers still read the Amazon schema their own way** (schema-to-fields, schema-caps, schema-sync-bridge, flat-file, wizard parser, variation-theme-segments, image slots, matrix SQL, web categories page) | helper report |
| Nightly refresh: Amazon only, and **off unless `NEXUS_ENABLE_SCHEMA_REFRESH_CRON=1`** (the prod value was not checked) | `jobs/schema-refresh.job.ts:44,97` ✓ |
| eBay aspects are fetched one category at a time | `ebay-category.service.ts:866` ✓ |
| Shopify metafield `choices` are not turned into dropdown options; Shopify taxonomy attribute values are display-only | helper report |
| Schema caches (`CategorySchema`, `ChannelSchema`, `MarketplaceTaxonomy*`) are per business (RLS) | `model-ownership.json` |

### 2.3 Links and value maps (canonical → channel)

| Fact | Where |
|---|---|
| A default link exists only when the channel key equals a master key, or when `masterKey` is set by hand (5 Amazon keys, 1 eBay key) | `mapping/master-default-rule.ts:5-19` ✓ |
| `FieldValueMap` (channel, market, attribute, from → to, confidence, reviewedAt) is the right table, but a default link **never adds a value-map step** | `schema.prisma:2122` ✓ |
| A value-map miss **passes the value through unchanged** unless the rule says `onMiss: 'flag'` | `resolve-channel-field.ts:335-349` ✓ |
| AI value seeding: Amazon and eBay only | helper report |

### 2.4 Values, scopes and writes

| Fact | Where |
|---|---|
| Master values: `Product.categoryAttributes` (JSON, no index). It also holds control keys (`variations`, `ebayClusterParent`, `ebayFileExcluded`) | helper report |
| Other languages: `ProductTranslation.attributes`. Channel overrides: `ChannelListing.overrideData`, typed `*Override` columns, `platformAttributes`, `ChannelListingTranslation.attributes` | helper report |
| Bullets can sit in about 7 stores; variant axes in 3 | helper report |
| **At least 9 resolvers** answer "what is this value". Known disagreements: empty override, title while following master, flat-file snapshot vs platformAttributes, raw sync ignoring overrides and value maps | helper report |
| **Bulk write = one statement per product** (plus one per child per field), all in one transaction | `bulk-edit.service.ts:2459-2491, 2548` ✓ |
| Readiness is rebuilt for each touched family **before the commit** (inside the save) | `bulk-edit.service.ts:2795-2798`, `readiness-index.service.ts:17-25` ✓ |
| Readiness is already stored in a table (`ReadinessIndex`, per product × channel × market × account × language) | `schema.prisma:19672` ✓ |
| Two "bulk" readiness endpoints still loop one product at a time; the family chain is read one parent per query | `families.routes.ts:310-316, 380-392`, `family-hierarchy.service.ts:115-123` (helper) |
| A master `attr_*` write needs a market context, because its definition is looked up in that market's Amazon schema | memory `reference_attr_write_needs_marketplace_context` |

### 2.5 Dropdowns and validation

| Surface | Off-list value on a strict list | Where |
|---|---|---|
| Web grid editor | warns | `grid/editors/sheet.ts:132-139` (helper) |
| Bulk save | **refuses** | `sheet-values.ts:255-258, 304-306` ✓ |
| Readiness | warning, on purpose ("the operator may know something the cached schema does not") | `readiness.service.ts:26-37` ✓ |
| Mapping engine | error | `mapping/validate-channel-value.ts:30-32` (helper) |
| Dispatch | blocks | `mapping/prepare-dispatch.ts:30` (helper) |

- There is no way to add your own option to a channel list.
- The same idea has 4 names: `mode`, `enumMode`, `selectionOnly` and eBay `aspectMode`.
- A master select is strict, but it silently turns open when any channel column for the same key is open (`sheet-columns.service.ts:1001`).

### 2.6 Tenant safety

- Every attribute table has `workspaceId` from `current_setting('nexus.workspace_id')`, FORCE RLS, a generated policy and a cross-tenant reference trigger (`packages/database/scripts/workspace-policies.mjs`).
- Guards: `check-model-ownership`, `check-policy-migration-parity`, and the CI migration-upgrade comparison.
- **Gap:** no test proves RLS on the attribute tables, and `families.routes.ts` has no route tests.

## 3. The problems, ranked

1. **Slow bulk edits.** One statement per product, plus a readiness rebuild inside the same transaction. 1,000 products means at least 2,000 write statements, plus a rebuild for each family, in one 60 s transaction.
2. **Many readers, many writers.** One value can be answered 9 ways and written 6 ways (some writers rewrite the whole JSON with no version check). That is how "the sheet says X, Amazon got Y" happens.
3. **Links are name-matching only.** Brand, colour and size on eBay, Shopify and Etsy do not link to master unless someone maps them by hand.
4. **Dropdowns are closed and inconsistent.** No custom options on channel lists. The same off-list value is refused on one surface and allowed on another.
5. **Channel rules go stale.** The refresh job covers Amazon only and is off unless an env flag turns it on. eBay is fetched per category. Shopify options are missing.
6. **Required fields are computed in 4+ places.** Amazon's conditional rules are evaluated on only one path.

## 4. The design

### 4.1 One dictionary per business, plus a shipped concept catalogue

- **Keep** `CustomAttribute`, `AttributeOption`, `AttributeGroup`, `FamilyAttribute`, `ProductFamily`. They are business-owned and under RLS. We add no second registry.
- **New: a concept catalogue in code** (`packages/shared/attributes/concepts.ts`). A concept is a common product fact
  (brand, colour, size, size system, material, gender, age group, pattern, style, fit, GTIN, country of origin, item
  weight, item dimensions, care instructions …; about 60 to start — an estimate). Each concept carries:
  - its shape (scalar / list / measure / record) and value kind;
  - its **channel bindings**: the Amazon attribute(s), the eBay aspect English name(s), the Shopify taxonomy attribute or metafield, and the Etsy property;
  - **synonyms per language** for value matching (Nero = Black = Schwarz = Noir).
- **Link a business attribute to a concept** with one new column: `CustomAttribute.semanticKey`. A concept can link to at most one attribute per business.
- **Sensible defaults.** A new business gets a starter dictionary made from the concepts. A business can rename, hide, extend or add its own attributes. The concept only supplies the channel links.
- **Adding a channel later** = one adapter file + one binding column in the concept file + the conformance test. No product changes.
- **Typed shape and dropdown mode.** `validation` gets a typed contract (zod, in `packages/shared`): `shape`, `optionMode: 'strict' | 'open'`, `unitOptions`, limits. **Default `optionMode` = open** (you can type anything). A business can make one attribute strict (for example Size system).
- **Bulk dictionary endpoints:** create/update many attributes and options in one call, reorder, and archive an option (the old values stay valid).

### 4.2 Channel rules: one reader per channel, and they refresh themselves

- The 4 adapters become **the only readers** of raw channel schemas. The ~9 other walkers move to call the adapter.
  I move the API-side ones in my lane. The flat-file and wizard walkers move with their owners' agreement.
- **Compile once, store it.** When a schema is fetched, the adapter output (the `ChannelSpec`) is saved with a content
  hash. Sheets, readiness and writes read the saved spec. A cold server reads the saved spec. It never silently falls
  back to a short column set (the Shopify cold-cache bug).
- **Complete coverage:**
  - **eBay:** fetch every category's aspects for a marketplace in one bulk file (eBay Taxonomy `fetch_item_aspects`, gzip). This means no eBay value list is missing. Phase 0 checks that our credentials can call it.
  - **Shopify:** turn metafield `choices` into options, and read the standard taxonomy attribute values (the file we already download).
  - **Etsy and Shopify:** real conformance tests, like Amazon and eBay.
- **Automatic refresh for all 4 channels.** It runs daily for every (channel, market, category) that a business
  uses, and it is on by default. Each change is written to `SchemaChange` with the affected products. Then:
  - readiness is rebuilt in the background for those products;
  - you see one clear notice, for example "Amazon IT added a required field to OUTERWEAR — 48 products now miss it".
- Caches stay per business (RLS). This is today's rule and it passes every guard. A shared global cache would save
  space, but Amazon rules can differ per seller, so it is not worth the risk now.

### 4.3 Links and value maps: automatic first, a person only for the unsure ones

- **Links.** `masterDefaultRule` gets one more source: the concept binding. So brand, colour, size, material and the
  others link on all 4 channels with no setup. Your own mapping rules still win (`Marketplace.schemaMapping`, kept as it is).
- **Value maps.** When a link targets a **strict** channel list, the default rule adds a value-map step with
  `onMiss: 'flag'`. A miss is never silent again.
- **Auto-match ladder.** This runs when a link is made, when an option is added, and when a channel list changes:
  1. same code → 2. same label (case and accents ignored) → 3. concept synonyms → 4. translation → 5. AI suggestion.
  - Steps 1–3 are saved as matches.
  - Steps 4–5 are saved as "needs review" (`FieldValueMap.reviewedAt = null`, this already exists).
- **Fix once, fix all.** A flag such as "‘Nero’ is not an Amazon colour" has a button: "Map Nero → black for Amazon".
  That writes one value-map row, and every product with Nero is fixed.

### 4.4 The open dropdown — one rule on every surface

Every dropdown cell offers 3 things, each labelled with where it comes from:

1. **Your options** (the business dictionary).
2. **The channel's values** (from the saved spec). On the master scope you see the values of the linked channels, with channel badges.
3. **Your own text:** "Use ‘X’" or "Save ‘X’ as a new option" (adds an `AttributeOption` for your business).

**Save rule (the same on every write path):**

- **Blocked only when the value cannot be stored.** Examples: letters in a number field, or an unknown unit.
  The error says what is wrong and what to type.
- **Never blocked because of a channel's list.** The value is saved. The channel gets a flag, with fix buttons:
  - map to a channel value;
  - pick a channel value;
  - refresh the channel's list.
  This follows your words ("write anything of my choice") and today's readiness policy.
- **Publishing that one listing** stays held while the flag is open, because the channel would refuse the value
  anyway. Every other listing and channel is not affected.
- **One word for the idea:** `optionMode: 'strict' | 'open'` in the shared contract. `enumMode`, `selectionOnly` and
  `aspectMode` are converted to it at the edges.

The API side is mine: the options endpoint, the "save as option" endpoint, the value-map endpoints and the flag codes.
The product-sheet session builds the combobox (§7).

### 4.5 Values and scopes: keep the stores, one writer, one reader

- **Keep the stores:** master in `Product.categoryAttributes`, other languages in `ProductTranslation.attributes`, and channel overrides in `ChannelListing` / `ChannelListingTranslation`.
  - The grid reads whole product rows. One JSON read per row is faster than joining 150 value rows.
  - Akeneo stores values the same way: JSON on the product row, and completeness in a separate table.
  - More than 130 files read these stores (99 read `categoryAttributes`, 130 read `platformAttributes`). A new value table would mean rewriting all of them (see §8, decision 1).
- **One writer.** Every attribute write goes through one set-based writer (§4.7). It always does an atomic JSON merge
  with a version check. It never rewrites the whole bag. The two writers that skip validation (`bulk-schema-update`, bulk-action `ATTRIBUTE_UPDATE`) are routed through it.
- **One reader.** `resolveBatch` becomes the only answer to "what is this value". Before each other reader is switched
  over, we compare the old reader with `resolveBatch` using `resolver-shadow.ts` (this file already exists). The unused `resolveFieldValue` is deleted.
- **Master attribute definitions come from the business dictionary**, not from a market's Amazon schema. So a master write no longer needs a market context.
- **Index:** one GIN index (`jsonb_path_ops`) on `Product.categoryAttributes`, built `CONCURRENTLY`. Filters such as "colour = Nero" then use the index.

### 4.6 Required fields: one engine, stored results

- **One function** decides "required here". It combines:
  - the channel spec's requirement;
  - Amazon's conditional rules (the Ajv code in `mapping/schema-requirements.ts`, which is today used on one path only);
  - the family's required flags.
- Its result goes to `ReadinessIndex` (this table already exists).
- **Cells show:** "Required by Amazon IT", "Required by eBay DE", or "Required by your family Jackets".
- **Filters** such as "missing required for eBay DE" are one indexed query on `ReadinessIndex`.
- **Bulk readiness endpoints** read the index. They no longer rebuild each product.

### 4.7 Speed at scale

- **Set-based writes.** Changes are grouped by (store, key). Each group is one statement, for example:
  `UPDATE "Product" p SET "categoryAttributes" = COALESCE(p."categoryAttributes",'{}') || v.patch, version = version + 1 FROM unnest($ids, $patches, $versions) v(id, patch, expected) WHERE p.id = v.id AND p.version = v.expected RETURNING p.id`.
  - Rows that fail the version check come back with their ids, so each cell gets a clear answer.
  - The same pattern (with `INSERT … ON CONFLICT`) is used for translations and channel overrides.
  - Audit rows are written with one multi-row insert.
  - Chunks of up to 5,000 rows.
- **Readiness moves out of the save.**
  - Small edits (up to about 50 families) still update readiness in the same request, so single-cell edits feel the same as today.
  - Larger edits commit first. Readiness is then rebuilt in a background job, once per family. The cell shows "checking…" until it is done.
- **Very large edits** (above about 20,000 cells) run as a job with progress and per-row results.
- **Reads:** specs are loaded once per distinct (channel, market, category), never per row. Families are loaded once per business and walked in memory (no query per parent).
- **Targets.** Phase 0 measures today's numbers first. These targets are then confirmed:
  - 10,000 products × 1 attribute: the save commits in under 5 s, and readiness settles in under 60 s.
  - Warm column load under 50 ms.
  - The number of statements does not grow with the number of products.
  - Measured on real Postgres (not PGlite), because a call-count test cannot prove batching.

### 4.8 Tenant safety

- **Every changed or new table follows the checklist** in `packages/database/CLAUDE.md`:
  - `workspaceId` default, unique keys that start with `workspaceId`;
  - entries in `model-ownership.json` and `scoped-keys.json`;
  - the generated policy + grant in the migration;
  - `check:drift`, `check-model-ownership` and `check-policy-migration-parity` pass.
- **New RLS tests** on real Postgres, with two businesses A and B:
  - B cannot read or write A's attributes, options, value maps or families;
  - a B row that points at A's option is refused by the reference trigger;
  - bulk writes cannot touch another business's products.
- The concept catalogue is code, so it holds no tenant data.

## 5. Schema changes (all additive)

| Change | Why |
|---|---|
| `CustomAttribute.semanticKey String?` + unique `(workspaceId, semanticKey)` where not null | the link to a concept |
| `AttributeOption.synonyms String[] @default([])`, `AttributeOption.archivedAt DateTime?` | value matching; retire an option without breaking saved values |
| Saved compiled spec: `CategorySchema.compiledSpec Json?` + `compiledHash String?` (or a small new business-owned table, if the JSON is too large for the row) | a fast cold start; no silent short column set |
| `SchemaChange.affectedProducts` is filled (the column already exists, but is empty today) | the "48 products now miss it" notice |
| GIN index on `Product.categoryAttributes` (`CONCURRENTLY`, in its own migration) | fast attribute filters |
| No table is dropped. No value is moved. `shape` / `optionMode` stay in the typed `validation` JSON | a low-risk migration |

## 6. Steps, and how each step is proven

Every step: tests on a DB copy whose name contains `test`, `tsc` for the API and for `packages/shared`, and a positive control (a planted change that the test must catch).

| # | Step | Done when |
|---|---|---|
| P0 | **Measure.** Today's timings for bulk edits (1k and 10k products), column load and readiness rebuild. A read-only eBay bulk-aspects call. | Numbers are written into this file. No code is changed. |
| P1 | **Shared contract** in `packages/shared/attributes`: shapes, `optionMode`, requirement, value types, flag codes, zod. The API uses it. | One vocabulary. The web copies can switch over (sheet session). |
| P2 | **Speed:** the set-based writer, readiness out of the save above the threshold, and the bulk endpoints reading `ReadinessIndex`. | The P0 targets are met. The statement count is flat from 10 to 10,000 products. Every existing bulk-edit test passes. |
| P3 | **Dictionary:** `semanticKey`, the concept catalogue, starter seeding, bulk dictionary endpoints, and family loading without N+1. | A new business gets a working dictionary. RLS tests pass. |
| P4 | **Channel rules:** saved compiled specs, eBay bulk aspects, Shopify choices and taxonomy values, Etsy/Shopify conformance, and a refresh job for all 4 channels. | For each channel, what the adapter declares equals what the channel's schema has. A cold server gives the full column set. |
| P5 | **Links and value maps:** concept links, the auto-match ladder, and `onMiss: 'flag'` by default on strict lists. | On GALE-JACKET, brand, colour and size link on all 4 channels with no manual rules. A planted miss shows a flag. |
| P6 | **The open dropdown (API):** the options endpoint, "save as option", one save rule on every write path, and flags with fix actions. | The same off-list value gets the same answer on the grid, bulk save, readiness and dispatch. |
| P7 | **One required engine** into `ReadinessIndex`. | Amazon conditional rules show on the sheet and in filters. One function, one answer. |
| P8 | **One reader:** move the other resolvers to `resolveBatch`, with shadow comparison first. | The shadow log shows 0 differences over a full catalogue pass before each switch. |

The order is chosen so that speed (P2) comes early. It depends only on P1.

## 7. Who owns what

**My lane (I edit these):**
- `packages/database/prisma/schema.prisma` (attribute models only) and new migrations;
- `packages/database/workspaces/*.json` entries;
- `packages/shared/attributes/**` (new);
- `apps/api/src/services/pim/{channel-specs,mapping}/**`;
- `apps/api/src/services/pim/`: `attribute-resolver`, `resolve-channel-field`, `value-map.service`, `readiness*`, `sheet-values.ts`;
- `apps/api/src/services/products/bulk-edit.service.ts`;
- `apps/api/src/routes/{attributes,families,value-map}.routes.ts`;
- `apps/api/src/jobs/schema-refresh.job.ts`;
- `apps/api/src/services/family-*`.

**Shared border (API logic that feeds the sheet):** `sheet-columns.service.ts`, `studio-sheet.service.ts`. I change
these only through the shared contract, and I tell the sheet session before each change.

**I do not touch:**
- Product-sheet UI: `apps/web/**/_studio/sheet/**`, both `design-system/**` trees, `services/saved-views/**`, `docs/product-sheet-views/`.
- Import/export: `catalog-transfer*`, `catalog-*workbook*`, `channel-file-*`, `flat-file/import/**`, and the flat-file export.
- The flat-file and wizard schema walkers move only with their owners' agreement.

## 8. Decisions for you

**Decision 1 — where values live.**
- **A (recommended): keep the JSON value stores and add a GIN index.** Fast whole-row reads, and no big rewrite (more than 130 files read these stores). Akeneo uses the same idea.
- **B: a new table with one row per value.** Easier per-value history and SQL filters, but millions of rows, a join for every grid read, and every reader rewritten. It is slower to ship and has more risk.

**Decision 2 — readiness after a big bulk edit.**
- **A (recommended): the save commits first, and readiness catches up in the background** (under a minute for 10,000 products). Small edits stay instant, as today.
- **B: keep readiness inside the save.** It is always up to date when the save returns, but a large bulk edit can hit the 60 s transaction limit.

## 9. Risks

- **Moving readers to `resolveBatch` (P8)** can change what a screen shows. The shadow comparison comes first. Each switch is one small change.
- **The eBay bulk aspects file** may need a scope that our app does not have. P0 checks this before P4 depends on it.
- **The production readiness backlog:** readiness is rebuilt in the background, so a very large edit shows "checking…" for a short time. That state must be honest: never "ready" while it is not computed.
- **A push migrates prod** (business profiles are on). Every migration is additive, and no push or deploy happens without your word.

## 10. Progress

| Step | State | Notes |
|---|---|---|
| P0 | ✅ done 2026-09-26 | §10.1. The eBay bulk-aspects check moves to P4 (the step that needs it). |
| P1 | ✅ done 2026-09-26 | `packages/shared/attributes.ts` (+ 26 tests, 2 planted mistakes caught); API channel types are its aliases; eBay `aspectMode` converted through `optionModeFrom`. API `tsc` clean; 136 channel tests pass. |
| P2 | ✅ built 2026-09-26 (not pushed) | §10.2 |
| P3 | ✅ built 2026-09-26 (not pushed; apply on the Owner's business waits for his word) | §10.3 |
| P4 | ✅ built 2026-09-26, 2 items open (eBay bulk aspects, walker migration) | §10.4 |
| P5 | ✅ built 2026-09-26 (not pushed) | §10.5 |
| P6 | ✅ API built 2026-09-26 (not pushed); the screens are the product-sheet session's (§11) | §10.6 |
| P7 | ⬜ not started — touches readiness/sheet files shared with the product-sheet session | — |
| P8 | ⬜ not started — same, plus the resolvers every surface reads | — |

**Rebased on `main` c5597f776 (2026-09-26, before shipping):** main had merged PR #4 (Prisma 7; background work moved
to separate worker and scheduler processes). The readiness worker is now registered in `runtime/worker.ts` and the
pending drain cron in `runtime/scheduler.ts` (not `index.ts`). Prisma 7's pg adapter reports a raw-SQL conflict as
`P2010` with `meta.driverAdapterError.cause.kind = 'TransactionWriteConflict'`; the retry rule reads that shape too
(the race test failed without it, then passed 3/3). After the rebase: guards, type-checks (shared, database, API, web)
and the route ratchet pass; API suite 12,419 pass, 7 fail (the same environmental 7); every real-Postgres suite passes;
500-product save on 10,000 products: 1.8 s, 500/500 read back.

**Verification of P0–P6 together (2026-09-26, final code before the rebase):** full API suite 12,115 tests — 11,954 pass, 153 skipped,
8 fail: 7 fail identically on a clean `main` checkout against the same database (`variation-*` live-catalogue tests
and `database-target`, environmental), 1 was a dropped connection under full-suite load (passes alone, on both
checkouts). Real-PostgreSQL runner: every suite passes, including the new race test. Shared package: 278 tests pass.
Type-checks clean: API, shared, web. No file of the product-sheet or import/export sessions was changed.

### 10.1 P0 — today's numbers (measured, not estimated)

Private copy `nexus_attributes_test` (a `pg_dump` of the local dev DB + the 3 newer `main` migrations), with
GALE-JACKET cloned 476 times (`tools/seed-scale.sql`: 9,996 products, 61,880 listings). Tool: `tools/p0-measure.mts`,
which calls the same functions the routes call and counts every SQL statement (positive control: a known query must
move the counter, or the tool refuses). One attribute (`attr_collar_style`), one value, Amazon IT context.

| What | Products | Families | Time | Statements | Result |
|---|---:|---:|---:|---:|---|
| Column set, Amazon IT OUTERWEAR (161 columns), cold | – | – | 191 ms | 30 | ok |
| Column set, warm | – | – | 0 ms | 0 | ok |
| Readiness rebuild, one family (714 rows = 21 products × 34 destinations) | 21 | 1 | 3.0–5.3 s | 953–1,167 | ok |
| Bulk save | 21 | 1 | 5.6 s | 1,297 | saved (read back 21/21) |
| Bulk save | 100 | 5 | 18.1–18.4 s | 5,403 | saved (100/100) |
| Bulk save | 10 | 10 | 35.1 s | 9,775 | saved (10/10) |
| Bulk save | 100 | 100 | 60.1 s | 14,667 | **failed at the 60 s transaction limit — nothing saved** |
| Bulk save | 500 | 24 | 60.0 s | 19,150 | **failed — nothing saved** |
| Bulk save | 1,000 | 48 | 60.1 s | 19,565 | **failed — nothing saved** |

**What the numbers say**

- The cost is the readiness rebuild inside the save: about 3.5 s and about 1,000 statements per family, because it builds the
  whole studio sheet once per destination (34 here). The attribute write itself is about 4 statements per product.
- Today a bulk edit that touches more than about 15 families cannot be saved at all.
- **Correction to §4.7:** "small edits up to about 50 families stay inline" was a guess. At 3.5 s per family, 50 families
  would take about 3 minutes. The inline limit is **2 families** (a single-cell edit, a parent + child edit): those keep
  today's behaviour exactly. Anything bigger commits first and readiness catches up in the background (Decision 2 = A).
- **Correction to the §4.7 target** "readiness settles in under 60 s for 10,000 products": at 3.5 s per family, 476 families
  take about 28 minutes of rebuild work. Moving readiness out of the save fixes the failures, but it does not make the
  rebuild itself cheaper. Making the rebuild cheaper is part of P7 (one required engine, only the affected destinations).

### 10.2 P2 — speed (built, tested, not pushed)

**What changed**

1. **Readiness leaves the save above 2 families.** `produceReadinessForProducts` (readiness-index.service.ts) finds every
   touched family with ONE query. Up to `INLINE_READINESS_MAX_FAMILIES = 2` it rebuilds inside the save (today's
   behaviour). Above it, it marks the families' `ReadinessIndex` rows `pendingSince = now()` in the SAME transaction as
   the values, and after commit enqueues one `readiness:<rootId>` job per family (`workers/readiness.worker.ts`).
   The durable half is `jobs/readiness-pending.job.ts`: every minute, a 45 s budget, oldest pending family first, records
   a run only when there is work. A listing-only edit rebuilds only its channel coordinate. A rebuild clears any mark it
   did not replace (a product deleted after it was marked), so a mark is never drained forever.
2. **Honest readers.** `ScopeReadiness.pendingSince`, `byProduct[].pendingSince` and `ListingReadinessRow.pendingSince`
   say "this verdict is the previous one". Optional fields: existing clients are unaffected. The UI must show
   "checking…" — handed to the product-sheet session (§7).
3. **Set-based attribute writes.** `setBasedAttrMerges` folds each product's merges in order and writes up to 2,000
   products per `UPDATE … FROM jsonb_to_recordset(…)`. `cascadedFields` removals and pushes likewise. A merge that
   touches variation axes keeps its per-product statement.
4. **Migration** `20260926a_attr_readiness_pending`: one nullable column + one index. Additive.

**Measured after (same copy, same tool, §10.1 for before)**

| Save | Families | Before | After | Statements before → after |
|---|---:|---:|---:|---:|
| 21 products | 1 | 5.6 s | 6.2 s (inline, unchanged by design) | 1,297 → 1,239 |
| 100 products | 5 | 18.1 s | **1.4 s** | 5,403 → 159 |
| 500 products | 24 | failed at 60 s | **2.9 s** | 19,150 → 559 |
| 1,000 products | 48 | failed at 60 s | **5.0 s** | 19,565 → 1,059 |
| 100 products | 100 | failed at 60 s | **2.4 s** | 14,667 → 156 |
| 476 products | 476 | (not run) | **6.0 s** | → 532 |

Every save read back 100% of its values. The drain rebuilt 10 pending families in 33.7 s and left 0 pending.

**Still one statement per product: the product-list cache.** `productReadCacheService.refreshMany` (after commit) reads
in batches but writes one `INSERT … ON CONFLICT` per product. It belongs to the product list, not to attributes, so it is
left as it is and reported as a follow-up.

**Tests**

- New: `readiness-pending.vitest.test.ts` (6), `bulk-edit-set-based.vitest.test.ts` (4 — the old per-product SQL is kept
  in the test as the reference, and both must store identical rows), 7 planted mistakes, all caught.
- The 10 test files that faked the readiness module now use `test-support/readiness-module-mock.ts`, which keeps their
  per-product assertions true.
- Wide run (`services/pim`, `services/products`, `jobs`, `routes/products*`): 2,511 passed, 3 failed. The 3 fail the same
  way on a clean `main` checkout against the same database (live-catalogue tests reading 10,000 cloned products;
  `variation-quality` asserts the database is named `nexus_development`). Not caused by this change.
- `price-door-concurrency` (needs a real multi-connection Postgres) run for real: 11/11.
- **Race found and fixed (real Postgres only).** New `readiness-pending-race.vitest.test.ts` forces a bulk edit's
  pending mark and a family rebuild to overlap, in both orders (a third connection holds the rows until both are
  blocked). First run: **deadlock** — the mark's UPDATE and the rebuild's DELETE took the rows in different orders, and
  PostgreSQL killed one; when the victim is the bulk edit, the user's save fails. Fix: `inDatabaseTransaction` now also
  retries a conflict raised by raw SQL (`P2010` with SQLSTATE 40001/40P01) and a deadlock victim, not only Prisma's
  `P2034` — a lost race is rolled back whole, so running it again is safe. The pending mark locks rows in `id` order
  (two bulk edits queue instead of deadlocking). An ordered lock on the rebuild side was tried and DROPPED: the race
  test passes without it (the retry recovers), and it needed raw SQL that the import tests' in-memory store cannot run
  (it turned 7 import tests red). Result, both orders, 3 runs: the end state is either PENDING or rebuilt from the
  edit's data — never "current" with old data. Planted mistake: running the rebuild without Serializable isolation is
  caught (it shows old data as current). Added to `scripts/run-real-postgres-tests.mjs` (the push hook's real-server
  list); full runner: every suite passes.

### 10.3 P3 — dictionary (built, tested, not pushed)

- ✅ `resolveEffectiveAttributesMany`: one query per family-hierarchy level, not per family per ancestor. Used by the
  sheet's family fields. Equality test against the single resolver + query count (3 levels = 3 queries).
- ✅ `POST /products/family-completeness/bulk` and `POST /products/channel-readiness/bulk` use new `computeMany`
  functions with a fixed query count. Equality tests against `compute` (family path, fallback path, missing product);
  2 planted mistakes caught.
- ✅ **Concept catalogue** `packages/shared/attribute-concepts.ts` (`@nexus/shared/attribute-concepts`): 35 concepts
  (12 are master fields already, 23 become business attributes), each with Amazon / eBay (EN, IT, DE, FR, ES) /
  Shopify / Etsy field names and value synonyms. 19 tests: unique keys, no channel field name claimed by two concepts,
  no spelling standing for two values, lookups on the localized eBay keys measured in stored listings.
- ✅ **Schema** (migration `20260926b_attr_concepts`, additive): `CustomAttribute.semanticKey` + unique per business;
  `AttributeOption.synonyms`, `AttributeOption.archivedAt`. `scoped-keys.json` knows the new unique key.
- ✅ **A new business starts with the dictionary**: `workspace.service.ts` creates it in the same transaction as the
  markets (the A-53 pattern). Rows come from `attribute-concepts-rows.ts` (pure).
- ✅ **An existing business adopts the concepts**: `GET /api/attributes/concepts` (catalogue + plan),
  `POST /api/attributes/concepts/apply` (dry run unless `dryRun: false`). Adopting only sets `semanticKey`; it never
  changes a code, type, option or value. A clash is reported as `blocked` with the reason, never guessed.
- ✅ **Bulk dictionary**: `POST /api/attributes/bulk` — up to 500 attributes and their options, all-or-nothing, every
  wrong row named. `validation` must satisfy the P1 contract (also on the single create/patch routes). Options get
  `synonyms` and `archived` (retire without breaking saved values).
- ✅ **Tenant tests** on PostgreSQL with the real policies: each business sees only its own dictionary; a foreign
  attribute cannot be read, changed or given an option; two businesses may each link the same concept.
- Tests: `attribute-concepts.vitest.test.ts` (9, real business creation), 4 planted mistakes caught. The 3 older tests
  that faked the family service use `test-support/family-service-mock.ts`.
- **Not applied to the Owner's business.** `POST /api/attributes/concepts/apply` with `dryRun: false` is a write to
  production data; it waits for the Owner's word. Read-only preview on the copy of the Owner's data
  (`tools/concept-plan.mts`): **22 of 23 concepts adopt an attribute the business already has** (e.g. `fit` ← `fit_type`,
  `season` ← `seasons`, `certification` ← `ceCertification`), 1 would be created (`occasion`), 0 blocked.

### 10.4 P4 — channel rules (built, tested, not pushed)

- ✅ **Refresh job: all three per-category channels, on by default.** `jobs/schema-refresh.job.ts` refreshes every
  Amazon product type, eBay leaf category and Etsy taxonomy node a business uses, daily at 04:00 UTC.
  🔴 **Behaviour change on deploy:** it was dormant unless `NEXUS_ENABLE_SCHEMA_REFRESH_CRON=1`; now it runs unless
  `NEXUS_ENABLE_SCHEMA_REFRESH_CRON=0`. It uses the same provider calls an operator's "refresh requirements" makes,
  throttled 300 ms apart. Shopify store definitions keep their own refresh path.
- ✅ **eBay and Etsy get a change log.** `channel-specs/spec-diff.ts` compares the adapter output of the old and new
  version (fields added/removed, requirement flips, options removed from a strict list) — the one reader per channel.
  Amazon keeps its existing detector (with deprecation awareness).
- ✅ **A rule change reaches the products.** `schema-change-impact.service.ts` finds exactly the products whose
  effective category (listing pin first, then the mapped category — the sheet's own resolution) is the changed one,
  a fixed number of queries per 2,000 products. Their families' readiness for that channel × market is marked pending
  (P2 drain rebuilds it) and `SchemaChange.affectedProducts` is filled (it was always empty). It never fails the
  refresh.
- ✅ **Shopify option lists.** A metafield definition's `choices` become a strict option list; `list.min`/`list.max`
  bound the list (they were enforced on write but never offered).
- ✅ **Conformance for Shopify and Etsy** (the audit found `unrecognised: []` hard-coded): every declared definition /
  property is exactly one field set, with a planted extra declaration as the positive control.
- ⏭ **Not needed now: a stored compiled spec.** The cold column build measured 191 ms (P0) and the Shopify cold-cache
  loss was already fixed on 2026-09-24 (stored copy read after a restart). Revisit only if a measurement asks for it.
- 🔓 **Open — eBay bulk aspects** (`fetch_item_aspects`, every category in one file). Needs a working eBay credential
  to verify; the local eBay credential blob does not decrypt (known since 2026-09-05). Not built blind.
- 🔓 **Open — the other schema walkers** (`schema-to-fields.ts`, `schema-sync-bridge.ts`, `variation-theme-segments.ts`,
  image slots, matrix SQL, and the flat-file / wizard ones in other lanes). Moving each onto the adapter needs its own
  parity test; not started.
- Tests: `schema-change-impact.vitest.test.ts` (4), `conformance-store.vitest.test.ts` (4), updated
  `schema-refresh.vitest.test.ts` (5); 4 planted mistakes caught. The 20 files that use the schema service pass.

### 10.5 P5 — links and value maps (built, tested, not pushed)

- ✅ **Concept links.** `masterDefaultRule` (the rule a channel field gets when nobody wrote one) keeps every
  existing link's source. When nothing links a field, the concept catalogue may: `aspect_Colore`, Amazon `department`,
  a text Shopify metafield `shopify.color-pattern` inherit the business attribute linked to that concept
  (`semanticKey`), or the master field the concept already is. Measures and non-text Shopify fields (metaobject
  references) are never linked by concept. The field catalogue passes the business's links; the batch resolver uses
  the catalogue's rule, so sheet cells, previews and publishing see the same link.
- ✅ **Value maps on strict lists.** Any automatic link into a STRICT channel list reads the value maps (`valueMap`,
  miss = keep). With no row, nothing changes; with a row, one row maps a value for every product.
- ✅ **Auto-match** `POST /api/pim/value-maps/auto-match` (dry run unless `dryRun: false`): for each such field, the
  business's stored values (the attribute and a variation axis of the same concept) are matched to the channel's
  options — same text ignoring case/accents (`RED` → `Red`), then the concept synonyms (`Nero` → `Black`,
  `blu` → `Blue`, `Uomo` → `mens`). A match becomes a `FieldValueMap` row (`AUTO_EXACT` / `AUTO_SYNONYM`); what nothing
  matches is RETURNED as the list to map by hand, never guessed. The matcher (`matchConceptValue`) is in
  `@nexus/shared/attribute-concepts`, so the web can use it for suggestions.
- 📏 **Measured on the copy of the Owner's data (dry run):** nothing to do today for eBay IT 177104 and Amazon IT
  OUTERWEAR. eBay's colour, size and material aspects there are OPEN lists (eBay accepts any value), and the one strict
  Amazon list that matters (`target_gender`) already has the Owner's own mapping rule, which wins over the default.
  The value maps matter where a strict list has no hand-written rule (Etsy properties, Shopify `choices`, other
  categories).
- Tests: `value-map-auto.vitest.test.ts` (6, a real cached eBay category with a localized key), 3 more in the shared
  catalogue tests; 3 planted mistakes caught. The 41 mapping test files pass.

### 10.6 P6 — the open dropdown, API side (built, tested, not pushed)

- ✅ **One save rule for attribute cells** (`bulk-edit.service.ts` `factsOf`): an off-list value is refused only when
  the BUSINESS made the attribute strict (`validation.optionMode: 'strict'`). A channel's closed list never blocks the
  save — the value is stored, the channel validator flags it, and that listing's publish stays held until it is mapped
  or changed. Shape errors (text in a number, an unknown unit, a list into a single value) and character caps still
  refuse. The channel-write check (`information-validation.ts`) skips the off-list finding through one named
  predicate, `isOffListError`, pinned against the REAL messages of all three validators (ours, Ajv `enum`, Shopify
  `choices`).
  🔴 **Behaviour change:** before, the save refused a value off a channel's closed list (e.g. an Amazon enum), and a
  business `select` refused an off-list value by default. Both now save (Owner's words: "write anything of my choice").
  Three existing tests pinned the old rule; they now pin the new one (`paste-validity.vitest.test.ts` ×2,
  `information-database.vitest.test.ts` ×1 — the value is saved, the eBay cell flags it, the sibling alias is
  untouched), and `save-rule.vitest.test.ts` pins the business-strict half.
- ✅ **Suggestions on text attributes.** `select`, `multiselect`, `text` and `textarea` may carry options; on a text
  attribute they are suggestions (the column stays text, the list stays open).
- ✅ **Retired options** are no longer offered on the sheet; their labels stay, so a value saved with one still reads
  well.
- ✅ **`GET /api/attributes/:code/choices?coordinates=EBAY:IT:177104,AMAZON:IT:OUTERWEAR`** — the business's options
  and each channel's values, merged ignoring case/accents, each with `sources` (`business`, `EBAY IT`, …) and
  `strictIn` (the channels that accept only their own list); `unavailable` names a coordinate it could not read.
- 🔓 **Open (PLAN §4.5):** a master `attr_*` write still needs a market context (`marketplaceContexts`), because the
  write contract is built per market. Removing that is part of P8.
- Tests: `save-rule.vitest.test.ts` (3), `off-list-error.vitest.test.ts` (2), `attribute-choices.vitest.test.ts` (3),
  2 updated in `paste-validity.vitest.test.ts`; 6 planted mistakes caught. Attribute, family and save tests: 15 files,
  111 tests pass.

## 11. For the product-sheet session (the screens are theirs)

The API below is built on `feat/attributes` (not pushed). Nothing in `apps/web` or the design system was touched.

| What the screen needs | API | Notes |
|---|---|---|
| Show "checking…" instead of an old readiness verdict | `ScopeReadiness.pendingSince`, `byProduct[id].pendingSince`, `ListingReadinessRow.pendingSince` (optional ISO strings) | Present = the verdict is the previous one; a rebuild is queued. Absent = current. |
| Tell the user a big save left readiness to catch up | `PATCH /api/products/bulk` → `readinessPendingFamilies` (only when > 0) | Up to 2 families are still rebuilt inside the save, as before. |
| The open dropdown (3 labelled sources) | `GET /api/attributes/:code/choices?coordinates=…` | `choices[].sources`, `choices[].strictIn`, `attribute.optionMode`. |
| "Save ‘X’ as a new option" | `POST /api/attributes/:attrId/options` or `POST /api/attributes/bulk` | Now allowed on text attributes too (suggestions). |
| "Map ‘Nero’ → Black for eBay IT" (fix once, fix all) | `PUT /api/pim/value-maps` `{ channel, marketplace, attribute, fromValue, toValue }` | Applies to every product whose automatic link reads the value maps. |
| "Match my values automatically" | `POST /api/pim/value-maps/auto-match` `{ channel, marketplace, productType, dryRun }` | Returns matched + `unmatched` (the list to map by hand). |
| Save any value in an attribute cell | unchanged `PATCH /api/products/bulk` | Off a channel's closed list: saved, then flagged (`… contains an unaccepted value`) in readiness/preview. Off a business-strict list: refused, named per row. |
| The dictionary at scale | `POST /api/attributes/bulk`, `GET /api/attributes/concepts`, `POST /api/attributes/concepts/apply` | All-or-nothing with per-row errors; apply is a dry run unless `dryRun: false`. |

