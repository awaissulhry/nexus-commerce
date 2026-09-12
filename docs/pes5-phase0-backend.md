# PES.5 Phase 0 — backend: aliases, sheet reads, readiness, history

**Lane:** PES.5 (backend). **Date:** 2026-09-01. **Status:** STUDY COMPLETE — awaiting Owner approval.
**Nothing implemented, nothing committed.** Evidence scripts (untracked, read-only):
`apps/api/scripts/_pes5-inventory.mts`, `_pes5-shells.mts`, `_pes5-aliases2.mts`.

Every number below was measured against the production database on 2026-09-01, not inferred.

---

## §0 The five findings that change the plan

The lane prompt and layout spec §3 carry four assumptions that the code and data do not support.
Each is stated here with its evidence, because three of them change what gets built.

### F1 — `VariantChannelListing` is a dead axis. The alias discriminator must NOT go there.

The prompt says the discriminator goes on "`ChannelListing` **+ `VariantChannelListing`**".
Measured:

| table | rows |
|---|---|
| `ChannelListing` | **977** |
| `VariantChannelListing` | **0** |
| `ProductVariation` | **0** |

`VariantChannelListing.variantId` is a FK to `ProductVariation`, which is itself empty. Per-variant
channel data does **not** ride that model — it rides `ChannelListing` keyed by the **child `Product`
id**:

| `ChannelListing` rows by product kind | count |
|---|---|
| child `Product` (`parentId` not null) | **912** |
| parent / standalone | 65 |

This matches layout §1 ("children are full `Product` rows"). `product-channel-data.routes.ts:175`
confirms it in code — it passes a variant id as `productId`.

→ **The alias change touches `ChannelListing` only.** Adding a column to `VariantChannelListing`
would be schema on a corpse; it also drags `VariantChannelListing_variantId_channelId_key`, a
2-column unique with no `NULLS NOT DISTINCT`, into the sweep for nothing.

### F2 — Aliases already exist in production, as a workaround. 22 of them.

`Product.productType = 'EBAY_LISTING_SHELL'` — **22 rows**, every one:
`isParent: true`, `parentId: null`, **0 children**, `basePrice: 0`, and exactly **one** `EBAY:IT`
`ChannelListing` carrying its own real eBay ItemID.

```
GALE-JACKET-ALT1   EBAY:IT  ACTIVE  256566101420
GALE-JACKET-ALT2   EBAY:IT  ACTIVE  256566102729
GALE-JACKET-ALT3   EBAY:IT  ACTIVE  256566103703
AIREON-ALT1/2/3    EBAY:IT  DRAFT   2576291381{22,252,421}
xavia-knee-slider-ALT1..ALT5                    … 22 total
```

These are listing aliases ②③④ for GALE / AIREON / MOSS / VENTRA / knee-slider — created as
**phantom parent products** because the schema had nowhere else to put them. They have **no link
back to their master**: `parentId` is null and nothing else references the real product. They are
counted as 22 products in every catalogue total today.

→ The alias entity is not new behaviour. It is the **legitimisation of an existing workaround**, and
the migration has 22 real rows to adopt. Absorbing them is a data change, so it is proposed
separately in §2.4 and **asks before running**.

### F3 — per-cell history is recorded, but without the *who* and the *old value*.

Layout §1 promises the drawer "per-cell history (who/when/old→new/which layer, from the
override-audit table)". Measured, field by field:

- `ChannelListingOverride` — the table the layout names — has **0 rows**. Its only two writers in
  the whole API are `pricing.routes.ts:1285` and `pricing-outbound.service.ts:181`: **price only**.
- `PATCH /api/products/bulk` *does* keep a trail, via `auditLogService.writeMany` in
  `products.routes.ts` (grep the call — the line moves) — one `AuditLog` row per (product, field), `metadata.source='bulk-patch'`.
  **27** such rows exist, spanning 2026-05-06 → 2026-08-29 (44 `Product`/`update` rows in total).

So the trail is real. What it captures, measured on those rows:

| the drawer needs | recorded today? |
|---|---|
| **when** | ✅ `createdAt` (+ `ip` on 27 rows) |
| the **new** value | ✅ `after: {field, value}` |
| **old→new** | ❌ `before` is written as JSON-null — `audit-log.service.ts:43` passes it through, and the bulk PATCH never supplies one |
| **who** | ❌ `userId` is hardcoded `null` at `products.routes.ts:2216`; all 27 bulk-patch rows have no user |
| **which layer** | ❌ no channel / marketplace / alias / locale in the row, so a channel-layer edit is indistinguishable from a master one |

→ Two of the four promised columns are unavailable, and a history panel showing a *new* value with
no previous value and no author is worse than none. The fix is small — **enrich the existing write**,
not a new table (§4) — but it is a write-side change, and it is the one piece of PES.5 that cannot
be delivered read-only.

### F4 — readiness has two independent validator implementations that disagree.

The prompt says compute readiness "from channel schema caps + the pure listing-preflight
validators". Measured: **nothing in `services/pim/` imports `listing-preflight.service.ts`.**
The sheet's `computeReadiness()` (`sheet-rows.service.ts:186`) is a second, inline implementation.

What the sheet's version checks: required-blank, `maxBytes`, `maxLength`, closed-list membership,
deprecated options.
What `listing-preflight.service.ts` also has, and the sheet does **not**:

| validator | consequence of omission |
|---|---|
| `checkGpsrCompliance` + `GPSR_EU_MARKETPLACES` | **IT, DE, FR, ES, BE, NL, SE, PL** — a GPSR-incomplete product reads "ready" in the sheet and is refused by Amazon |
| `validateGtin` (mod-10) | a malformed EAN passes readiness, fails at submit |
| `checkRequiredWithParent` (sub-required groups) | conditionally-required fields never counted |
| `checkNonEditableChanges` | edits to locked fields not flagged |

Nine of the twenty active `Marketplace` rows are GPSR marketplaces, so this is not a corner case.

→ Readiness must **delegate to the preflight validators**, not re-implement them, or the scope chips
will confidently report a percentage the publish path disagrees with.

### F5 — one call site is already `as any`-cast past the MAP.2b sweep, and the compiler cannot see it.

`flat-file-unified.routes.ts:631`:

```ts
where: {
  productId_channel_marketplace: { productId: rowId, channel: 'SHOPIFY', marketplace: 'GLOBAL' },
} as any,        // ← channelConnectionId is MISSING; the cast hides it
```

MAP.2b added `channelConnectionId` to that compound unique. Every other call site was updated; this
one was cast instead. It is unexercised — there are **0 SHOPIFY rows** in `ChannelListing`
(AMAZON 725, EBAY 252) — so it has never had to work.

→ When the unique gains the alias field, the compiler will force all 15 honest call sites and will
**silently skip this one**. It must be fixed by hand and named in the verification, or it becomes a
runtime `42P10` the day someone connects Shopify. (`reference_ast_guard_misses_cast_literal`.)

---

## §1 Verified inventory — what exists TODAY

### 1.1 Data model (`packages/database/prisma/schema.prisma`)

| model | line | relevant shape | rows |
|---|---|---|---|
| `Product` | 83 | self-relation `ProductHierarchy` (`parentId`/`children`), `isParent`, `variationAxes[]`, `categoryAttributes` JSONB, `localizedContent` JSONB, `version` | 338 (36 parents / 301 children) |
| `ChannelListing` | 1423 | `channel`+`marketplace`+`channelMarket`, `overrideData` JSONB, 6 × `followMaster*`, 5 × `*Override` columns, `flatFileSnapshot`, `version`, `channelConnectionId` | 977 |
| `VariantChannelListing` | 1365 | FK → `ProductVariation` | **0** |
| `ProductVariation` | 1231 | legacy child model | **0** |
| `ChannelListingOverride` | 1721 | `fieldName`/`previousValue`/`newValue`/`changedBy` — the audit trail | **0** |
| `ChannelListingImage` | 2098 | FK → `ChannelListing` (inherits alias identity for free) | 0 |
| `Marketplace` | 1670 | `(channel, code)` unique, `language` → content locale | 20 (19 active) |
| `FieldLinkGroup` | ~1770 | `members` JSONB `[{channel, marketplace, variantId?}]`, `translatePolicy` | 1 |
| `SharedListingMembership` | 15677 | `(marketplace, itemId, sku)` unique — the eBay shared-listing lane | 712 rows / 31 itemIds |
| `AuditLog` | 7407 | generic `entityType`/`entityId`/`before`/`after` | — |

**Live unique indexes on `ChannelListing`** (measured from `pg_indexes`, PostgreSQL **17.11**):

```
ChannelListing_productId_channelMarket_conn_key
  (productId, channelMarket, channelConnectionId)            NULLS NOT DISTINCT
ChannelListing_productId_channel_marketplace_conn_key
  (productId, channel, marketplace, channelConnectionId)     NULLS NOT DISTINCT
```

`max(rows per (productId, channel, marketplace, channelConnectionId))` = **1**. The unique is
exactly what makes N aliases impossible today, and both indexes must widen — extending only the
modern key leaves the legacy `channelMarket` key still enforcing one listing per product per market.

`SharedListingMembership` has 31 distinct `itemId` and 31 distinct `parentSku` — **1:1**, so it does
not express aliases today either; it is the per-variant membership of a single eBay listing.

### 1.2 Services and routes that exist today

| file | what it gives PES.5 |
|---|---|
| `routes/products-sheet.routes.ts` (133 ln) | MS.1/MS.2/MS.5 — `GET /products/sheet/columns`, `GET /products/sheet`, `POST /products/sheet/publish-preview`. Mounted `prefix:'/api'` at `index.ts:745`. 5-min `TtlCache` on columns. |
| `services/pim/sheet-columns.service.ts` (527 ln) | `getSheetColumns({market, productTypes, variationAxes, channels, includeEmptyChannels})` → `{columns, coordinates, locale, droppedKeys, schemaMissing, schemaAge, availableMarkets}`. `coordinatesFor()` builds the coordinate LIST from `Marketplace` rows. `UnknownMarketError`. |
| `services/pim/sheet-rows.service.ts` (433 ln) | `getSheetRows()` — **3 queries then pure work**. Already returns per-cell `{value, source, inheritedFrom, inherited}`, per-coordinate `listings` + `readiness`, and `completeness`. Supports `parentIds[]` (= family scoping) and `ids[]`. |
| `services/pim/attribute-resolver.ts` (330 ln) | `resolveAttributes({product, parent, channelListing?, locale})` → per-key `{value, source, inheritedFrom}`. `ValueSource` = master · masterLocale · masterColumn · variant · variantLocale · channelOverride · channelExplicit · default. **No alias layer, no link-group layer.** |
| `services/pim/resolve-channel-field.ts` | `resolveChannelField()` + `linkForCoordinate()` — pure, and this *is* the `pinned → linked → master → default` cascade the layout describes. Used only by `payload-preview.ts` + `field-links.routes.ts`. |
| `services/listing-preflight.service.ts` | the pure validators: `preflightRow`, `findMissingRequired`, `checkLengthLimits`, `checkEnumValues`, `checkDeprecatedValues`, `checkRequiredWithParent`, `checkGpsrCompliance`, `validateGtin`, `buildPerTypeValidation`. **Unused by the sheet.** |
| `services/pim/schema-caps.ts` | `extractSchemaCaps`, `mergeSchemaCaps` → `MergedCaps`. |
| `services/pim/master-completeness.service.ts` | `computeMasterCompleteness()` — the one completeness definition. |
| `lib/auth/permissions-manifest.ts:395` | `RW(F.productsView, F.productsEdit, pfx('/api/products'))` — **any** new route under `/api/products` inherits products:view on GET / products:edit on writes. No RBAC work needed if I stay under that prefix. |

**The substrate is in good shape.** `getSheetRows` already does family scoping (`parentIds`),
per-cell provenance, and batched pure readiness. PES.5 is mostly *extension*, not new machinery —
with the four exceptions in §0.

---

## §2 Migration design — the alias entity

### 2.1 Shape: slim parent table + nullable FK discriminator

A bare discriminator column on `ChannelListing` was rejected: an alias needs operator-facing
identity (label ①②③, name, ordering, its own listing status), and on a 41-child family that
identity would be duplicated across 41 rows and drift. The layout's UI is a *collapsible group per
alias with a header* — that header is a row in a table.

```prisma
/// PES.5 — one operator-facing listing alias: an Nth listing of the same product
/// on one channel × marketplace × account. Absent alias (aliasId NULL on the
/// ChannelListing) = the product's primary listing, which is every row today.
model ProductListingAlias {
  id        String  @id @default(cuid())
  product   Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  productId String              // the FAMILY ROOT product, never a child

  channel             String
  marketplace         String
  channelConnection   ChannelConnection? @relation(fields: [channelConnectionId], references: [id], onDelete: SetNull)
  channelConnectionId String?

  label    String              // operator-facing: "Bundle listing", "Summer title test"
  position Int     @default(1) // ①②③ order in the sheet
  status   String  @default("ACTIVE")  // ACTIVE | ARCHIVED

  /// Set when this alias was adopted from an EBAY_LISTING_SHELL product (F2),
  /// so the adoption is reversible and auditable.
  adoptedFromProductId String?

  listings  ChannelListing[]
  createdAt DateTime @default(now())
  createdBy String?
  updatedAt DateTime @updatedAt

  @@unique([productId, channel, marketplace, channelConnectionId, position], map: "ProductListingAlias_coord_position_key")
  @@index([productId])
  @@index([channel, marketplace])
}
```

On `ChannelListing`, **one nullable FK**:

```prisma
  alias   ProductListingAlias? @relation(fields: [aliasId], references: [id], onDelete: Cascade)
  aliasId String?              // NULL = the primary listing
```

and both uniques gain it, **keeping the Prisma `name:` verbatim** so no call site's key name churns
(the MAP.2b trick):

```prisma
@@unique([productId, channelMarket, channelConnectionId, aliasId],
         name: "productId_channelMarket",
         map: "ChannelListing_productId_channelMarket_alias_key")
@@unique([productId, channel, marketplace, channelConnectionId, aliasId],
         name: "productId_channel_marketplace",
         map: "ChannelListing_productId_channel_marketplace_alias_key")
```

**Why nullable, not `NOT NULL DEFAULT 'primary'`:** the two indexes are already
`NULLS NOT DISTINCT` on PostgreSQL 17.11, so NULL collides with NULL. All 977 existing rows keep
colliding exactly as they do today with **zero backfill and zero data change**. A `NOT NULL`
discriminator would need a backfill of every row plus a synthetic primary-alias row per coordinate —
977 writes to buy nothing.

### 2.2 The migration is additive and rolling-deploy safe

Following `20260819b_map2b_account_unique_keys` exactly — including its hard-won lesson that
dropping the old index in the same migration breaks the old container during a rolling deploy with
`42P10`:

```sql
-- migration 1 (this lane): ADDITIVE ONLY. Old indexes are NOT dropped.
CREATE TABLE "ProductListingAlias" (…);
ALTER TABLE "ChannelListing" ADD COLUMN "aliasId" TEXT;
ALTER TABLE "ChannelListing" ADD CONSTRAINT … FOREIGN KEY ("aliasId") … ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channelMarket_alias_key"
  ON "ChannelListing" ("productId","channelMarket","channelConnectionId","aliasId") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channel_marketplace_alias_key"
  ON "ChannelListing" ("productId","channel","marketplace","channelConnectionId","aliasId") NULLS NOT DISTINCT;
-- old 4-column indexes stay for one release; a separate PES.5-ii drops them.
```

⚠ **While the old indexes stand, a second alias row still violates them.** So alias *creation*
cannot be enabled until PES.5-ii lands. Sequencing is in §6.

Rollback: `rollback.sql` beside the migration, dropping the new indexes, the FK, the column and the
table — reversible because nothing is backfilled.

### 2.3 The upsert sweep — 16 sites, 1 invisible

`ON CONFLICT` must name the index columns exactly, so every compound-unique `where` gains `aliasId`.
The complete list, verified by grep:

| # | file:line | key |
|---|---|---|
| 1–2 | `routes/amazon.routes.ts:1252, 1439` | `productId_channelMarket` |
| 3–6 | `routes/products.routes.ts:1785, 3414, 3587, 3674` | `productId_channel_marketplace` |
| 7 | `routes/flat-file-unified.routes.ts:631` | **`as any` — compiler blind (F5)** |
| 8–9 | `routes/marketplaces.routes.ts:268, 368` | |
| 10–12 | `routes/product-channel-data.routes.ts:175, 406, 415` | |
| 13 | `services/listing-reconciliation.service.ts:504` | |
| 14 | `services/pricing-engine.service.ts:241` | |
| 15–16 | `services/listing-wizard/submission.service.ts:1445, 1486` | |

All 16 take `aliasId: null` — every existing writer addresses the **primary** listing, which is the
correct and unchanged meaning. Site 7 additionally gets its missing `channelConnectionId` and
**loses its `as any`**, so the compiler covers it from then on.

`services/listing-reconciliation.service.ts:543` uses `variantId_channel_marketplace` on
`VariantChannelListing` — **not touched** (F1).

Verification that the sweep is complete, rather than assumed: after the schema edit, `tsc` must be
clean **and** a grep must show zero `as any` within three lines of any compound-unique key. A
green `tsc` alone would have passed MAP.2b's bug straight through.

### 2.4 Adopting the 22 shell products — proposed, asks before running

Additive schema is pre-approved; **this is a data change and is not**. Proposed as a separate,
reversible, dry-run-first backfill script (not a migration):

for each `EBAY_LISTING_SHELL` product, match it to its master by SKU stem
(`GALE-JACKET-ALT1` → `GALE-JACKET`), create a `ProductListingAlias` on the master
(`adoptedFromProductId` = the shell), and repoint the shell's single `ChannelListing` at the master
product + the new alias. The shell `Product` is then **soft-deleted, never hard-deleted**, so the
whole adoption reverses.

`IT-GALE-JACKET` has no `-ALT` suffix and will not match a stem — it is reported, not guessed.
Nothing runs without the dry-run output being read first, and it needs its own approval.

**Until it runs, nothing breaks:** the shells keep working exactly as they do now.

---

## §3 API contracts for PES.2 / PES.3 / PES.4

All under `/api/products/…`, so RBAC is inherited (`permissions-manifest.ts:395`) — GET =
products:view, POST/PATCH = products:edit. New file `routes/product-studio.routes.ts`; the existing
`products-sheet.routes.ts` is **not modified** (it serves the catalogue-wide master sheet and
MS.1/2/5 contracts stay byte-identical).

### 3.1 `GET /api/products/:id/studio/columns` — PES.2, PES.3

```
?market=IT  &channel=EBAY  &locale=it
```

Reads exactly these three; `scope` is inferred (`channel` present → channel scope, absent → master).
Family-narrowed `getSheetColumns` (only the family's own `productType`s and `variationAxes`).
For `scope=channel` it passes `channels:[channel]`, so `maxLength`/`maxBytes`/`capFrom` are **that
channel's caps**, not the tightest across all coordinates.

```jsonc
{ "scope": {...}, "columns": [SheetColumn], "coordinates": [SheetCoordinate],
  "locale": "it", "views": [{ "id":"pricing", "label":"Pricing", "columnKeys":[...] }],
  "schemaMissing": [], "schemaAge": [], "droppedKeys": [] }
```

### 3.2 `GET /api/products/:id/studio/sheet` — PES.2 (master), PES.3 (channel)

```
?market=IT  &scope=master|channel  &channel=EBAY  &locale=it
```

⚠ `&view=` is **not implemented** and is ignored if sent — the route reads only `market`, `scope`,
`channel` and `locale`. Views are a client-side column selection persisted through `useGridState` →
`SavedView` (layout §1 Views); the server returns the full column set and the client narrows it.
(Listed here because an earlier draft of this doc showed `&view=` as if the server honoured it.)

`:id` may be a parent or a child; the service resolves to the **family root** and returns the whole
family (parent + children), reusing `getSheetRows`'s existing `parentIds` path. No paging: a family
is one page by definition.

⚠ **The query param is `market`, not `marketplace`** (corrected 2026-09-01 — this doc said
`&marketplace=` and the route has always read `market`; PES.3 hit the 400 against the live route).
Two things that ARE `marketplace` and are correct as they stand, so do not "fix" them:
- the **response**'s `scope.marketplace` — the resolved coordinate (`"IT"`), not the query param;
- `GET …/studio/history?marketplace=` — that route genuinely does read `marketplace` (§3.5),
  because there it filters recorded history rows by coordinate rather than selecting a market.

**AS-BUILT, verified against a live response** (`GALE-JACKET`, `scope=channel&channel=EBAY&market=IT`)
on 2026-09-01. The earlier version of this block was hand-written from the MS.2 `SheetRow` shape and
was WRONG in four ways that cost PES.2 a payload-reading session — every one of them is called out
below. Anything not shown here is not in the payload.

```jsonc
// TOP-LEVEL KEYS — exactly these six. There is NO top-level `readiness`
// and NO top-level `coordinates`. (Both were in the old text. Neither exists.)
{
  "scope":   { "kind": "channel", "channel": "EBAY", "marketplace": "IT",
               "label": "eBay · IT", "connectionId": null, "locale": "it" },
  "family":  { "id": "…", "sku": "GALE-JACKET", "name": "…",
               "productType": "OUTERWEAR", "variationAxes": ["Colore", "Taglia"] },
  "columns": [SheetColumn],
  "aliases": [AliasGroup],   // [] in master scope; in channel scope ALWAYS includes
                             // the primary group as { id: null, position: 0 }
  "rows":    [StudioRow],
  "meta": { "schemaMissing": [], "schemaAge": [], "droppedKeys": [],
            "availableMarkets": [], "tookMs": 0,
            "mapping": { … } | null }   // channel scope only — see §9.2
}
```

`StudioRow` — the FULL key list. ⚠ It is **not** "MS.2's `SheetRow` plus extras"; two fields are
deliberately DIFFERENT, because a studio row is one row in one scope, not a row across every
coordinate:

```jsonc
{ "id": "…", "sku": "…", "name": "…", "parentId": "…|null", "isParent": false,
  "rowKind": "parent|variant",
  "status": "ACTIVE", "productType": "OUTERWEAR", "version": 3,
  "basePrice": 129.9, "childCount": 20,
  "aliasId": "…|null",              // null = the primary listing / master scope
  "values": { "<columnKey>": StudioCellValue },

  // 🔴 SINGULAR, and null in master scope. MS.2's SheetRow has `listings`, a
  //    coordinate-keyed MAP. A studio row is already scoped to one coordinate.
  "listing": SheetListing | null,

  // 🔴 ONE verdict, not a coordinate-keyed map. Same reason.
  "readiness": { "state": "ready|missing|errors|live|unlisted",
                 "issues": [{ key, label, message, severity }], "ref": "…|undefined" },

  "completeness": { "overall": {…}, "required": {…}, "byGroup": [] }   // MA.4 shape
}
```

`StudioCellValue` — the FULL key list:

```jsonc
{ "value": "Xavia", "source": "masterColumn", "inheritedFrom": null, "inherited": false,

  // 🔴 Was missing from this doc entirely. Present on EVERY cell in channel
  //    scope (null in master scope, or when the resolver returned nothing).
  "mapped": { "value": …, "status": "mapped|unmapped", "provenance": "…|null",
              "appliedTransforms": [], "warnings": [], "errors": [],
              "autoCorrected": null, "requiredByRule": false, "overLimit": null },

  "layer": "master|variant|alias|channel|linked|default",   // NOT `aliasVariant` —
                                                            // that was never built
  "pinned": false,           // this layer stores its own value (the ✎ glyph)
  "follows": true|null,      // followMaster* for the SIX flagged fields; null otherwise
  "editable": true,
  "linkGroupId": "…|null",   // 🔗 when a FieldLinkGroup supplies it
  // 🔴 Where an edit LANDS. Derived from the TARGET layer, never from `layer`.
  //    A cell can read from master and still write to the channel.
  "writeTarget": "master|channelListing",
  "writeField": "ebay_title",   // ALREADY channel-prefixed when writeTarget is
                                // channelListing — the write endpoint routes by
                                // prefix, so the master name would land on master

  // 🔴 TRUE when a CHANNEL-scope cell writes to the MASTER record — editing it
  //    changes EVERY channel, not just this one. Not an edge case: measured on
  //    eBay·IT, 399 of 441 cells. Surface it before the operator commits.
  "affectsAllChannels": true,

  // False when the cell must not be written yet (currently: any non-primary
  // alias row — the write endpoint carries no aliasId).
  "writable": true,
  "writeBlockedReason": null
}
```

**⚠ The write endpoint can route only SIX field names to a ChannelListing** —
`{amazon,ebay}_{title,description,variationTheme}` (`CHANNEL_FIELD_MAP` in `products.routes.ts`).
Measured on `GALE-JACKET` / eBay·IT (441 cells): **42 route to the channel** (`name` and `item_name`
→ `ebay_title`), **399 land on master** and carry `affectsAllChannels: true`. A channel scope is
therefore mostly a VIEW of shared data with a few pinnable fields — not a fully independent layer,
and the UI must not imply otherwise.

⚠ Note the honest consequence: `basePrice` carries `follows: true` (the listing really does have
`followMasterPrice`) **and** `affectsAllChannels: true` — the operator can see the follow state but
cannot un-follow it here, because no `ebay_price` route exists. Do not render an un-pin affordance
on a cell whose `writeTarget` is `master`.

**History of this field, because it was wrong in a way that mattered:** the first version derived
`writeTarget` from `projection.id !== null`, which is FALSE for the primary listing — so all 441
channel cells reported `master` while three simultaneously reported `follows: true`. Both cannot be
right, and a pin routed by it would have silently edited the shared record. Found by PES.3's
authorized 409 rehearsal against the live contract; the rule is now the pure, exported
`resolveWriteRouting()` with 10 tests, four of them mutation-checked.

`AliasGroup` — the FULL key list:

```jsonc
{ "id": null, "label": "Primary", "position": 0, "status": "ACTIVE",
  "externalListingId": "257584954808", "listingStatus": "ACTIVE", "isPublished": false,
  "readiness": { "percent": 100|null, "state": "…", "errors": 0,
                 "warnings": 42, "rowsMissingRequired": 0 },
  "rowIds": ["…"] }
```

`layer` is what the layout's `🔗 / ✎` provenance glyphs render from. `writeField` + `writeTarget`
are handed to PES.2/3 so the grid never has to re-derive where a cell writes — the write path
itself is **unchanged** (`PATCH /api/products/bulk` with `expectedVersion`, 409 → repaint).

`AliasGroup`:

```jsonc
{ "id": "…", "label": "Bundle listing", "position": 2, "status": "ACTIVE",
  "externalListingId": "256566102729", "listingStatus": "ACTIVE", "isPublished": true,
  "readiness": { "percent": 71, "state": "missing", "errors": 2, "warnings": 3,
                 "rowsMissingRequired": 4 },
  "rowIds": ["…"] }
```

The **primary** listing is always `AliasGroup` `{ id: null, position: 0, label: "Primary" }`, so
PES.3 renders one uniform list of groups and never special-cases the un-aliased rows.

⚠ **Quantity is per alias, never summed.** Each alias group carries its own qty cell; the family
total is not the sum of its aliases (`reference_oversell_is_per_channel_not_summed`). The contract
carries no "total quantity" field precisely so no client can invent one.

### 3.3 `GET /api/products/:id/readiness?market=IT` — PES.1 scope bar

**PES.1 specified this one in `docs/pes-claims.md` and I am adopting their shape verbatim**, route
and all (not my earlier `/studio/readiness`), because they are the consumer and their honesty rule
is the right one:

Real response, measured on GALE-JACKET / IT (21 rows) — not an invented example:

```jsonc
{ "market": "IT",
  "scopes": [
    { "id": "master",  "pct": 71,   "required": { "filled": 105, "total": 147 }, "state": "warn" },
    { "id": "AMAZON",  "pct": 71,   "required": { "filled": 105, "total": 147 }, "state": "blocked" },
    { "id": "EBAY",    "pct": 100,  "required": { "filled": 21,  "total": 21  }, "state": "warn" },
    { "id": "SHOPIFY", "pct": null, "required": { "filled": 0,   "total": 0   }, "state": "absent",
      "note": "Shopify · GLOBAL declares no required fields for this product type" }
  ] }
```

147 = **7 hard-required columns × 21 rows** — the manifest's hard-required tier and nothing else.
Conditionals are counted only where triggered, and `minItems >= 1` (true of 109/109 properties) is
never read as a requirement signal (hub ruling #15.1). Master and Amazon coincide at 71% because
Amazon is the only channel on IT that declares required fields; eBay declares one per row and has
it, so it is genuinely 100%.

⚠ **This was wrong when first built.** The denominator used `requiredBy.length > 0` — "required by
ANY coordinate" — so master, Amazon AND eBay all reported an identical 71%. It now uses
`columnRequiredHere(col, coordinateLabel, productType)`, the same predicate the validators use.

**`pct: null` whenever it cannot be computed** — no cached schema for the product type, or the
channel is not connected — with the reason in `note`. The frame renders `—` and never derives a
percentage in the browser. The two cases that produce it are already reported by the substrate as
`schemaMissing[]` and an empty coordinate list, so this is honest by construction rather than by
convention.

⚠ **State-enum reconciliation.** PES.1 asked for `ready | warn | blocked | absent`; the shipped
`ReadinessState` in `sheet-rows.service.ts` is `ready | missing | errors | live | unlisted`. These
are different vocabularies for different things — per-row publish state vs per-scope aggregate. I
will **not** silently map one onto the other. The scope endpoint returns PES.1's four values and the
row payload keeps its five; §3.2's `AliasGroup.readiness.state` uses the row vocabulary because it
describes a listing. Named here so PES.1/2/3 do not each invent a mapping
(`reference_ds_option_list_two_copies` — one definition, exported once).

Cost: **one** `getSheetColumns` per coordinate (5-min cached already) + **one** product findMany +
**one** listing findMany for the family, then pure work — one call for the whole chip row, never one
call per chip (`project_master_sheet_gds4`).

### 3.4 Alias CRUD — PES.3

- `POST   /api/products/:id/aliases` → `{channel, marketplace, label?}` → creates the alias **and**
  its `ChannelListing` rows (family root + children) with no overrides, so it opens fully
  inheriting. Returns `AliasGroup`.
- `PATCH  /api/products/:id/aliases/:aliasId` → `{label?, position?}`.
- `DELETE /api/products/:id/aliases/:aliasId` → **archives** (`status='ARCHIVED'`), never deletes
  rows. A hard delete would drop a live eBay listing's local record; that asks first, separately.

### 3.5 `GET /api/products/:id/studio/history` — PES.4 drawer

```
?fieldKey= &scope= &channel= &marketplace= &aliasId= &rowId= &limit=50
```
```jsonc
{ "entries": [
    { "at":"…", "by":"awais@…", "layer":"alias", "fieldKey":"item_name",
      "previous":"…", "next":"…", "source":"manual|ai|sync|rule" } ],
  "coverageSince": "2026-09-XX|null" }
```

**`coverageSince` is the honesty field.** It is the timestamp from which per-cell history is
actually recorded; PES.4 must render "no history recorded before <date>" rather than an empty list
that reads as "never changed". Today it would be `null` for every cell — see §4.

---

## §4 History: the write-side change (F3)

The trail already exists and already writes one row per cell edit. It is missing three fields.
**No new table is needed** — that was my first read of this, before I found the
`auditLogService.writeMany` call in `products.routes.ts`.

**Proposed: enrich the existing `auditLogService.writeMany` call**, inside the transaction that
already computes the change set:

```ts
const auditRows = validated.map((c) => ({
  userId: request.user?.id ?? null,        // ← was hardcoded null
  ip: request.ip ?? null,
  entityType: 'Product',
  entityId: c.id,
  action: 'update',
  before: { field: c.field, value: priorValues.get(`${c.id}:${c.field}`) ?? null },  // ← was JSON-null
  after:  { field: c.field, value: c.value },
  metadata: {
    bulkOperationId: bulkOp.id, cascade: !!c.cascade, source: 'bulk-patch',
    channel: ctx?.channel ?? null, marketplace: ctx?.marketplace ?? null,   // ← the layer
    aliasId: ctx?.aliasId ?? null, locale: ctx?.locale ?? null,
  },
}))
```

**Where `before` comes from, and what it costs.** The handler does *not* already hold prior values:
its one pre-read (the `targetProducts` findMany in `products.routes.ts`) selects only
`{id, parentId, isParent}`. Capturing `before` means **widening that existing select** — no new
round-trip, but it does pull `categoryAttributes` and `localizedContent` for every touched product.
On a PES family autosave (≤50 rows, one cell) that is nothing; on a catalogue-wide bulk-op spanning
hundreds of products it is two JSONB bags per row.

So the capture is **gated to the single-product path** — `expectedVersion` / `If-Match` present,
which is exactly how the studio autosaves and is already a documented "all changes target the same
product id" mode (`products.routes.ts:986`). Multi-product bulk-ops keep today's behaviour and log
`before: null`, and `coverageSince` reports per-row which rows carry a previous value. The write
stays fire-and-forget (`void`), so autosave latency is unchanged. `AuditLog` is already indexed
`([entityType, entityId])` — exactly the history query's shape.

Everything else stays: `ChannelListingOverride` keeps its pricing role; the 27 existing rows remain
valid and simply have no `before`/`userId` — which is what `coverageSince` reports.

**This is the only part of PES.5 that changes a write path**, and it touches `products.routes.ts`,
which PES.5 does not exclusively own. The endpoint's contract is unchanged — same request, same
response, same 409 semantics; three fields on a log row are populated that are currently blank.
**Flagging it for explicit approval.**

If refused: the history API still ships, reporting *when* and the *new* value only, with
`coverageSince` and an explicit "author and previous value not recorded" state — honest, but thin
enough that PES.4 should probably not build the panel.

## §5 Readiness: one definition, batched (F4)

`computeReadiness()` stops re-implementing validation and **delegates** to
`listing-preflight.service.ts`. All of those functions are already pure and already take a plain
row + column descriptors, so they batch without change:

```
per market:  getSheetColumns()                    → cached 5 min, 1 call
per family:  product findMany + listing findMany   → 2 queries
per row:     resolveAttributes()                   → pure
per row × coordinate:
             findMissingRequired + checkLengthLimits + checkEnumValues
           + checkDeprecatedValues + checkRequiredWithParent
           + checkGpsrCompliance + validateGtin     → pure
```

Still 3 queries for a whole family across every scope. Scope % = required-filled / required-total
over applicable columns, reusing `computeMasterCompleteness` so there stays exactly **one**
completeness definition.

The GPSR gap (F4) is closed by this and is, on its own, a correctness fix for the nine EU
marketplaces regardless of PES.

**Refactor risk, stated plainly:** `computeReadiness` currently backs the MS.5 publish preview
(`sheet-publish.service.ts`) and the catalogue-wide master sheet. Delegating will change some
verdicts — that is the point (they are currently wrong) — but it is a behaviour change to a shipped
surface. It ships behind a characterisation test that pins today's output on real fixtures first, so
every diff is deliberate and reviewable rather than discovered later.

---

## §6 Sequencing

| step | gate |
|---|---|
| 1. Migration 1 (additive: table + column + wide indexes) | additive — pre-approved |
| 2. Sweep all 16 call sites + kill the `as any` (F5); `tsc` clean + grep guard | — |
| 3. Sheet reads: family scope, channel scope, provenance layers, alias grouping (aliases read as empty until step 6) | — |
| 4. Readiness delegation to preflight, behind characterisation tests | behaviour change to MS.5 — flagged |
| 5. History enrichment on the existing bulk-PATCH audit write | **needs approval (§4)** |
| 6. Migration 2 (PES.5-ii): drop the two old 4-column indexes | additive-safe, one release after step 1 |
| 7. Alias CRUD enabled (blocked until 6 — old indexes still forbid a 2nd row) | — |
| 8. Shell adoption backfill, dry-run first | **needs approval (§2.4)** |

PES.3's implementation unblocks at step 3 (read shape) and its alias writes at step 7.

---

## §7 Test plan

Per the lane rules — **tests must not share the code's assumptions**, and load-bearing rules get
mutation-tested (write the test, then break the source, confirm the test goes red).

| rule | test | mutation that must turn it red |
|---|---|---|
| A market is a coordinate **LIST** | fixture with AMAZON:IT + EBAY:IT + SHOPIFY:GLOBAL; assert 3 coordinates from a hand-written `Marketplace` list, never from `coordinatesFor` itself | make `coordinatesFor` return only the first match |
| Quantity is **per alias, never summed** | family with 3 aliases at qty 5/5/5; assert no field anywhere in the response equals 15 | add a `totalQuantity` sum to the payload |
| Alias uniqueness | insert 2 aliases at the same coordinate → OK; 2 rows at the same `(coord, aliasId)` → must violate | drop `aliasId` from the index |
| Existing rows keep colliding | two `aliasId: null` rows at one coordinate must still be rejected | change `NULLS NOT DISTINCT` to default |
| Readiness required-set | hand-written expected missing-list per fixture, literal — not computed by calling `findMissingRequired` | make `requiredHere` always return false |
| GPSR applies on IT/DE/FR/ES | GPSR-incomplete row on `IT` must be `errors`, on `US` must not | drop `checkGpsrCompliance` from the chain |
| Provenance layer | alias override → `layer:'alias'`; cleared → falls back to `master` with `pinned:false` | make the resolver return `pinned:true` always |
| Batching | one family × 3 coordinates issues **≤3** queries — asserted by counting real Prisma query events, not call-sites | add a per-row `findUnique` |

The batching test counts emitted queries via the Prisma event hook, because a call-count assertion
on a mock proves nothing about batching (`reference_call_count_test_cannot_prove_batching`).

---

## §8 Decisions needed before I implement

1. **Alias shape** — slim `ProductListingAlias` table + nullable `aliasId` FK on `ChannelListing`
   only, **not** on `VariantChannelListing` (F1). Recommended.
2. **History enrichment** (§4) — populate `userId`, `before`, and the channel/alias/locale
   coordinate on the `AuditLog` rows the bulk PATCH **already writes**. No new table, no extra
   query, contract unchanged. **Without it the drawer can show *when* and the *new* value, but
   never *who* or the *previous* value.**
3. **Readiness delegation** (§5) — changes some MS.5 publish-preview verdicts (they are currently
   missing GPSR and GTIN checks). Ships behind characterisation tests.
4. **Shell adoption** (§2.4) — 22 `EBAY_LISTING_SHELL` products become real aliases; dry-run first,
   shells soft-deleted, fully reversible. Separate approval, can come later.
5. **`flat-file-unified.routes.ts:631`** — I need to touch one line in a flat-file route to remove
   the `as any` and add the missing `channelConnectionId` (F5). Flat-file editors are marked
   untouchable, so I am asking rather than assuming: this is a two-field compile fix, no behaviour
   change.

---

## §9 Implementation status (2026-09-01, session nexus-commerce-1f)

Built and verified. **Nothing committed** — programme rule.

| Piece | State |
|---|---|
| Migration `20260901c_pes5_listing_aliases` | **APPLIED to prod.** Verified by querying `pg_indexes`/`information_schema`: both 5-column `NULLS NOT DISTINCT` uniques live, both old 4-column uniques still present as designed, 977 rows untouched, 0 non-null `aliasId`. |
| PES.5-ii (drop old indexes) | Written, parked in `prisma/migrations-pending/` so `migrate deploy` cannot drag it into the same release. Alias creation is inert until it lands, and `createAlias` refuses with a 409 that says exactly that. |
| Call-site sweep | 16/16. The compiler named 15; the 16th was the `as any` site predicted in F5 and was fixed by hand. `tsc` clean. |
| Readiness delegation | `readiness.service.ts` — one definition, delegating to `listing-preflight`. GPSR + GTIN mod-10 now fire; the sheet's deliberate closed-list-is-a-warning policy is preserved and documented. |
| Studio sheet reads | `GET /api/products/:id/studio/{columns,sheet,history}` + alias CRUD, `GET /api/products/:id/readiness`. Exercised against real data via `app.inject()`. |
| History | `previousRecorded` + `coverageSince` + `coverageNote` (hub #14). Bulk-PATCH audit write enriched with who / before / layer. |
| RBAC | `/api/products-ai` un-shadowed (was resolving to `products.edit` instead of `ai.run`); `/api/catalog-matrix` likewise, found by the new order-sensitivity test. |
| Shell adoption | Dry-run written and run: 20/22 match cleanly, **2 need an Owner decision** (§9.1). Refuses to apply while PES.5-ii is unlanded. |
| Tests | 5922 passing. `readiness.vitest.test.ts` (15) + `permissions-manifest-order.vitest.test.ts` (4) are new; six load-bearing rules are mutation-tested. |

### §9.1 Two shells need an Owner decision

The hub knew of one; the dry-run found a second.

| Shell | Problem |
|---|---|
| `IT-GALE-JACKET` | No `-ALTn` suffix, so there is no stem to match a master by. It is the only shell whose SKU does not say which product it duplicates. |
| `WATERPROOF-OVERJACKET-ALT1` | Correctly suffixed, but **no product with SKU `WATERPROOF-OVERJACKET` exists**. Its master is missing or renamed. |

Both are reported, never guessed. The other 20 adopt cleanly (all EBAY:IT, all qty 0; 6 ACTIVE, 14 DRAFT).

### §9.2 Mapping composition — CLOSED (hub #15.2 / #20.1)

`studio/sheet?scope=channel` now composes PES.6's `resolveChannelValues` **in-process**: one
payload, no second HTTP hop, and PES.2/3 must not fetch PES.6 alongside this read. Every
`StudioCellValue` carries `mapped: MappedCell | null` — `value` (what would ship), `status`,
`provenance`, `appliedTransforms`, `warnings`, `errors`, `autoCorrected`, `requiredByRule`,
`overLimit`. `meta.mapping` carries `categoryByProduct` verbatim, `missingProductIds`,
`productLevelOnly` and `skippedReason`.

`mapped.value` sits **beside** `value`, never replacing it. `value` is what is stored and resolved
through the master/variant/alias cascade; `mapped.value` is what the rules would send. The two
disagreeing is precisely what this surface exists to show.

`status` is never computed here — a constant/expression rule has an EMPTY `rule.source`, so
anything inferring mapped-ness locally under-counts. PES.6 decides; this service reports.

**Two defects found while integrating, both reported to PES.6:**
1. Importing the mapping barrel **blocks during module initialisation** when its Redis-backed queue
   is unreachable — it retries rather than throwing. A static import made this service unimportable
   locally (>60 s, no output at all). The import is now dynamic AND bounded (8 s), so a queue outage
   degrades the sheet to `mapped: null` + a `skippedReason` that travels in the payload instead of
   hanging the read.
2. `resolveBatch` issues one identical `FieldLinkGroup` query **per product** — 21 for a 21-row
   family.

Still open: the channel scope returns all 102 columns rather than only that channel's field family.
Caps and required-sets ARE per-channel (that is what readiness reads); the offered column list is
not, because the column set carries no per-channel membership marker to filter on.

Also product-level: mapping rules are global per (channel, marketplace, category) and the resolver
is keyed by product, so every alias projection of one product currently shows the SAME mapped value.
`meta.mapping.productLevelOnly` says so rather than implying per-alias accuracy.

### §9.3 Not caused by this lane

`src/services/__tests__/pim-schema-mapping.test.ts` had 2 failures from a sibling adding
`expressions: {}` to the mapping shape. Reported to the hub; **PES.6 has since fixed them.** The
full suite is now 450 files / 5926 tests green with zero type errors.

### §9.4 Shell adoption — Owner rulings encoded, backfill NOT run

Both decisions are constants in `scripts/pes5-adopt-shells.mts`, so a re-run cannot quietly diverge
from what was approved: `IT-GALE-JACKET` → `GALE-JACKET`; `WATERPROOF-OVERJACKET-ALT1` left
unadopted with its reason. Dry-run now reads **21 matched / 1 deliberately unadopted**
(`GALE-JACKET` gains 4 aliases).

The 21 writes have NOT been made. They are blocked on PES.5-ii regardless, and the approval to
execute is the Owner's to give directly — a relayed ruling is not the same thing for a data
mutation against production.

### §9.5 Read timings — measured, and the assumed fix will NOT help

Three consecutive reads of the GALE-JACKET family (21 rows), local API against the prod DB:

| scope | cold | steady |
|---|---|---|
| master | 1914 ms | **118 ms** |
| channel · eBay·IT | 2191 ms | **544 ms** |
| channel · Amazon·IT | 2058 ms | **2036 ms — does not drop** |

**The `FieldLinkGroup` N+1 is not the cost.** Measured directly:
`resolveChannelValues` takes **843 ms for 21 products and 839 ms for 1**. PES.6's "100 products cost
roughly what 1 does" is exactly right — the 21 duplicate queries are nearly free, so batching them
will not move the UX number. Worth fixing for tidiness; not worth waiting for.

**The real cost is an uncached schema load.** `field-catalogue.service.ts:260` does a
`categorySchema.findFirst({ select: { schemaDefinition: … } })` on EVERY call, and the Amazon
`schemaDefinition` is a 50–500 KB JSON blob that is then parsed. eBay never enters that path, which
is precisely why eBay settles at 544 ms and Amazon does not settle at all. A TTL cache on that load
— the same treatment `sheet-columns` already gives the identical data — is what collapses the
Amazon scope. It is PES.6's file, so it is reported, not patched from here.

Nothing in the studio's own path is unbounded: columns are cached (`studio-columns.ts`), the family
read is 2 queries, and the mapping call is capped at 8 s so a slow or unreachable resolver degrades
the sheet instead of hanging it.


### §9.6 Re-measured after PES.6's fixes — improved best case, unusable measurement environment

PES.6 landed both fixes (FieldLinkGroup batched 21→1; `schemaDefinition` TTL-cached, their figure:
Amazon·IT catalogue 1384 ms cold → ~78 ms warm). Re-measured, 7 reads each, cold dropped:

| scope | before (steady) | after — warm min | med | max |
|---|---|---|---|---|
| master | 118 ms | **110 ms** | 256 ms | 631 ms |
| channel · eBay·IT | 544 ms | **458 ms** | 1225 ms | 2410 ms |
| channel · Amazon·IT | 2036 ms (flat) | **821 ms** | 2182 ms | 2986 ms |

**Read this carefully rather than as a win.** The *minimum* improved everywhere, and Amazon's 2.5×
drop (2036 → 821 ms) is consistent with the schema cache landing. But the *median* and *maximum* got
worse and the spread exploded — Amazon now ranges 821–2986 ms where it used to sit flat at ~2036 ms.

I am not attributing that to anyone's code, because **the measurement environment cannot support the
claim**: this is a local API against a REMOTE production Neon database, over the internet, while
eight sibling sessions run their own probes against the same instance. Variance of that size is what
contention looks like. The earlier "flat 2036 ms" was measured when the tree was quieter, which makes
the before/after comparison weaker than it appears in the table.

**What is safe to conclude:** the uncached-schema bottleneck is gone (the best case could not have
dropped 2.5× otherwise), and nothing in the studio's own path regressed (master's min is unchanged
at ~110 ms). **What is not safe to conclude:** any steady-state number. A real figure needs the
deployed API against its own database with no sibling load — measure it there before treating any of
this as the UX number.


---

## §10 CORRECTION — the discriminator had to become NOT NULL (2026-09-01)

**§2's core design decision was wrong, and it broke every channel write.**

§2 argued for a NULLABLE `aliasId` in both compound uniques: the indexes are already
`NULLS NOT DISTINCT`, so NULL collides with NULL and 977 rows need no backfill. **The database half
of that is correct and still is. The client half is not.**

Prisma types EVERY field of a compound-unique input as NON-NULLABLE, regardless of the column:

```ts
ChannelListingProductId_channel_marketplaceCompoundUniqueInput = {
  productId: string; channel: string; marketplace: string
  channelConnectionId: string   // column IS nullable
  aliasId: string               // column WAS nullable
}
```

Measured, all three combinations:

| where | result |
|---|---|
| `aliasId: null`, conn real | ❌ Argument `aliasId` must not be null |
| `aliasId` real, `channelConnectionId: null` | ❌ Argument `channelConnectionId` must not be null |
| both real | ✅ OK |

So a NULL discriminator can be **stored and indexed** but never **targeted**. Every channel-routed
write through `PATCH /api/products/bulk` 500'd at query-build time. Found by PES.3's rehearsal.

**Why no one caught it:** `strictNullChecks` is OFF in `apps/api/tsconfig.json`, so `null` satisfies
`string` and the compiler accepted all 16 swept call sites. My sweep's "tsc clean + grep guard"
verification was structurally incapable of seeing this — the same shape as every other miss this
session: a check pointed where the defect could not appear.

### The fix — `20260901e_pes5_aliaskey_not_null` (applied)

`aliasKey String @default("")` — NOT NULL, carries the discriminator (`''` = primary listing), and
rides both uniques. `aliasId` stays as the real nullable FK and leaves the keys. `''` cannot be a
foreign key, which is exactly why these are two columns rather than one.

`ADD COLUMN … NOT NULL DEFAULT ''` backfilled all 977 rows in place to their correct value; the
aliasId-keyed indexes from `20260901c` were dropped (verified `aliasId IS NOT NULL` = 0 first, so
nothing could be orphaned). The pre-alias `…_conn_key` indexes are untouched and still serve a
rolling deploy's old container.

**Verified end-to-end** with a real GALE-JACKET child inside a transaction that always rolls back:
the upsert targeted the EXISTING primary row (same id — an update, not a duplicate), then rolled
back with prod byte-identical.

### 🔴 The same trap is LATENT on `channelConnectionId` — 10 call sites, not this lane's key

`channelConnectionId` is nullable and in both keys, so an **unattributed** listing is equally
untargetable. Ten call sites pass `… ?? null` and would throw the moment such a listing exists.
Harmless *today* only because 977/977 rows carry a connection — a property of the current data, not
a guarantee. The first Shopify listing created before Shopify is connected breaks all ten at once.

Not fixed here: that is MAP's key and MAP's decision. The durable fix is the same NOT NULL treatment
applied to `aliasKey`. `compound-unique-null.vitest.test.ts` allow-lists the ten explicitly (so the
guard still catches an eleventh) and brace-matches rather than regexes, because `tsc` cannot see this
class at all.


## §11 Readiness degrades to `absent` when no mapping rule applies (hub #88)

PES.6 measured that only AMAZON·DE and AMAZON·IT carry mapping rules. Verified, and the real shape
is narrower still — **rules are per PRODUCT TYPE, not per coordinate**. The default `fields` bucket
is empty on every marketplace; everything lives in `byProductType`:

| coordinate | default `fields` | `byProductType` |
|---|---|---|
| AMAZON·IT | 0 | `OUTERWEAR` → 13 rules |
| AMAZON·DE | 0 | `OUTERWEAR` → 19 rules |
| EBAY·IT (and 16 others) | 0 | *none* |

**The bug this exposed:** eBay·IT reported **`pct: 100`** — truthfully, 21 of 21 schema-required
fields were filled — while carrying **zero mapping rules**. Nothing would publish there at all. A
true number that reads as "ready" on a coordinate that cannot publish is exactly the confidently-
wrong surface this programme removes.

`GET /api/products/:id/readiness` now returns `state: 'absent'`, `pct: null` and a note naming the
coordinate AND the product type when no rule applies. `required: {filled,total}` is still returned,
so only the VERDICT degrades — the counts are not destroyed. A new `mappingRules: number | null`
(null in master scope) makes the cause inspectable rather than implied.

**Why per-type matters, measured on two real products:**

| product | type | Amazon·IT before | Amazon·IT after |
|---|---|---|---|
| GALE-JACKET | OUTERWEAR | blocked, 71%, 13 rules | unchanged — rules exist |
| xavia-knee-slider | AUTO_ACCESSORY | blocked, 17%, "13 rules" | **absent, 0 rules** |

A per-coordinate count calls Amazon·IT configured for the knee-slider and shows 17% — implying the
operator just needs to fill more fields. They could fill every one and still publish nothing.
Confirmed by mutation: reverting to a per-coordinate count reproduces the misleading `blocked/17%`.


## §12 Publish snapshots + restore-to-draft (D1 wave-1, ruling #110)

Migration `20260901f_pes5_listing_snapshots` — **applied**. Contract for PES.4's drawer pane.

### The prior art, and why it is not copied

The eBay cockpit ALREADY implements this doctrine (`POST /ebay/cockpit/snapshot`,
`.../snapshot/restore`, "the current state itself is snapshotted FIRST"). It stores snapshots inside
`ChannelListing.platformAttributes._versionHistory` — a JSONB array on the row. Measured reasons not
to follow it:

- **That row is the hot path.** Every sheet read loads `platformAttributes`; Amazon rows already
  reach 5.7 KB with zero snapshots.
- **It self-limits.** The cockpit strips `_versionHistory` before capturing, "so we don't snapshot
  snapshots (storage blows up otherwise)" — an acknowledged ceiling.
- **It is eBay-cockpit-only.** Amazon, at 725 listings, has no snapshot path.
- 🔴 **It has never run.** `_versionHistory` is present on **0 of 977** listings. Prior art to learn
  from, not a proven implementation to trust.

### Contract

```
GET  /api/products/:id/listings/:listingId/snapshots            → { snapshots: SnapshotSummary[] }
POST /api/products/:id/listings/:listingId/snapshots            → { id, createdAt }   (manual checkpoint)
POST /api/products/:id/listings/:listingId/snapshots/:sid/restore → RestoreResult
```

`SnapshotSummary` = `{ id, reason, label, publishEventId, capturedBy, createdAt, restoredAt,
restoredBy, sizeBytes }`. **Payloads are deliberately NOT returned by the list** — twenty flat-file
payloads is megabytes for a panel that renders when/why/who. `sizeBytes` carries the weight instead.

`RestoreResult` = `{ restored: true, snapshotId, undoSnapshotId, isPublished: false, fieldsWritten[] }`.

### What "restore to draft" means here, stated because it could be assumed wrong

There is no draft LAYER on `ChannelListing` — the row is the listing. So a restore writes the
captured values onto the row **and sets `isPublished = false`**, which is what stops the outbound
push. **The marketplace keeps serving the old live content until an operator explicitly publishes.**
The local record changes; the channel does not. This module makes no channel calls at all.

Three safeguards worth knowing about:
- **Auto-undo.** The current state is snapshotted FIRST, inside the transaction, so a restore is
  undoable even if the write that follows is what went wrong. `undoSnapshotId` is that snapshot.
- **Coordinate guard.** A snapshot carries its coordinate and refuses to land on a different one
  (409). A listing can be re-pointed after capture, and writing IT's content onto DE is not a
  restore, it is corruption.
- **Field allow-list.** `id`, `version`, `createdAt`, `externalListingId` and the sync bookkeeping
  are never restored — writing a stale `externalListingId` back would re-point the local record at
  whatever listing it used to be.

Verified end-to-end on a real EBAY:IT listing inside a rolled-back transaction: capture →
diverge → restore → `isPublished: false`, values restored, 2 snapshots (pre-publish + pre-restore),
and **0 rows persisted** after rollback.

### §12.1 Master-record restore is a different mechanism (#112.2)

`POST /products/:id/restore` wrote **no audit row of any kind** — so "restore to 14:02" was a
one-way door with no record of the state it discarded. It now captures the prior values through the
SAME `AuditLog` trail the bulk PATCH uses, not through `ChannelListingSnapshot`: that table is keyed
to a `channelListingId` and a master product is not one, and the per-cell history API already reads
the audit trail — so a restore now appears in the drawer beside every other change rather than as an
invisible jump. The capture reuses the handler's existing pre-read (widened select, no new query).

### §12.2 `offerActive` on `SheetListing` (#112.1)

Exposed on both sheet reads. Distinct from `isPublished`: `offerActive: false` means the OFFER is
paused for that coordinate (listing preserved, buy box suppressed), not that the listing is
unpublished. A drawer previously had to infer it from `isPublished`, which is a different thing.


## §13 `GET /api/products/:id/sync-queue` (ruling #128)

Product-scoped read of `OutboundSyncQueue` for the Errors & Sync console. Read-only — nothing here
enqueues, retries or cancels. PES.3's claim verified: every existing `findMany` on this table lives
in a worker, a job, or the control-tower routes; there was no product-scoped read.

```
GET /api/products/:id/sync-queue?channel=EBAY&market=IT&filter=all|dead|retrying|stuck&limit=50
```

Returns `{ scope, counts: {all,dead,retrying,stuck}, rows: SyncQueueRow[], stuckThresholdHours }`.
Scope is the FAMILY (root + children), and a row reaches it either directly (`productId`) or through
one of its listings (`channelListingId`) — querying `productId` alone would miss the 1,727
listing-only rows.

### 🔴 Why `syncedAt` is required in every row — quantified

PES.3 flagged this and the measurement is stark. `stuck` written as `createdAt < now - 24h`:

| | whole table | GALE-JACKET family alone |
|---|---|---|
| naive (age only) | **36,844** | **441** |
| honest (+ `syncedAt IS NULL` + runnable status) | **0** | **0** |

The naive filter reports 441 stuck syncs **for one product**, and essentially the entire table
globally — because 31,999 SUCCESS and 2,198 SKIPPED rows completed weeks ago and carry a `syncedAt`
proving it. A console that says "441 stuck" is not slightly wrong; it is one an operator stops
believing. `stuck` therefore means all of: never synced, still in a runnable status
(`PENDING`/`IN_PROGRESS`), older than the threshold, and not inside its `holdUntil` grace window.

`stuck: 0` is currently the true answer everywhere — there are **zero** `PENDING`/`IN_PROGRESS` rows
in the table. The console must render that empty rather than reaching for a filter that produces
something to show.

### ⚠ This endpoint can only ever see a minority of the queue

`OutboundSyncQueue`'s comment says "At least one must be set" of `productId`/`channelListingId`.
Measured, that is false:

| linkage | rows |
|---|---|
| both | 1,805 |
| product only | 1,649 |
| listing only | 1,727 |
| **neither** | **32,665 (86%)** |

So a product-scoped read is structurally incomplete. `scope.coverageNote` states it in the payload —
an empty list must not be read as "nothing is queued for this product".

Verified on GALE-JACKET: `all: 441, dead: 405, retrying: 0, stuck: 0`; `channel=EBAY&market=IT`
narrows to `all: 40, dead: 36`; a bad filter returns 400 naming the valid values.


### §13.1 SKU + server-resolved alias on each row (ruling #141)

**`sku` is now on every row.** Without it an operator staring at a cause group of 21 products cannot
tell which one a failed write belongs to — the queue row's own ids are opaque. Verified: 200/200 rows
on a full page carry a SKU, across 21 distinct products.

**The jump-to-row question — my answer: it belongs SERVER-side, and here is why.**

PES.3 was right not to assume `primary:`. But the alias is not unknowable — it is *server*-knowable
for most rows. The queue row carries no alias, yet a row linked to a `channelListingId` reaches one
through `ChannelListing.aliasKey`. Measured on the GALE-JACKET family: **396 of 441 rows (90%)
resolve**; the remaining 45 are product-only and genuinely cannot.

So the server now supplies the piece only it can know, and says plainly when it cannot:

| field | meaning |
|---|---|
| `aliasId` / `aliasKey: ""` + `aliasResolved: true` | known to be the PRIMARY listing |
| `aliasId: "<id>"` + `aliasResolved: true` | known to be that alias |
| `aliasKey: null` + `aliasResolved: false` | **unknown** — not "primary" |

That last row is the whole point: `aliasKey: ""` (known primary) and `aliasKey: null` (unknown) are
different answers, and collapsing them is the bug PES.3 avoided by shipping scope-only jumping.

⚠ **Deliberately returned as COMPONENTS, not as a composed sheet row id.** The sheet owns its row-id
format (`alias:productId`); encoding that format server-side would couple the two and break quietly
if the sheet ever changed it. The server resolves the alias; the sheet composes the id. Neither
guesses the other's business.

Cost: two batched reads per page (listings, then products), never per row — a 200-row page would
otherwise be 400 queries. Measured 812 ms for 200 rows.


### §13.2 Why a sync row failed — derived, and NOT from `errorCode` (ruling #142)

Ruling #142 approved "a derived reason from `errorCode`". **`errorCode` cannot answer it.** Measured:
**2,490 failed rows share the single code `MAX_RETRIES_EXCEEDED`** — covering both writes Amazon
genuinely refused and writes never attempted because publishing is switched off. The code records
how it ended (retries ran out), not why it could not succeed. The signal is in `errorMessage`.

Each row now carries `reason`, `reasonSummary`, `reasonActionable`:

| reason | rows | actionable | meaning |
|---|---|---|---|
| `rejected` | 1,780 | ✅ | the marketplace refused it — the only one needing an operator |
| `throttled` | 399 | — | our own debounce or circuit breaker; retries itself |
| **`gated`** | **368** | — | publishing deliberately switched off. Not a failure. |
| `internal` | 6 | — | we abandoned it before it reached the channel |
| `unknown` | **0** | ✅ | unrecognised — never a synonym for `rejected` |

`gated: 368` matches PES.3's independently-measured 368 exactly, which is the cross-check that the
classifier is catching the right rows.

**Two misclassifications found by running it over the whole table**, neither predictable from the
error codes:
- 5 rows reading `inventory_item GET 200 — refusing content PUT built from an empty read` are **our
  own safety guard**, not a marketplace answer. They were landing in `rejected` (the message
  contains "200"), sending an operator to Seller Central to investigate a refusal we made ourselves.
  Now `internal`, and the rule is ordered before `rejected` so the HTTP-code pattern cannot reclaim
  them.
- 1 row, `ReviseInventoryStatus Failure: SKU non esiste nell'inserzione`, is a genuine eBay refusal
  that sat in `unknown` purely for being Italian with no HTTP code. Matching `Failure:` catches the
  channel's own error envelopes regardless of language.

⚠ **A method note on the mutation testing.** One of my three mutations reported "no failures", which
would have meant the `unknown` default was unguarded. It had silently **not applied** — the literal
is indented four spaces and my patch matched six, so the replace found nothing and I tested an
unchanged file. Re-run with it genuinely applied: 2 tests fail. *A mutation that does not mutate
reports a passing test as a weak one* — always confirm the file changed, which is the same
"verify the instrument" lesson as the route-table regex and the scoped grep.


### §13.3 🔴 A DEAD row cannot retry — the classifier was wrong about 405 of them

PES.3 consuming §13.2 exposed a defect I introduced. Measured: **all 399 `throttled` rows are
`isDead: true`, `retryCount 3/3`, `nextRetryAt: null`.** They exhausted their retries *while being
throttled* and will never run again — the write never reached the channel.

The classifier graded them *"Deferred by our own throttle or circuit breaker — it will retry without
you"*, `actionable: false`. That is false for every one of them, and PES.3's pane was toning 33 of 36
eBay·IT rows quiet on the strength of it. **Telling an operator that 399 writes which never happened
are fine is the exact failure class this classifier exists to remove, one level down.**

`actionable` now depends on whether the row can still PROGRESS, not on the cause alone, and a new
`willRetry` says so explicitly:

| cause | still runnable | dead |
|---|---|---|
| `throttled` | not actionable — "will retry without you" | **actionable** — "gave up while throttled; never reached the channel" |
| `internal` | not actionable | **actionable** — out of retries |
| `gated` | not actionable | not actionable, but says *"enabling the flag will not resend this row"* — the difference between paused and lost |
| `rejected` | actionable | actionable |

Actionable rows go from 1,780 to **2,185**. `deriveFailureReason` without the `isDead` option keeps
the old retry-optimistic reading, so a caller that does not know deadness cannot silently receive the
dead verdict.

**The lesson underneath it:** a cause is not a verdict. `throttled` describes why the write stalled;
it took the row's STATE to know whether anyone still needs to care. Classifying on cause alone
produced a confident, quiet, wrong answer — and it took a consumer rendering it on screen to reveal
that, which is an argument for shipping a classifier to a real surface early rather than validating
it only against its own distribution.


## §14 attr_* channel routing — channel cells are writable (#169 / #171)

The Owner's top complaint, "I'm unable to edit them all": on a channel scope ~90% of cells rendered
not-writable because `PATCH /api/products/bulk` could route only six field names to a
`ChannelListing`.

**The layer already existed.** `ChannelListing.overrideData` is documented as "PIM A.1 —
Channel-level master attribute overrides", and `resolveAttributes` already applies it as
`channelOverride`, above master/variant and below the explicit `*Override` columns. Measured: it was
`{}` on **all 977 rows**, with exactly **one** writer in the entire API. The cascade was built and
never fed — so this was a write-side gap, not a missing design.

### Contract

`changes[]` gains `target?: 'master' | 'channel'` (default `master` — every existing caller is
unaffected). `marketplaceContexts[]` gains `aliasKey?: string` (`''` = primary).

A `target: 'channel'` attribute change merges into `ChannelListing.overrideData` for each context,
via `INSERT … ON CONFLICT (productId, channel, marketplace, channelConnectionId, aliasKey) DO UPDATE`
— so it lands on **the listing the cell belongs to**, alias included, and never on the primary by
default.

Chosen over extending the prefix map (`ebay_attr_material`) because that explodes the namespace and
forces the client to mangle names. As a target, the write contract becomes the **mirror** of the read
contract: the sheet's new `writeVerb` is echoed straight back.

| | before | after |
|---|---|---|
| cells writing to the listing (eBay·IT, 441) | 42 | **315** |
| `affectsAllChannels: true` | 399 | **126** |
| `writable: false` | alias rows | **0** |

The remaining 126 are `storage: 'column'` fields — sku, status, productType and friends — which stay
master truth per #171.4. A per-channel SKU is a different feature.

⚠ **Shopify/Etsy/Woo still have no channel write route**, and the contract still says so.
`marketplaceContexts[].channel` is typed `'AMAZON' | 'EBAY'` on the endpoint, so those contexts
cannot be expressed at all — the override route is unreachable there, not merely unprefixed.

### Concurrency, and what a new row looks like

Channel writes CAS on the **listing's own** `version`, not the product's (#171.3): a channel write
does not change the product, and CASing on `Product.version` would make two operators on different
channels conflict for no reason. Verified: a stale `expectedVersion` returns **409** and the listing
is **not written**.

A coordinate with no listing yet is upserted, born `DRAFT` **and `isPublished: false`** — typing in a
cell must never produce something publishable. (The pre-existing six-field upsert leaves
`isPublished` at its schema default of `true`; this path deliberately does not.)

### 🔴 The rehearsal caught a real bug — twice

The routing contract is only falsifiable by a WRITE, and the rehearsal earned that rule twice:

1. **First run: the write leaked to MASTER.** `target` was not in the `Validated` interface, so it was
   silently dropped in validation and the change fell through to the master path. Nothing errored;
   the value simply landed on the wrong layer. **My own `(v as { target?: string })` cast hid it from
   `tsc`** — the `as any` family, applied to myself. `target` is now typed on `Validated`, carried at
   all three push sites, and the cast is gone so the compiler is the guard.
   *(That run wrote to production. It was detected by the DB-level read-back, and the key was removed
   — verified absent, not set to null, matching the pre-test state.)*
2. **Second run: the write landed nowhere.** A multi-step patch script asserted-and-threw on its
   *second* replacement, so the file was never written and the first half was lost. The writer
   existed and was never called. I had verified the second patch and assumed the first had landed.

Final rehearsal, read back in raw SQL (never through my own read path): value on the eBay·IT listing,
version bumped, **master untouched, Amazon·IT untouched**, cleanup verified.

⚠ **Alias isolation is NOT yet proven on live data** — no alias rows can exist until PES.5-ii drops
the pre-alias indexes. The `aliasKey` is in the `ON CONFLICT` target and unit-tested, but the
end-to-end "write to alias ② leaves ① untouched" rehearsal must run when aliases become creatable.
Stated rather than implied.


### §14.1 Face image on the studio row (#178)

`StudioRow` gains `imageUrl`, `photoCount` and `imageInherited`, for the pinned thumbnail identity
cell.

`imageUrl` uses the **server-side** `pickFaceImage` (isPrimary → first MAIN → lowest sortOrder) —
the same rule the drawer's client-side picker applies, so the grid thumbnail and the drawer's main
image cannot disagree. One rule, two consumers. The images ride the existing family query
(`FACE_IMAGE_SELECT` + `FACE_IMAGE_ORDER_BY`); no extra round-trip, none per row.

**Parent fallback, and why it needed a flag.** A child with no images of its own falls back to the
family's face, matching what the catalogue already does (`sync-control.routes.ts` does the same
two-step). This is not an edge case: **74 of 301 children (25%) have zero own images**, so without
the fallback a quarter of rows would show nothing — the "column of nothing" this cell exists to
avoid.

But a row showing a thumbnail beside `photoCount: 0` reads as a bug. `imageInherited: true` says the
picture belongs to the family rather than the row, so PES.2 can tint it exactly like every other
inherited value in this sheet. Verified: GALE-JACKET 21/21 with an image and 0 inherited;
`VENTRA-JACKET-4XL-YELLOW-WOMEN` returns `photos: 0, inherited: true` with the parent's URL.


### §14.2 Variation axes — explicit map + per-row values (#180)

`family.axes: StudioAxis[]` (`{ key, label, rowsWithValue, rowsTotal, source }`) and per-row
`axisValues: Record<string,string>`. Both ride the existing family query.

**Why `source` exists.** GALE-JACKET **declares** `['Colore','Taglia']` in `variationAxes` and
**stores** its values under `Color` and `Size`. Those are different strings, so the payload reports
both, marked `stored` (values exist) or `declared` (listed, nothing written). They are deliberately
NOT auto-paired: `'colore'.includes('color')` is true by luck and `'taglia'` vs `'size'` is not, which
is exactly the string-matching the ask set out to remove. A wrong pairing is worse than an unpaired
axis, so an unmatched key keeps its own name.

### 🔴 The blocker is the DATA, not the payload — the columns would be empty

AG.1 is holding the default view at 14 columns waiting for this. It will not unblock what they
expect. Measured 2026-09-01:

| | |
|---|---|
| children with any `variantAttributes` | **53 of 301 (18%)** |
| GALE-JACKET children with values | **2 of 20** |
| AIRMESH-JACKET children with values | 12 of 20 |
| rows carrying `"variantAttributes": "[object Object]"` | **2** — both GALE-JACKET children |

Adding two axis columns to the default view would render them **empty on 18 of 20 GALE-JACKET rows**
— a 90%-empty column, which is a sharper version of the "column of nothing" the curated-view rule
exists to remove. The payload now says so per axis (`rowsWithValue`), so the decision is visible
rather than discovered on screen.

Two data defects surfaced, neither fixable from a read path:
- **`"variantAttributes": "[object Object]"`** stored as a value on 2 rows — an upstream writer
  stringified an object into its own field. `readAxisValues` filters it (and any non-string) so it
  can never reach a cell, but the rows are still wrong in the database.
- **Key language is inconsistent**: `Colore`/`Taglia` and `Color`/`Size` and `Body Type` are all in
  use across families, and the declared labels frequently match nothing stored.

Nothing here is inferred from the SKU. The SKUs encode colour and size, and parsing them would fill
the columns convincingly and wrongly — the honest answer is that the values are not recorded.


### §14.3 🔴 `SheetListing.version` — the read could not supply what the write checks (#183)

A gap I introduced. §14 made channel writes CAS on the **listing's** version; the read exposed only
the **product's**. `SheetListing` had no `version`, so a client literally could not send the token
the endpoint checks.

Measured — and broader than reported:

| | |
|---|---|
| eBay·IT listings whose version differs from their product's | 156 of 252 |
| **all channels** | **868 of 977 (89%)** |
| largest gap | product v1 vs listing **v89** |

`version` is now on `SheetListing` in both readers, verified to match the database row-for-row.

**And fixing that exposed a second half of the same bug.** With the listing's version supplied, the
write STILL 409'd — because the pre-existing product CAS also fires whenever `expectedVersion` is
set, comparing the *listing's* number against `Product.version`. A channel-only request now skips the
product CAS (`hasMasterTargetedChange`); the master path is unchanged and verified: stale → 409,
correct → 200 with the version bumped.

Proven end-to-end on a real eBay·IT listing, then restored:

```
with PRODUCT version (v3)   -> 409   (correctly rejected — wrong token)
with LISTING version (v22)  -> 200   accepted
```

PES.3's framing is why this was urgent and is worth keeping: **a spurious conflict is worse than no
CAS, because it trains an operator to dismiss the one message that should always mean something.**

⚠ Adding the field alone would NOT have fixed it — the request would have kept 409ing and looked
like the field had not helped. Only attempting the write surfaced the second half, which is the
rehearsal rule earning its keep a third time.


### §14.4 🔴 Double version bump + wrong conflict row (#194)

Two more defects of mine in the channel CAS, found by PES.3 doing exactly what §14.3 asked — real
writes, DB read-back, deliberate stale.

**1. An accepted write bumped the version TWICE.** The CAS guard did
`version: { increment: 1 }` *and* `writeChannelOverrideMerge` did
`"version" = "version" + 1`. The response reported `expectedVersion + 1`, so it said 16 while the row
held 17 — and feeding the returned version into the next write 409'd every time.

On an autosaving sheet the second cell an operator edits is the *normal* case, so this would have
shipped as **"the sheet stops saving after the first change, and blames the operator"**.

The guard is now verify-only (`data: { updatedAt }` — Prisma still throws P2025 on a version
mismatch, which is its entire job) and the merge is the single bump.

**2. The 409's `currentVersion` was the PRODUCT's** — it came back as 1 while the listing was at 19,
a number from a different row that no client can recover with. Channel conflicts now report the
listing's version, and every response carries `versionOf: 'channelListing' | 'product'` so a client
cannot apply a version to the wrong row.

**The success path no longer computes the version at all.** `expectedVersion + 1` was true only while
exactly one statement bumped; it is now read back from the row that changed, which cannot drift from
it whatever the statements do. That is the actual lesson — the arithmetic was a restatement of an
assumption, and the assumption changed underneath it.

Verified by PES.3's method, then restored:

```
listing v22
write 1: sent v22 → 200, response v23 (channelListing), DB v23   response == DB
write 2: sent v23 → 200, response v24 (channelListing), DB v24   chained write accepted
stale  : sent v22 → 409, currentVersion 24 (channelListing)
```

Master path re-verified unchanged: stale → 409, correct → 200, version 3 → 4.


### §14.5 🔴 `POST /restore` never bumped `Product.version` (#220)

Found by PES.4 verifying the restore round-trip. The handler read the version for its own CAS check
but its update omitted the increment, while the bulk PATCH CAS-bumps inside its transaction.

**Why this was the worst possible place to miss it.** A restore rewrites fields to an earlier state.
A sheet loaded BEFORE the restore still holds the old version, so its next cell write passes the
guard and **silently overwrites the restored values with no 409**. The one write most likely to be
racing a stale view is exactly the one the CAS could not see — the token failing precisely where it
was needed.

Fixed inside the restore's own transaction, with the version **read back** rather than computed
(#201), and the response now carries `currentVersion` + `versionOf: 'product'` like the bulk path.

Verified by the chaining method, then restored:

```
start v3
restore 1 → 200, currentVersion 4 (product), DB v4     response == DB
restore 2 → 200, currentVersion 5,           DB v5     chained
stale sheet write with v3 → 409 VERSION_CONFLICT, currentVersion 5
   manufacturer still "PES5-RESTORED-2"  ← the restored value SURVIVED
```

That last line is the assertion that matters: before the fix the stale write would have landed and
undone the restore without a word.

**Note this does not change §14.3's finding.** `Product.version` is still maintained by only a
handful of writers out of 124 across 45 files — the restore is now one of them. It remains a
narrow token: "nobody edited this through a path that maintains it", not "this row is unchanged".


### §14.6 The channel narrowing never narrowed (BE-1, #233/#237/#248)

`coordinatesFor`'s `channels` option force-INCLUDES past the presence filter and excludes nothing —
its own doc string says so. Two of my call sites read it as a filter, and §14's comment claimed the
correctness it did not get. Measured: master / Amazon·IT / eBay·IT returned byte-identical column
sets, and **36 of 36 capped columns on the eBay scope carried `capFrom: "Amazon · IT"`** — `item_name`
showing Amazon's 200-character cap as though eBay had set it.

Fixed by adding a true `only` filter (not by changing `channels`, whose semantics MS.1/MS.2 depend
on), surfaced as `onlyChannels`.

**The part source review could not see.** The filter was correct and had *no visible effect*, because
`getSheetColumns` keeps its own `columnSetCache` whose key included `channels` but not the new
option — so a narrowed build was served the un-narrowed entry. A partial fix presenting identically
to no fix, one layer below the fix. Both cache keys now include it.

| scope | columns | capped by a non-scope coordinate |
|---|---|---|
| master | 102 | — |
| Amazon·IT | 97 | — |
| **eBay·IT** | **35** | **0** (was 36 of 36) |
| Shopify·GLOBAL | 30 | — |

**And the narrowing immediately broke the create path (#248).** `coordinatesFor` also drops
coordinates the product has no listing on, so eBay·DE returned zero coordinates and the scope threw
`scope_not_available` — killing exactly the case where an operator opens a scope to list there for
the first time. The call site now passes `onlyChannels` AND `includeEmptyChannels`; the pair is
load-bearing and commented as such. Verified: eBay·DE serves 35 columns with
`readiness.state: 'unlisted'`.

⚠ **§14's "315 of 441 cells write to the listing" was counted over Amazon's column set** and must be
re-derived on the corrected eBay set before it is quoted again.

### §14.7 Two findings that did NOT hold

Recorded because a review lane asked to be told, and because a false finding left standing costs
more than the fix.

- **R2 (silent dropped write).** The predicate gap is real — the empty-context guard keys on a closed
  6-key map that contains no `attr_` key — but the path is unreachable: the registry check fires
  first and rejects with **400 `Unknown or read-only category attribute`**, because it resolves the
  attribute schema *from* the marketplace context. Measured all three shapes: no context → 400,
  nothing written; eBay context → written to the eBay listing; Amazon context → written to the
  Amazon listing (correct — it went where asked).
- **#247 (destructive parked migration).** `20260901e`'s `migration.sql` contains **zero** DROPs of
  `aliasKey`; those statements are in `rollback.sql`, which `prisma migrate deploy` never executes.
  `20260901e` is also APPLIED, not parked — the parked migration is `20260901d_pes5_ii_*`, already
  outside the deploy path in `migrations-pending/`.

All eight migration folders: applied, additive or index-drop-only, none destructive.

## §15 Per-market / per-scope measurement, and two fixes (2026-09-02)

### §15.1 `#258` — snapshot restore now advances the version, and the path was dead

`restoreToDraft` rewrote listing content without advancing `version` or emitting
an event, so a client holding the pre-restore token passed CAS and silently
overwrote the restore — the same shape as `#220`'s `POST /restore`. Fixed inside
the transaction: `version: { increment: 1 }`, the new value **read back** via
`select` (`#201` — never computed), `currentVersion` + `versionOf:
'channelListing'` on `RestoreResult`, and a `CHANNEL_LISTING_UPDATED` event plus
the `listing.updated` broadcast emitted *after* the transaction commits so a
downstream failure cannot roll back a restore the operator already made.

**The larger find: the whole path was dead at runtime.** `SNAPSHOT_FIELDS` listed
`channelCategoryId`, which is a column on `VariantChannelListing`, not
`ChannelListing` — the table has no category column at all. Prisma threw on the
select, so `captureState` failed on **every** call and both `captureSnapshot` and
`restoreToDraft` had never executed successfully in the life of D1 wave-1. It
type-checked clean throughout because the list is a plain string array, so `tsc`
had no model to compare it against, and every prior review of this service read
the code rather than running it. Nothing is lost by removing the field: a channel
category lives inside `platformAttributes` (eBay's `{ categoryId, … }` bag),
already captured. The other 21 fields were then validated against
`information_schema` rather than fixing only the one that happened to throw.

**Rehearsed on prod (`#224`'s assertion), 10/10** — AIREON · AMAZON:DE, field
`attr_ceCertification`: restore bumped 5→6; `currentVersion` matched the row read
back independently; the stale write at v5 was rejected **409 VERSION_CONFLICT**
carrying `versionOf: 'channelListing'`; **the restored value survived**; and the
CONTROL arm — the identical write at the fresh version — returned 200 and landed.
The control is the point: a 409 alone proves nothing, because the field-registry
guard or a missing coordinate would also reject without ever reaching the CAS.
Residue was swept by sentinel across the whole table, not just the row touched;
one honest permanent side effect is that the fixture's `version` drifted 1 → 7.

### §15.2 `#273` — the per-market cost is the mapping enrichment, not the market

Measured through the services in a fresh process per market. **Wall time is the
weak instrument here** — this process reaches Neon over the public internet,
while the numbers the Owner will see come from the API running beside the
database — so the structure, not the absolute values, is the finding.

| market | master cold | master warm | Amazon cold | Amazon warm ×4 | eBay cold | readiness cold | readiness warm |
|---|---|---|---|---|---|---|---|
| IT | 17.0s | 0.25s | **25.9s** ⏱ | **18.4s** ⏱ / 6.0 / 2.4 / 1.7 | **8.4s** ⏱ | 11.1s | 0.20s |
| DE | 11.2s | 0.77s | **22.2s** ⏱ | 9.0 / 6.4 / 6.8 / 6.8 | 2.9s | 11.2s | 0.22s |
| ES | 9.3s | 2.2s | 6.9s | 2.6 / 1.3 / 1.6 / 2.7 | 1.3s | 2.7s | 2.3s |
| FR | 2.3s | 0.58s | 11.0s | 5.4 / 5.2 / 4.2 / 5.6 | 4.0s | 2.5s | 0.16s |

⏱ = the mapping enrichment blew its 8 s budget. Columns: master 142 (IT 147),
Amazon 142, eBay 35, 6 readiness scopes — identical across markets.

`studio-sheet.service.ts` composes PES.6's resolver for channel scopes only, and
bounds it at 8 s for **both** the module import and the call because that module
connects to a Redis-backed queue during initialisation. While that connection is
establishing the resolve times out; once established it succeeds and the call
settles at 1.7–2.4 s. **That decay is the entire "4× spread on identical warm
state"** — it is not per-market, not per-rule, and not contention: `EBAY · IT`
cold timed out too, so it is whichever channel scope arrives first. Timeout
counts per run were IT 3, DE 1, ES 0, FR 0, and ES — the market with *no*
timeouts — was the fastest. This retires "AMAZON · IT is the slow scope".

**The Owner-facing cost is not the latency, it is what the timeout takes away.**
When the budget is missed the sheet still ships (deliberately), but every cell
returns `mapped: null` with all 41 family products in `missingProductIds`, and
the reason sits in `meta.mapping.skippedReason` where no operator sees it. A grid
that silently drops its derived column for the first loads after a deploy and
then starts showing it reads as data loss. The contract already carries the
reason; surfacing it is a wiring question, not a data one.

Two related facts, both measured rather than reasoned: coordinate counts are
**identical** (5) across IT/DE/ES/FR, so they explain nothing; and readiness's
un-narrowed first build (`scope-readiness.service.ts:104`) **is** needed — it
derives `coordinates`, and the master chip is scored against that same full set,
so narrowing it would only move the work. `1 full + N narrowed` is the right
shape, and `onlyChannels` is correctly keyed and correctly passed.

### §15.3 `#294` — `scope_not_available` answered a question it could not answer

`?market=PL&channel=EBAY` returned *"EBAY is not an active channel on PL. Active
here: none"*. Both halves were false: the sentence asserts marketplace
**configuration** while the list was built from the **narrowed** coordinate set.

The chain: the call passes `onlyChannels: [wantChannel]`, `coordinatesFor`
narrows to that one channel, PL has no eBay row so `coordinates` is `[]`, and the
error's third argument was then built from that same list. **`availableChannels`
was empty by construction every time the error fired** — the field exists to say
where the operator *could* go, and it was derived from a set that excludes every
alternative by definition. This was a consequence of the `only:` narrowing that
fixed `#248`: that fix corrected the throw and left the message reading the
narrowed input.

Fixed by re-reading the market's **full** coordinate set on the error path only
(cached, so the happy path pays nothing), and by making the sentence speak about
configuration like the list now does. Verified with the exact probe:

```
PL·EBAY  → "EBAY has no marketplace configured on PL.
            Configured here: AMAZON, SHOPIFY, WOOCOMMERCE, ETSY"
PL·AMAZON→ served, 36 cols          (the create path on an unlisted market)
IT·EBAY  → served, 35 cols          (no regression from #248)
DE·EBAY  → served, 35 cols
IT·SHOPIFY → served, 30 cols        (GLOBAL-scoped coordinate)
```

**Flagged, not fixed — other lanes' surfaces.** `getStudioColumns` wraps
`getSheetColumns`, and three callers of the latter omit `includeEmptyChannels`,
so they see only coordinates that already carry listings:
`routes/products-sheet.routes.ts:59` (MS.1), `sheet-rows.service.ts:347` (MS.2),
and `services/ai/enrichment/generate.service.ts:241` (PES.8). Measured, not
assumed — `getSheetColumns({ market, productTypes: ['OUTERWEAR'] })`:

| market | default | with `includeEmptyChannels` |
|---|---|---|
| PL | 30 cols, **zero coordinates** | 36 cols, 4 coordinates |
| DE | 96 cols, Amazon · DE only | 101 cols, **+ eBay · DE** |
| IT | 102 cols, both | 102 cols |

So on PL the enrichment path sees no channel coordinate at all, and on DE it
cannot see eBay. I filed this as **the** cause of the "No draftable columns in
this scope." dead end. **That causal claim was wrong, and PES.8 measured it.**
They applied the `includeEmptyChannels` fix and checked the draftable count
both ways first: it was zero either way, even on `AMAZON:IT`. The real cause
was `DEFAULT_DRAFT_KEYS` in `ai/enrichment/constraints.ts:136`, which
contained no channel write field at all — so channel-scope enrichment had
never worked for any channel on any market since that lane was built, while
master scope worked and made the feature look fine. The tests that covered
`draftableConstraints` passed explicit column lists, bypassing the default set
entirely. The column-set gap is real and worth fixing; it was not the zero.

**The lesson is about the form of the report, not the content.** BE.1 filed
their `includeEmptyChannels` observation as a *question* for PES.8 rather than
a diagnosis, and that is the item that reached the real defect — because
PES.8 measured instead of accepting it. Had it been asserted as the cause,
PES.8 might have fixed the flag, watched the number stay at zero, and gone
looking in the wrong place. An asserted cause does not merely risk being
wrong: it stops the person who *can* measure from measuring, because fixing a
plausible cause looks like progress while moving the number not at all.
Left to PES.8 and MS.

**Corrected after a second reader refused the characterisation (BE.1).** I had
called DE "a market with real listings" while pointing at eBay · DE, which reads
as a populated coordinate being hidden. It is not. `present` is built from a
**platform-wide** `channelListing.groupBy`, and the counts are:

```
AMAZON:DE 214   AMAZON:ES 123   AMAZON:FR 115   AMAZON:IT 273   EBAY:IT 252
```

`EBAY:IT` is the only eBay coordinate carrying listings anywhere, and PL carries
none at all. So the presence filter is **correct for a presence view** — nothing
populated is being hidden, and the severity I implied was wrong.

What survives is sharper, and is BE.1's framing rather than mine: `/readiness`
passes `includeEmptyChannels` and therefore offers **eBay · DE as a scope chip**,
while the column build behind that same scope cannot see it. The finding is not
"enrichment sees fewer columns"; it is that **two studio surfaces disagree about
which channels exist**, and the operator is offered a scope the column build will
not serve. That is also the honest form of the master-column inconsistency below:
IT's master set is 147 rather than 142 because eBay · IT is the only populated
eBay coordinate on the platform, not because IT is special.

**One inconsistency found and deliberately not changed.** The sheet passes
`includeEmptyChannels` only on the channel branch, so a *master* column set is
still presence-filtered: master is 147 columns on IT and 142 elsewhere purely
because eBay · IT is the only eBay listing. Readiness already passes the flag, so
master and readiness disagree about which scopes exist. Making them agree is a
product decision about whether master's caps should consider channels the
product is not yet listed on — it is a visible change to the master sheet, so it
is raised here rather than taken unilaterally.

**The argument for changing it (BE.1's sharpening, and the strongest form of
it).** Under presence filtering the schema is derived from what *other people*
have sold. The moment anyone creates the first eBay · DE listing, an extra cap
appears on the master sheet for every DE operator — **a constraint that tightens
under an operator who did nothing, on a record they were already editing.** A
presence-derived schema is a schema that changes when someone else sells
something. That holds today and does not depend on any market being populated,
which is what makes it a better argument than the 147-vs-142 observation it came
from.

### §15.4 `#321` — refuted at the premise (lane-adjacent, nothing changed)

Reported (read, not executed): in `product-analytics.service.ts:181`, a
GLOBAL-channel listing stored with `marketplace: null` yields the key
`"SHOPIFY:"`, so `marketplace` is `''`, `'' || undefined` is `undefined`, and
Prisma drops the term — widening the buy-box lookup to any marketplace on that
channel.

**Measured before touching it; the premise cannot exist.**

```
ChannelListing.marketplace   Prisma: String @default("DEFAULT")   Postgres: NOT NULL
BuyBoxHistory.marketplace    Prisma: String                        Postgres: NOT NULL
977 rows — marketplace NULL: 0, empty: 0
channels present: AMAZON 725, EBAY 252 (no SHOPIFY / ETSY / WOOCOMMERCE)
```

`?? ''` has a dead right-hand branch, so the key never ends in `:` and the filter
is never dropped. A GLOBAL listing, if one existed, would carry the column
default `"DEFAULT"` and narrow correctly.

**The prescribed fix would have been a regression.** `marketplace === '' ? null :
marketplace` matches **zero rows** against a NOT NULL column: it converts a
filter that always narrows correctly into one that silently returns nothing the
moment the branch became reachable. The analogy to the `NOT`-excludes-NULL family
carried the remedy across, but that family's fix depends on the column being
nullable and neither of these is. The dead defensive branches were left exactly
as they are — rewriting one against a premise nobody re-checked is how a wrong
fix lands. If `marketplace` is ever made nullable this becomes real.

**Larger fact found on the way, filed as an observation and deliberately not a
diagnosis: `BuyBoxHistory` has 0 rows.** Every buy-box price this service returns
is `null`, for every product, on every channel, today — independent of any filter
logic. Whatever populates that table either never ran or does not exist. I did
not trace the writer and do not assert a cause. Outside PES; with the Owner queue
as a collection gap.

The `orderBy` half of the report is accurate: `:156`'s `findMany` has none, so
`currentPrices` order is unstable across calls — cosmetic, not a defect.

### §15.5 `#327` — SR.1's three contract items

**(14) Write target on every field — confirmed, fixed, and it was mine.** SR.1
counted 5 of 97 drawer fields carrying "writes to the master record". Measured on
Amazon · IT: **7 of 142**. The cause is `if (!base) continue` — `values` omits a
cell entirely when it is blank, so routing shipped only on already-filled fields
and was missing on the empty field the operator is about to edit. Routing was
present exactly where it was least needed.

`resolveWriteRouting` is a pure function of `(column, coordinate)` — its third
parameter `aliasId` appears in the signature and is **never read in the body** —
so the answer cannot vary by row and belongs on the column. Fixed additively:
columns now carry `writeField / writeVerb / writeTarget / affectsAllChannels /
writable / writeBlockedReason`, **alongside** the per-cell copies, so no existing
consumer changes. Measured after:

```
master        147 cols  147 routed  {master/master: 147}
channel AMAZON 142 cols 142 routed  {master/master:34, channelListing/master:4, channelListing/channel:104}
channel EBAY    35 cols  35 routed  {master/master:33, channelListing/master:2}
per-cell routing unchanged (7/7 in every scope)
```

**Correction this forces to a headline I made earlier in this lane.** The `#169`
win — channel cells writable via `overrideData` — is an **Amazon** phenomenon and
barely reaches eBay:

```
AMAZON · IT  142 cols  storage {column:35, localizedContent:1, categoryAttributes:106}  channel-writable 108
EBAY   · IT   35 cols  storage {column:34, localizedContent:1}                          channel-writable 2
```

The eBay coordinate contributes **no category-attribute columns at all**, so its
sheet is master identity fields plus one localized field, and only 2 of 35 route
to the channel. Any figure quoted for "channel cells now writable" was counted on
Amazon's column set and must not be stated as a per-coordinate property. This is
the re-derivation that was flagged as owed and is now done.

**(8) A time reference on the Listings pane — the data exists, the contract does
not carry it.** `ChannelListing.lastSyncedAt` is in the schema (plus
`lastOverrideAt`, `competitorFetchedAt`, `feeFetchedAt`, `updatedAt`). The
studio's listing projection carries only `id, version, listingStatus,
isPublished, price, quantity, externalListingId, offerActive, follows` — no
timestamp. So PES.4 cannot render one today. Adding `lastSyncedAt` to the
projection is a one-line additive select. ⚠ Worth saying before it is rendered:
`lastSyncedAt` records when a sync last **ran**, which is not "last checked
against the channel" — presenting it as the latter would be a
displayed-value-that-is-not-what-it-says, so PES.4 should label it for what it
is or say what "last checked" would require.

**(10) `Check before listing` on Amazon · PL — real, and the same family as
`#294`, one endpoint over.** `previewPublish` (`sheet-publish.service.ts:75`)
builds its error from `page.coordinates`, which come from `getSheetRows` →
`getSheetColumns` **without** `includeEmptyChannels` — one of the three call
sites already measured in §15.3. PL yields zero coordinates, so the "known" list
is empty and the message ends at the colon. The first argument is also a category
error: `"AMAZON:PL"` is a coordinate key passed into a field named `market`, so
the sentence calls a coordinate a market.

**Not fixed here, deliberately.** The lane brief says *publish contracts
unchanged*, and the obvious fix is not message-only: passing
`includeEmptyChannels` would make PL · AMAZON **resolve** instead of throwing,
which changes what publish preflight accepts — that is a product decision about
whether an operator may preflight a coordinate carrying no listings (exactly the
create path). The contract-preserving half — populate the known list from the
marketplace rows and stop calling a coordinate a market — improves the error
without changing what is accepted, and is the piece I would take on the Owner's
word.

**(8) implemented — and what it will actually render.** `lastSyncedAt` is now on
the listing projection (additive; the shared `SheetListing` field is **optional**
because two other constructors build that type and a required field would break
them). Verified round-trip against the DB on a real row. But before PES.4 renders
it, the measured distribution platform-wide:

```
ChannelListing: 977 total
  lastSyncedAt NULL:            877  (90%)
  non-null range:  2026-06-07 → 2026-07-15
  synced in the last 7 days:      0
```

So the pane will show "never synced" for nine listings in ten, and a date roughly
seven weeks old for the rest. **Filed as an observation, not a diagnosis** — I
have not traced the writer and do not assert why. It is the same shape as
`BuyBoxHistory` at 0 rows in §15.4: a field the UI is about to give a confident
time reference to, whose data may not be being written at all. Worth resolving
*before* it is rendered, because "Last synced 7 weeks ago" shown next to a
listing that is live and selling is a statement an operator will act on.

### §15.6 `#353` — true per-cause totals on the sync queue

The console grouped causes client-side over the page it received, and `rows` is
capped at 200, so for any family with more than 200 queue rows the cause count
could never be complete. Fixed with `causes[]` + `causesTotal` on the page
response, computed over the **whole filter**.

**One classifier, not two.** The cause is derived in TypeScript
(`deriveFailureReason`), so a SQL re-implementation would be a second copy that
drifts from the one the row list uses — the two would then disagree about the
same data. Instead the query groups by the raw `(errorMessage, errorCode,
isDead)` triple and classifies each **distinct triple once**. Measured: 38,365
queue rows carry only **659 distinct triples**, so this is a small grouped read,
not a scan. Prisma's `groupBy` generic reports AND/OR/NOT as circular (TS2615)
against a `where` of this shape, so the **delegate** is cast rather than the
argument — rebuilding the scope filter in raw SQL would have been a second copy
of *that*, for the same reason.

**Verified on `normal-knee-slider`, the largest family (1,239 rows):**

```
rows returned  200 (cap)      counts.all 1239      causesTotal 1239   ✓ equal
service causes   unknown 1167 (1167 actionable) · throttled 52 (37) · rejected 20 (20)
SQL oracle       unknown 1167 · throttled 52 · rejected 20            ✓ identical
page-derived     unknown 199 · rejected 1                             ← the old answer
```

**The old answer did not merely undercount — it omitted an entire cause.** From
the 200-row page the console would have said *"2 causes across 200 writes"*; the
truth is *"3 causes across 1,239"*, and the missing one is **throttled (52 rows,
37 of them dead)** — rows that exhausted their retries while being throttled, so
the write never landed and nobody was told. A cause that is invisible because it
sorts below the page boundary is the worst case for this panel, since the
operator's conclusion ("only rejections here") is confidently wrong.

`actionableCount` is summed from the classifier's verdict per triple rather than
inferred from the reason, because the same cause is actionable or not depending
on whether that row can still progress. `sampleSummary` comes from the largest
contributing message so a one-off cannot speak for a cause carrying a thousand
rows.

**Observation, not a diagnosis:** 1,167 of those 1,239 rows classify as
`unknown` — "Failed with no recorded reason". They carry no error message at all.
Whether that is a lost-error-detail bug in the sync writer or genuinely empty is
outside this lane and I have not traced it.

### §15.7 `#364` — restore points, and why the obvious contract would have lied

`GET /products/:id/restore-points` — the instants a record can actually be
restored to, newest first, each carrying the fields changed. Additive; PES.4
consumes it in place of a free timestamp.

**Measured first, and the measurement changed the design.** 398 Product audit
rows across 83 products:

```
update 100 · imagePublishBulk 70 · imagePublishCompleted 46 · imagePublishStarted 38
imagePublishFailed 37 · soft-delete 30 · create 24 · hard-delete 24 · ai-draft.approve …
320 of 398 rows carry no field at all
```

The image-publish lifecycle (191 rows) plus create/delete record **that**
something happened, not which values changed — there is nothing to restore to.
A literal "list the distinct audit instants" contract would have offered those
as restore points. Measured consequence: one product with 23 audit rows yields
**0 restore points**, because all 23 are image-publish events; the naive version
would have shown 23 moments, every one restoring nothing.

**Two payload shapes are both real.** `{ field, value }` descriptors (bulk PATCH)
and multi-key maps like `{ "de.description": … }` (ai-draft). Reading only the
first is why `getCellHistory` silently skips those 320 rows. `fieldsChangedIn`
handles both, checks the descriptor branch **first** (a descriptor read as a map
reports the literal keys `field`/`value`), and is pure + exported for tests.

**No time window is invented.** Rows sharing an exact millisecond are one moment;
measured, only 1 instant in the whole table carries multiple rows, so clustering
by proximity would merge genuinely separate edits for no benefit.

**`restorable` is the honest half.** `POST /restore` accepts master scalar
columns only, so a moment that changed `attr_ceCertification`, `de.description`
or `sku` is real history that cannot be written back. Each point carries
`fields`, `restorableFields` and `restorable`, so the drawer never offers a
restore the endpoint will silently decline. Verified: one product returns 23
points of which only 17 are restorable.

**One definition, not two.** The allow-list moved to
`services/pim/restorable-fields.ts` and `POST /restore` now imports it. Left
inline it would have been a second copy drifting from the list the drawer shows —
the same reason `#353` classifies through one `deriveFailureReason`.

Verified against an independent oracle (every non-event row with a readable
payload must appear): expected 11 instants, returned 11, identical.

### §15.8 `#366` — the history pane's own blind spot (same root, my reader)

`getCellHistory` took the field from `after.field` alone, so it skipped every
multi-key audit row — the same 320-of-398 rows `#364` had to exclude for a
different reason. Fixed to read both shapes through the same `fieldsChangedIn`,
with the descriptor branch first and the value read from `value` (descriptor) or
the field's own key (map). Reading `.value` on a map row yields `undefined`,
which would have rendered as "changed to (empty)" — worse than omitting it.

**What the pane was hiding, measured on `cmr1b1yxl0000s4rcvopsqv42` (sku
`AIREON`, a root product — NOT a GALE-JACKET variation):**

```
field             descriptor rows (shown)   map rows (skipped)
de.title                     0                     1
de.description               0                     2
attr_material                1                     1
description                  6                    11
```

`de.title` and `de.description` returned **nothing at all** — an AI-translated
cell whose history read as "never changed". But the dangerous one is
`description`: it showed 6 entries while missing 11, so the pane looked
populated and **65% of that cell's history was absent with no indication**. A
history that shows some entries is far more convincing than one that shows none;
this is the same "passes a spot check" shape as `lastSyncedAt`'s 100 plausible
rows and `#353`'s clean two-cause answer.

Also deduplicated while here: `fieldsChangedIn` had reimplemented the
"exactly `{ field, value }`" test that `audit-state.ts` already exports as
`asDescriptor`. It now calls it — a second copy of that predicate is precisely
what `#353` and `#364` avoided elsewhere, and I had introduced one in the act of
avoiding others.

Verified on `AIREON`: `de.title` 1 entry, `de.description` 2, `attr_material` 2,
`description` 17, unfiltered 24 — each carrying a real `next` value rather than
`undefined`. tsc clean.

**Confirmed independently over HTTP by PES.4** (`GET /studio/history`, the
transport the pane actually uses, against the same product): `description` 17,
`de.title` 1, `de.description` 2, unfiltered 24, byField identical item for item.
Worth having separately from the in-process reading — a reader can be correct in
process and still be wrapped in a route that drops or reshapes something.

⚠ **These numbers are AIREON's and do not generalise.** `GALE-JACKET`
(`cmokmy3a40078pm0p1fvnu523`) correctly returns unfiltered 11
(`manufacturer` x10, `name` x1) and **0** for `description` / `de.title` /
`de.description` — it has no map-shaped rows, so this fix changes nothing there.
An earlier version of this section said only "measured on one product" without
naming it, and a reader relaying it attached these figures to a GALE-JACKET id
and expected 17. **A measurement quoted without its subject is one hop from being
attached to the wrong one** — the same failure as a characterisation travelling
without its attribution, and the fix is equally cheap: name the id.

### §15.9 `#371` — the master-scope `name` width moves into the contract

Layout spec §9.3 rules master-scope `name` at 220. The field registry supplies
380 — a width chosen for the catalogue grid — and in the studio it is wrong for a
measured reason: every row of a family carries the SAME parent title (all 21
GALE-JACKET rows share an identical 100-char name), so at 380 the widest column
on the sheet is also the one that discriminates between rows least.

Applied in `getStudioSheet`, which `/studio/columns` also routes through, so both
endpoints agree — deriving it separately is how a grid ends up with a column its
rows never fill. PES.2's client-side `SPEC_WIDTHS` allow-list can now shrink to
nothing.

Verified: master `name.width` 220, channel scope **still 380**, 147/147 and
142/142 columns still carrying a width, tsc clean.

**Extended to EVERY scope** after UX.1 (spec owner) ruled §9.3c. Their
re-measure made the case stronger and corrected their own premise: eBay·IT's 21
`name` cells hold 3 distinct values, not 1, but they are byte-identical for their
first **127 characters** — and 380px shows ~45-50 characters while 220px shows
~26-30, so neither reaches the first difference. The extra 160px buys no
discrimination at all, and what does distinguish those rows already has its own
columns (Colore x Taglia). On the channel scope it also pays for itself: eBay·IT
measured 1,404px of columns against a 1,372px grid area, and 160px back takes it
to 1,244 — the first scope here to fit at 1440 with no horizontal scroll.
Verified: master 220, channel 220, 147/147 and 142/142 columns still carrying a
width, tsc clean.

The general lesson UX.1 drew, worth keeping: **a scope-limited number in a spec
is usually the limit of the measurement, not a decision.** §9.3 said "master"
because that is where it was measured, not because the channel had been ruled
differently.

### §15.10 `#382` — `maxLength` and `maxBytes` are BOTH real; neither is derived

Answer: **both are genuine, independently declared by Amazon.** The contract
should keep sending both, and the hub's ruling (enforce every declared cap, worst
verdict wins) is not just safe — it is required.

`schema-caps.ts:99-100` reads two distinct properties straight out of the cached
Amazon schema document — `maxLength` and `maxUtf8ByteLength`. Nothing in our
server computes one from the other; `pickTighter` only takes the stricter of two
**product types** when merging, never converts between characters and bytes.

**Measured across all 91 cached schemas**, which settles it better than the code
path does:

```
fields declaring BOTH        1,061
only maxLength               2,453
only maxUtf8ByteLength         185
neither                      6,723
distinct byte:char relationships where both are present: 14
```

Fourteen different relationships, ranging from `2000:50` (ratio 40) to
`2000:2200` (ratio 0.909). A derived value would show one constant relationship;
this is not derivation, it is two independent facts about the same field.

**Cases that decide client behaviour. ⚠ These are values OBSERVED somewhere in
the 91 cached schemas, not constants** — a cap is a property of
`(field, productType, marketplace)` and the same field differs between them
(`size` appears at 50 and 75; `style` at 2200, 120 and 100;
`age_range_description` at 1998 and 100). A fixture must name the schema it came
from, or it will be read as the value:

```
size                  maxLength   50   maxBytes  2000   → the CHAR cap binds; bytes unreachable
style / pattern       maxLength 2200   maxBytes  2000   → the BYTE cap binds even for pure ASCII
age_range_description maxLength 1998   maxBytes  2000   → either can bind, per AG.1's finding
product_description   maxLength null   maxBytes 20000   → byte cap is the ONLY cap
```

Measured on one real product (GALE-JACKET, `market=DE`) the same fields read
`size` 75 and `style` 120 — both readings correct about different sets, which is
the same subject-drift as §15.8 and cost another lane a reconciliation. **The
relationships are the finding; the numbers are examples.**

Also settled on that call, and worth stating because a contrary claim had spread
through three lanes: **the wire OMITS an uncapped unit and never sends `null`** —
`maxLength` absent 60 / value 36 / null 0, `maxBytes` absent 81 / value 15 /
null 0.

`style` and `pattern` are the ones worth showing an operator: the character cap
is **looser** than the byte cap, so a UI that displays "2200 characters" invites
a rejection at 2000 bytes on plain ASCII, before any accented character is
involved. A counter that shows only one number will be wrong on one of these
fields whichever number it picks.

And the cost of the alternative is measurable: **185 fields declare a byte cap
and no character cap**, so a client enforcing `maxLength` alone would leave every
one of them completely uncapped.

**`#395` — §9.3's three long-text widths, master scope.** AG.1's §9.3a landed (a
long-text cell renders its state as a mark with the counter in the tooltip), which
was the spec's stated condition, so `item_name`, `bullet_point` and
`product_description` now serve **110 on the master scope** through the same map,
via `getStudioSheet` so `/studio/columns` agrees. mtime 2026-09-02T04:01:49.

```
master          item_name 110 · bullet_point 110 · product_description 110
channel AMAZON              160 ·             160 ·                     160
channel EBAY                          all three ABSENT
```

**Extended to EVERY scope by UX.1 (§9.3d), and the split is gone** — mtime
2026-09-02T04:04:40, `SPEC_MASTER_ONLY_WIDTHS` deleted, all three keys now in
`SPEC_WIDTHS`. Verified: master 110/110/110 and Amazon 110/110/110.

Their reason is stronger than `name`'s and worth keeping: §9.3's argument was
never about the master scope. **160px cannot show a bullet point on any scope
either**, and in the sheet these cells' job is `empty · filled · near · over ·
unchecked`, not content — a fact about the FIELD KIND, fixed for all scopes when
§9.3a ruled the five marks. Where `name` needed a measurement to settle (the
three values differing at character 127), this one rests on what the cell is
*for*. There is no scope on which 160px starts showing a bullet point, so there
was nothing for a scope split to protect.

⚠ **Watch, do not pre-solve (UX.1).** The channel scope is the one place a cell
can carry **two** marks at once: §9.3a's long-text state and §9.6's provenance
mark when the value is `mapped` by a rule — at ~20px each, ~40px of a 110px cell.
Two states in a state cell is the design working, not a conflict. If the pair
does not read legibly at 110 on a real channel row, the answer is a combined mark
or a smaller chip, and the measurement goes to UX.1 — **not** 160px back, which
returns the cell to showing neither content nor state clearly, the state §9.3
exists to escape.

eBay carries none of these columns (its 35-column set has no category
attributes, §15.5), so this is a master-and-Amazon concern only.

---

Superseded note, kept for the reasoning: ⚠ **This reintroduces the split §9.3c removed, deliberately and visibly.** All
three columns exist in the Amazon scope identically (`longtext`, 160), so the
same column now serves two widths — and PES.2 has **deleted** their client width
map, so nothing downstream absorbs it. It is implemented as §9.3 rules rather
than extended on a prediction: UX.1's own lesson (*a scope-limited number is
usually the limit of the measurement, not a decision*) predicts they will say
"every scope", but a prediction is not a ruling. If they do, the three keys move
from `SPEC_MASTER_ONLY_WIDTHS` into `SPEC_WIDTHS` and the split disappears —
that is the entire change.

eBay carries none of these columns (its 35-column set has no category
attributes, §15.5), so §9.3a and these widths are a master-and-Amazon concern
only.


**`#415` — `capFrom` now set for ANY declared cap.** It was set only by
`tightest()`, which considers `maxLength` alone, so byte-only columns reached the
client with a cap and no source and §9.3a condition 1 (`near`/`over` must name
the channel imposing the cap) could render only a bare number. A byte cap has one
possible origin here — it is read from the Amazon schema — so where the character
cap set no source, the Amazon coordinate is it. Verified on GALE-JACKET DE: 96
columns, 37 capped, **37 carrying `capFrom`** (was 36), 0 uncapped columns
falsely carrying one, `product_description` now `{ maxBytes: 20000, capFrom:
"Amazon · DE" }`. Zero byte-capped columns name a non-Amazon coordinate, so the
one-`capFrom`-for-two-caps ambiguity does not arise today — it would only appear
if a character cap came from eBay on a field Amazon byte-caps.

**Generalisation checked, because "reliably present" is a stronger claim than one
call supports.** 3 products x 2 markets x 4 scopes = **24 combinations, 0
capped-but-unattributed columns.** ⚠ With one honest caveat: the eBay and Shopify
scopes carry **zero capped columns at all**, so the case that worried me — Amazon
caps surviving into a scope with no Amazon coordinate to name — is untested
because it does not occur, not because it was proven impossible. A consumer's
defensive branch for an absent `capFrom` should stay.

### §15.11 `D10` — headers are English on every scope; the marketplace term moves aside

Operator UI chrome is English (the Owner's standing rule: operators do not read
Italian or German; localization is for customer-facing listing CONTENT). The
header row was a mix — `Markenname · Description · Hersteller · Name · Artikelname
· Aufzählungspunkt · Gewebeart` — because `label` took the Amazon schema's title
first, and the dynamic `attr_*` fields are derived from the MARKET's schema, so
their titles are German on DE and Italian on IT.

**Contract change.** `label` is now always English. The marketplace's own term
moves to **`channelLabel`**, set only when it differs, so a header tooltip can
show the Amazon/eBay wording one hover away without every column carrying a
duplicate.

**English label resolution, in order:**
1. the static field registry — our own labels, already English;
2. a cached Amazon schema from an **English marketplace** for the same product
   type (`UK/US/IE/AU/CA`) — Amazon's own English wording;
3. `humanizeKey` — `fabric_type` → `Fabric Type`.

Step 2 is the part worth having: `AMAZON:UK` OUTERWEAR gives `item_name` = "Item
Name" and `fabric_type` = "Fabric Type" against DE's "Artikelname" / "Gewebeart".

**The fallback count, measured rather than estimated — and it varies by product
type, which is the point:**

```
GALE-JACKET · OUTERWEAR · DE   96 cols = 36 registry + 60 English schema +  0 humanised
GLOVES                   · DE   91 cols = 36 registry +  0 English schema + 55 humanised
productTypes with an English schema cached: 6 of 19
```

So the humanised fallback is **0% where an English schema exists and 60% where it
does not**, and 13 of 19 cached product types have none. Quoting a single rate
would be the §15.10 mistake again. `humanizeKey` is a last resort, not a
preference: it yields "Supplier Declared Dg Hz Regulation" where Amazon's English
schema says something better. **Fetching the 13 missing English schemas would
close the gap** — an SP-API call, deliberately not made on a page-load path.

**Verified** across 6 product/market/scope combinations (GALE-JACKET DE + IT,
GLOVES DE; master and Amazon channel): **0 labels containing non-English
characters** in every case, down from 13 on GALE-JACKET DE, with `channelLabel`
present on 60 / 63 / 56 columns respectively. Examples: `item_name` → "Item Name"
(ch. "Artikelname"), `brand` → "Brand" (ch. "Markenname"), `product_description`
→ "Product Description" (ch. "Beschreibung des Produkts").

⚠ The non-English-character check is a weak confirmation — a German word without
diacritics ("Hersteller") would pass it. The real guarantee is **structural**:
every label now comes from an English registry entry, an English-marketplace
schema, or an English key, so no path can produce a localized string.

### §15.12 `#449` / D14 — a declared column is a promise; every row carries every cell

**This is the Owner's "I'm unable to write a lot of attributes such as color", and
the write path was never the problem.** PES.3 proved the write works
(`PATCH attr_color target:channel` → `updated: 1`, v87→v88). The sheet never sent
it because the ROW had no cell: measured on XAVIA Amazon·IT, **97 declared columns
and 21 cells per row — 76 declared columns had no cell on any row**, `color`
among them. `values['color']` was `undefined`, so `isCellEditable` said false and
there was nothing to carry a reason.

Same root as `#327(14)`: `if (!base) continue` dropped every blank cell. That fix
put routing on the COLUMN; this one gives the row its cells.

**Fixed:** every declared column now yields a cell, empty where there is no
value, carrying the same routing as a filled one — so a client never synthesises
`writable`/`writeVerb`. Verified: Amazon·IT 97 cols / **97 cells per row**, master
102 / 102, 0 rows missing a cell, and

```
color → { value: null, writable: true, writeVerb: "channel",
          writeField: "attr_color", layer: "default" }
```

`layerFor` now takes `string | null` explicitly. It already returned `'default'`
for a null source, but only by falling through `default:` with a null that
compiles because this tsconfig has `strictNullChecks` off — right by accident
rather than by intent.

**Payload, measured not projected:**

```
Amazon·IT   44 KB/row   21-row family 932 KB   at 50 rows 2,218 KB
master      34 KB/row   21-row family 707 KB   at 50 rows 1,683 KB
```

⚠ **The 500-variation family in the ruling does not exist.** Measured across the
catalogue: largest family **50 rows** (`xracing`), mean 9.1, **none over 50**, 37
families. 50 rows is the real ceiling to design against.

**A large part of that cost is information the sheet was silently dropping.** Of
the 76 empty cells, **48 carry a DERIVED value** (`mapped`) that was invisible
before — 9.6 KB of the 33 KB the empty cells add. Same class as `#366`: the old
payload looked complete while omitting the layer that was the only content those
cells had.

**Slimming option, available whenever it is wanted.** Routing is **identical
across rows — measured, 0 of 21 columns vary** — so repeating it on every empty
cell is ~4 KB/row of duplication (~84 KB on a 21-row family). It already lives on
the column from `#327(14)`, so a client could read it there and the empty cell
could shrink to `{ value: null }`. Not taken here: the ruling asks for the cell to
answer for itself, and a consumer reading a column default is one indirection
from the bug this fixes.

### §15.13 `D11` — `apply-to-children` fan-out cost at 50 rows (analysis, no cascade run)

**Structure, which is what transfers between environments:**

| path | statements for a 50-row family (1 parent + 49 children) |
|---|---|
| children lookup | **1**, batched for all cascading parents regardless of family size |
| plain master field | 1 parent + **1 per child** = 50 (one update sets the value AND pushes `cascadedFields`) |
| `basePrice` / `totalStock` | 49 in-transaction `cascadedFields` updates **plus ~50 post-commit service calls** (MasterPriceService / applyStockMovement) |
| channel field (`isCh`) | 1 ChannelListing upsert **per child per marketplace context** — 98 at two contexts |

The cost driver is that `prisma.$transaction([...])` array-form runs **serially**,
so a cascade costs `statements × round-trip`, linear in family size.

**Measured read-only** — a serial `$transaction` of N trivial `SELECT 1`s, which
costs exactly N round trips and writes nothing:

```
n= 1   52 ms          n=10   769 ms
n=25  2,848 ms        n=50  4,252 ms   (median of 3; range 2,059–7,137)
```

⚠ **That is this laptop reaching Neon over the public internet (~85 ms/statement)
and must not be quoted as the production cost.** On Railway, beside the database,
a statement is ~1–3 ms, so the same 50 statements are ~50–150 ms. The linear,
serial *shape* is the finding; the absolute number is an artefact of where it was
measured — the §15.10 lesson applied before anyone repeats it.

**A verified reduction is available for the plain-field path.** All 49 children
receive the SAME value, and `updateMany` supports the scalar-list push — checked
in the generated client, `ProductUpdateManyMutationInput.cascadedFields` accepts
`ProductUpdatecascadedFieldsInput` which has `push`. So:

```ts
prisma.product.updateMany({
  where: { id: { in: kids } },
  data: { [field]: value, cascadedFields: { push: field } },
})
```

collapses **49 statements into 1**, taking a 50-row master-field cascade from 50
round trips to 2. Not implemented here: it is a write-path change and deserves
its own decision, not a side effect of answering a cost question.

The channel path does **not** collapse the same way — each child's upsert targets
its own `(productId, channel, marketplace, aliasKey)` coordinate — so 98
statements at two contexts stands until someone wants a bulk upsert written by
hand. That is the path to watch, not the master-field one.

**`D11` implemented — the plain-field cascade is one statement.** The per-child
loop is now a single `updateMany`; every child receives the identical value and
the identical `cascadedFields` push, so the two express exactly the same thing.

**Acceptance on the GALE fixture (21-row family, `manufacturer`), run on the old
code and the new and diffed:**

```
old  status 200  updated 1  affectedChildren 20  all 21 rows carry the value
new  status 200  updated 1  affectedChildren 20  all 21 rows carry the value
resulting state (values + cascadedFields arrays): BYTE-IDENTICAL
UPDATE statements against Product during the cascade:  21 → 2
```

The fixture was captured before each run and restored **exactly** afterwards —
including `cascadedFields`, which is a PUSH, so a naive revert would leave the
array longer than it started. Restoration verified byte-identical after all three
runs.

⚠ **Wall clock did NOT demonstrate the improvement and is not claimed as
evidence**: the three runs took 3,037 / 7,386 / 1,963 ms, with the *new* path
slowest on one of them. That spread is the laptop-to-Neon link, the same noise as
§15.13's 2,059–7,137 ms at n=50. The finding is the **round-trip count**, which is
environment-independent; the latency win is a prediction for Railway, not
something these numbers show.

### §15.14 `#467` — the column order is pinned

The emitted order followed the schema cache, so the Owner's on-screen arrangement
moved whenever a schema was refetched. Two sources, both removed:

1. `rows` arrived `orderBy fetchedAt desc`, so a family spanning more than one
   product type reordered its blocks when one type refreshed. Narrow today —
   measured, **exactly 1 family has >1 product type** — but silent and unbounded.
2. Within a type, `Object.entries(properties)` follows the cached JSON document,
   so a re-ordered document from Amazon reshuffled the columns. **This is the one
   an operator actually meets**, and pinning only (1) would have left the
   complaint intact while looking fixed.

**The rule chosen: registry order first (the caller's own stable list), then
schema-derived fields sorted by `(productType, key)`.** It depends on nothing but
the field names, so it cannot move across deploys or cache refreshes. The sort is
applied only where the field list is built, not to the cap-merge input — cap
merging is order-independent (min / union) and reordering it would be a change
with no reason behind it.

**Verified:** repeated calls give an identical order (102 cols), and — the
decisive one — the same product types supplied in a **different input order**
produce an identical column order (111 cols both ways). Before the pin that was
exactly what `fetchedAt` could change under us.

⚠ A third check of mine — "the schema-derived block is contiguous and
alphabetical" — reported false, and **the probe was wrong, not the code**: it
classified registry vs schema-derived using its own `getAvailableFields` call,
which does not receive the same `channels` the service computes from coordinates,
so keys the service had from the registry were counted as schema-derived. Same
class as the `.key`/`.id` finder earlier. Determinism is established by the two
checks above, which test the property that was actually ruled.

### §15.15 `#473` — the formula fields on the cell contract

`formula?`, `formulaError?`, `dependsOn?` are on `StudioCellValue`, read from
`CellFormula` in **one batched query per sheet** (never per cell — a 97-column
sheet would otherwise be a query per cell per row). Coordinate matching uses
`''`, not `null`: those columns are NOT NULL with `''` as the "not scoped"
sentinel, because Postgres treats NULLs as DISTINCT in a unique index and
nullable columns would silently accept the same master formula twice. A
locale-specific row beats an all-locale (`''`) one.

**Absent, not null** (`#415`), verified: 0 of 102 master cells and 0 of 97 Amazon
cells carry any of the three today, **0 null-valued keys**, and the payload is
unchanged — master 34,472 B, Amazon 45,430 B per row, the same as before the
field was added.

**Rehearsed with a real `CellFormula` row on the GALE fixture, 7/7**, then
deleted (0 rows remaining):

```
formula reaches the cell · no leading "=" introduced · formulaError carried
ALONGSIDE formula · dependsOn is the array · the VALUE is untouched ·
sibling rows carry no formula · channel scope does not see a master formula
```

The last two matter because the row is keyed per product AND per coordinate; a
join that leaked either way would have looked correct on the one row I set.

**Two contradictions raised — BOTH now closed. Resolution, re-verified at
source rather than taken on report, is recorded after them:**

1. **Ruling (E) says `CellFormula` carries no `lastValue`. The applied prod table
   has one** — 15 columns including `lastValue`, measured via
   `information_schema`. The practical instruction is identical (never read it
   for display, and this contract does not), but the ledger records a fact about
   a shipped table that is false, and someone may later "fix" the model by
   dropping a column that exists on prod.
2. **Ruling (G) says an errored formula writes `null` to the value layer;
   PES.6 says "none was written — the cell keeps whatever it had".** Both cannot
   hold. The rehearsal shows what the second produces: a cell carrying a real
   value AND `formulaError`, which is exactly the stale value D16.4 forbids
   ("never a stale value, never a silently invented one"). The write path is
   being built now, so this settles before it lands or it ships the forbidden
   state.


**§15.15 resolution (re-verified 2026-09-02, independently of PES.6's report):**

1. **`lastValue` is gone — my observation was true when taken and stale within
   minutes.** Ruling (E) landed after `20260902a` had created the table, so
   `20260902b_pes6_wave4_cellformula_no_lastvalue` dropped the column. Measured:
   `CellFormula` is still **15 columns** — `… expr, dependsOn, lastError,
   version, updatedBy, createdAt, updatedAt, evaluatedAt` — with **no
   `lastValue`** and `evaluatedAt` in its place; both migrations `finished`; 0
   rows. **The unchanged column count is what made it look untouched — one
   dropped, one added.** A count is not a set: the same trap as reading a total
   and calling it a match. The ledger was right and the table was briefly out of
   step, not the other way round.

2. **(G) wins and is implemented.** Verified at source, not on report:
   `mapping/cell-formula.service.ts:309` —
   `await writeValue(input, outcome.error ? null : outcome.value)` under the
   comment `(G) — an errored formula CLEARS the value`; the same at `:438` in
   `reevaluateDependents`, and `:332` returns `value: null` on error. So the
   state I rehearsed — a real value under an error mark — **cannot be produced
   by the write path**. The real state is `formula` present + `formulaError`
   present + `value` **null**, and it is common (a cap, a closed list, a required
   check). The contract already carries all three faithfully; nothing changed
   here.

### §15.16 `(H)` + `#483` — restore verb on the point, and no more guessed scope

**(H) `restoreVia: 'master' | 'formula'`** is on every restore point. A
`formula.pinned` point restores through the formula path, not by writing a master
field, and the drawer must not infer the verb by parsing `action` — a client
doing that would silently pick `'master'` for any future formula action nobody
told it about. One consequence handled with it: `restorable` for a formula point
is no longer vetoed by `RESTORABLE_MASTER_FIELDS`, which is master scalars only —
`attr_color` is not a master column and a formula on it is still restorable, so
without this every formula point on a non-scalar field would have arrived
`restorable: false` and the drawer would have correctly refused a restore that
does exist.

**`#483` — the two endpoints disagreed, which is the root the ruling did not
name.** Measured before changing anything:

```
sheet    ?market=IT&channel=AMAZON   → 200, scope=master      (channel ignored)
columns  ?market=IT&channel=AMAZON   → 200, scope=channel/AMAZON (inferred)
```

The same query string, two different answers from one contract. `/studio/sheet`
required an explicit `scope` and silently dropped the channel; `/studio/columns`
inferred `scope=channel` from it. PES.3 read `writeVerb: "master"` off the first
and nearly filed a false finding — the silent misread is the damage, and it was
reachable only because the two halves had drifted apart.

Both now refuse it: **400 `ambiguous_scope`**, naming the missing parameter and
echoing what was received. A caller who names a channel has said what they want;
guessing either way hands them a plausible wrong answer, which is worse than an
error. After: both endpoints 400 on the ambiguous form and both 200
`scope=channel/AMAZON` on the explicit one.

### §15.17 `#485` — the server does NOT enforce caps; closed lists it does

Measured on the GALE fixture through the real write path, then reverted (both
layers verified restored):

```
🔴 ACCEPTED  master `name`, 5,000 chars           → 200, updated 1, stored at 5,000
             ⚠ CORRECTED: `name` has NO cap — see §15.18. `item_name` is the
             capped column (200); my probe fell back to it with `??` and I
             reported one column's cap against another's value.
🔴 ACCEPTED  channel attr_ceCertification, 5,000  → 200, updated 1, stored in overrideData
✅ refused   channel attr_armorType, off-list     → 400 "Must be one of: Level 1, Level 2, No Armor"
```

**Closed lists are guarded; length caps are not guarded at all** — neither unit,
neither layer, no path. `grep` finds **zero** occurrences of `maxLength`,
`maxBytes` or `maxUtf8` in `products.routes.ts`, and the write confirms it: the
sheet shows a cap the server does not hold anyone to. A paste or a fill-handle
drag writes over-cap values straight to the database, where they wait to fail at
publish.

**Blast radius of enforcing it: zero, measured.** Nothing stored today would be
rejected — 0 of 338 products exceed the `name` cap (200), 0 of 8 checkable master
attributes exceed theirs, 0 channel overrides. ⚠ The attribute samples are thin (8
and 0 checkable values), so the solid figure is `name`: 338 rows, none over. The
guard is protective, not a cliff.

**What wiring it costs, stated because it is not a one-liner.** The write path has
no cap source: `FieldDefinition` carries no `maxLength`/`maxBytes` (the registry
never did), so the closed-list check's `getFieldDefinition` cannot answer it. Caps
live in the schema caps the sheet reads. Enforcing "the same rule the sheet shows"
therefore means resolving each product's `productType` in the write path and
reading the cached cap set for `(marketplace, productType)` — one cached read per
request, and it must use the SAME source as the sheet or the two will disagree
about the number they show and the number they enforce, which is worse than no
guard at all.


### §15.18 `#489` — the cap guard, and a measurement error of mine underneath it

**The guard is in and verified**, enforcing from `getSheetColumns` — the same
function the sheet displays from, never a second cap table — in both units, with
`n > cap` over and a value exactly AT the cap accepted:

```
attr_item_name, 201 chars  → 400  "201 characters — over the Amazon · IT cap of 200"
attr_item_name, 200 chars  → 200  accepted (at the cap)
attr_item_name, 5000 chars → 400
reverted, read back: clean
```

The refusal carries the sheet's own sentence and its `capFrom`, so an operator is
never refused against a limit their screen did not show.

⚠ **My first acceptance run reported 200 / 200 / 400 and I nearly filed the guard
as broken. It was not — I was testing uncapped fields.** `name` has **no cap**;
`item_name` is the capped column (200, `capFrom: "Amazon · IT"`), and
`ceCertification` is not in that column set at all. §15.17's headline — "a
5,000-character `name` stored where Amazon caps at 200" — came from a probe
written as `capOf.get('name') ?? capOf.get('item_name')`: **the `??` silently
substituted a different column's cap**, and the blast-radius figure ("0 of 338
over the name cap") was measuring `name` against `item_name`'s limit.

The finding that survives is narrower and still real: **the write path enforced no
length cap at all**, which the `attr_item_name` case proves — 5,000 characters
went in before this change and is refused after. What does **not** survive is the
`name` example, and the fallback that produced it is the same shape as the
`.key`/`.id` finder — **a `??` between two lookups is a silent substitution when
the first is legitimately absent.**

**Also fixed here, a regression I introduced with D10.** `pim-sheet-columns.test.ts
> matches a variation axis against the LOCALISED label` failed: `scopeFor` matched
the axis against `label`, which D10 made English, while a product's variation axes
are stored in the market's language ("Colore", "Taglia"). Every axis column had
silently become `global`. It now matches BOTH the English label and the localised
one — the axis is a fact about the product, not about the language the header is
drawn in. 24/24 pass.

### §15.19 `#504` — a real pin produced NO restore point, and my 8/8 proved nothing

The production writer records a formula pin as
`before: { formula: "<expr>" }`, `after: null`, with the field in
`metadata.fieldKey`. `fieldsChangedIn` tries descriptor-on-after,
descriptor-on-before, then map-on-after — **misses on all three**, returns `[]`,
and the row was discarded as unreadable *before* it could reach the formula
branch. So `restoreVia`, the `formula` projection and the un-merging all worked
on a row that never arrived.

Fixed: for `formula.*` actions `metadata.fieldKey` is authoritative and the row
is a restore point whatever the descriptor looks like; `expr` falls back to
`before.formula` when metadata omits it. The writer is unchanged — its metadata is
the richer record, and the reader was what was wrong.

⚠ **The §15.16 "8/8" verified nothing.** Both fixtures were hand-composed by me in
a shape the writer never produces (`after: {field, value}`, metadata without
`fieldKey`). The check measured my own assumption of the format —
`reference_inference_from_your_own_scaffolding`, and the sharpest instance of it
tonight, because the assertions were strong, specific, and all passing. **A
fixture I author tests my belief about the producer; only the producer's own row
tests the producer.**

Verified on rows the real writer created, across both products that have them:

```
product …uvz2ucxu   3/3 writer rows became points
product …1fvnu523   1/1
every formula row on GALE-JACKET is now a point (3 of 3) · 7/7 assertions
```

⚠ And my first run of that verification reported 2 failures that were **the
test's fault**: it collected writer rows across all products and checked them
against one product's points, so 3 of 4 could never match. Corrected to group by
product before comparing. Two self-inflicted false results in one fix is worth
recording: **when a check fails, the check is a suspect too.**

### §15.20 `#508` — the master read, and why the ruling needs narrowing

**(2) The Owner's number for queue item 29 is 1.** Measured across the catalogue:
only ONE key has both a legacy `Product` column and a `categoryAttributes` entry
— `brand` — and the attribute exists on exactly **one** product, where it
differs:

```
keys with a legacy Product column twin: 1 → brand
brand: attribute present on 1 product · differs from the column on 1
GALE-JACKET: column "Xavia" · attribute "XAVIA RACING WWW.XAVIARACING.IT"
```

This is not a systemic divergence; it is a single row. ⚠ And it may be a
**mis-keyed value rather than two legitimate brands**: that exact string is
GALE-JACKET's `manufacturer` column value. Someone appears to have written the
manufacturer into the brand attribute. Worth the Owner seeing before they rule on
canonicality — the question may be "which is the mistake", not "which wins".

**(1) The divergence is confirmed, and it is the direction PES.6 described:**

```
sheet   brand → source masterColumn, value "Xavia"
resolver brand → "XAVIA RACING WWW.XAVIARACING.IT", source master
```

So the sheet shows one value and what publishes is another.

⚠ **But the fix as ruled — "switch to the resolver's master answer" for every key
with a column twin — would BLANK cells.** Measured on the same product:

```
resolver manufacturer → undefined      sheet manufacturer → "XAVIA RACING WWW…" (from the column)
```

The resolver does not answer for `manufacturer`, `name`, `productType` or the
other master columns; it answers for attributes. Switching those reads wholesale
would empty cells that are correctly populated today — a much larger blast radius
than the one row it is meant to fix, and in the worse direction (data
disappearing from the operator's screen).

**The narrow form that is safe:** prefer the resolver's master answer **when it
has one**, else the column, with provenance naming which layer answered. That
fixes `brand` on GALE-JACKET, leaves every other master cell exactly as it is,
and makes the sheet agree with what publishes wherever the two can differ. Raised
rather than taken, because "switch to the resolver" and "prefer the resolver when
present" are different changes and only the second is safe.

**`#508(1)` built in the narrow form.** `studio-sheet.service.ts` (mtime
2026-09-02T06:57:51) — a column-storage master cell now prefers the resolver's
answer when it has one and falls back to the legacy column otherwise, with
`source` naming whichever layer answered. Verified on GALE-JACKET, 7/7:

```
brand         → "XAVIA RACING WWW.XAVIARACING.IT"  source master  (was "Xavia"/masterColumn)
manufacturer  → unchanged, source masterColumn      NOT blanked
name          → unchanged        productType → unchanged
22 cells still filled · a product with no brand attribute still reads its column
```

The three "unchanged" assertions are the point: those are the cells the ruling's
original wording ("switch to the resolver") would have emptied. tsc clean.


**`#508(1)` built in the narrow form.** `studio-sheet.service.ts` — a
column-storage master cell now prefers the resolver's answer when it has one and
falls back to the legacy column otherwise, with `source` naming whichever layer
answered. Verified on GALE-JACKET, 7/7:

```
brand         → "XAVIA RACING WWW.XAVIARACING.IT"  source master   (was "Xavia"/masterColumn)
manufacturer  → unchanged, source masterColumn      NOT blanked
name          → unchanged        productType → unchanged
22 cells still filled · a product with no brand attribute still reads its column
```

The three "unchanged" assertions are the point: they are the cells the ruling's
original wording would have emptied.

### §15.21 `#513(3)` — the profile, and the cost is not where it was attributed

Measured **inside the request** (per-phase timers on `meta.phases`), on the real
50-row family `xracing`. **Conditions stated because a profile without its
machine is a measurement without its subject:** taken 2026-09-02 07:17:51, 1-min
load **2.89**, no tsc of mine running.

```
Amazon·IT (114 cols)  cold 4,155 ms   columns 1,787 · mapping 1,522 · family 409 · related 395 · formulas 31 · ROWS 11
                      warm 1,028 ms   mapping   654 · family  205 · related 113 · formulas 43 · ROWS 13 · columns 0
master    (119 cols)  cold 3,003 ms   columns 2,605 · family 255 · related 77 · formulas 52 · ROWS 14
                      warm   437 ms   family    302 · related  71 · formulas 49 · ROWS 15 · columns 0
```

**The row build costs 11–15 ms.** The ~5,700 field resolutions the 9,045 ms was
attributed to are **~1% of the time**, warm or cold. Recomputing values on every
read is not the problem.

The time is two things, and both are already understood:
1. **the per-market column build** — 1.8–2.6 s on the first read for a market,
   **0 ms warm** (the `getStudioColumns` cache does its job);
2. **the mapping resolve** — 1,522 ms cold / 654 ms warm, and only on a channel
   scope (master never pays it).

⚠ **The 9,045 ms figure does not reproduce.** I measure 4,155 ms cold and
1,028 ms warm for the same family and scope. The most likely explanation is that
it was taken during the saturation window (load 20+, the web serving `/` in 49 s),
which is the same contaminated-number failure as the 12.7 s market figures — and
the reason I held this profile until the machine was quiet. **D14.5's threshold
should be set from 4.2 s cold / 1.0 s warm, not from 9 s**, and re-measured on
Railway before it reaches the Owner.

The timers stay on `meta.phases`: a slow read now describes itself, rather than
needing someone to reproduce it under unknown conditions.

### §15.22 `D15.15` — the diff token is the job (service layer)

**`import-diff.service.ts`** — pure header parse (`key` / `key@channel:market:locale`,
D15.2), per-cell verdict, authoritative counts, and `computeImportDiff` which
reads the studio sheet per coordinate and **writes nothing**. So D15.1's
acceptance runs read-only.

**`import-jobs.service.ts`** — dry-run persists the computed diff AS the job
(`BulkOperation`, `QUEUED`, per cell: coordinate components, raw before/after,
verdict, pins); apply takes no file and no mode and replays the **stored** diff.
A second parse of the same file could answer differently (a schema refresh,
another operator's edit) and the operator would never know they approved
something else. Blank-cell mode is baked into the stored diff for the same
reason. `PARTIAL` is set whenever anything refused and is never reported as
`COMPLETED`. `applyStoredJob` takes its writer as a parameter so the service
never grows a second write path — the route hands it the ordinary bulk PATCH,
which already owns validation, the cap guard, CAS and the audit trail.

Per-cell CAS on `before`: a cell whose value moved since the preview is skipped
and recorded `refused — changed since the preview`, never written. Unapplied
previews go to `CANCELLED` by explicit cancel **and** by a sweep past
`expiresAt` — the sweep is the one that matters, because a drawer closed by a
crashed tab sends nothing and would otherwise leave a day-old diff applyable
against befores that have all moved.

**Store:** `BulkOperation` extended additively (`20260902c_pes5_bulkop_progress`:
`processed`, `total`, both nullable). Verified: 263 existing rows untouched, 0
carrying progress — a NULL means "never reported progress", deliberately not 0.
`status` is free text, so `QUEUED/RUNNING/REVERTED/CANCELLED` need no migration,
and the per-change `scope` lives in the `changes` JSON.

**11/11, including D15.1's mechanical acceptance:**

```
export the master view → re-import it unmodified
  189 cells · unchanged 189 · changed 0 · refused 0 · unknown 0 · unmatched 0
one edited cell → changed 1, wouldPin ⊆ changed, raw before/after + components
a malformed coordinate (`x@amazon`) is REFUSED, never guessed
an unknown column is reported and not applied
```

⚠ **That acceptance found a real defect on its first run: 42 spurious refusals.**
`diffCell` judged writability *before* asking whether the value differed, so every
read-only cell in a re-imported export came back `refused`. A cell that is not
changing needs no write and cannot be refused for one. Same-value now decides
first. An operator re-importing their own export would have been told 42 things
failed — the fastest way to teach someone the diff is noise. **This is exactly
what D15.1's "mechanical" test is for, and it earned its place on the first run.**

**Not yet done:** the dry-run / apply / poll / cancel ROUTES are not wired, so
IO.1's drawer still has nothing to POST to; and `applyStoredJob`'s write path is
unexercised. The service layer is verified, the endpoint is not — it is not
delivered until both are.

**`D15.15` routes wired and rehearsed — now delivered.** `product-studio.routes.ts`
and `import-jobs.service.ts` mtime **07:34:15**, api tsc clean. Four endpoints:
`POST …/import/dry-run`, `GET …/import/jobs/:jobId`, `POST …/cancel`,
`POST …/apply` (no body, no mode).

**Safety basis verified independently, not taken on report (#542c):**
`BULK_OP_APPLIED` maps to `product.updated` → a debounced cache refresh, and
`products.routes.ts` contains **no** `outboundSyncQueue` / `enqueueSync` /
`OutboundSync` reference at all. The bulk PATCH has no push path, so a rehearsal
write cannot reach a marketplace. That is the fact the rehearsal's safety rests
on — not a flag.

**Rehearsed on the GALE fixture, predictions stated first, 10/10:**

```
dry-run   → changed 1, refused 0, state QUEUED   ✓ predicted
          → AND WROTE NOTHING (value still null) ✓
apply     → COMPLETED, 1 applied, server-side read-back shows the new value ✓
re-apply  → 409 job_not_applicable (a preview applies once)
CAS       → value moved underneath a second preview → skipped
             "changed since the preview", state PARTIAL,
             and the moved value NOT overwritten ✓
restore   → all 21 rows exactly as captured ✓
```

⚠ **The rehearsal found a rough edge worth the fix it got:** re-applying returned
**500**. An operator double-clicking Apply would have seen a server error rather
than "already applied" — and a 500 invites a retry, which is the one thing that
must not happen on an apply. Now a typed `JobNotApplicableError` → **409** naming
the state.

**Residue, disclosed:** 2 `BulkOperation` rows (kept deliberately — they ARE the
job record) and the audit rows from the applied writes, which are immutable by
trigger. The product values were restored exactly.

### §15.23 `#542` + `#569` — four write-path defects, each measured first

**`#569` — the Owner's "unable to write attributes", root cause.**
`marketplaceContexts` served two purposes collapsed into one list: fan-out
targets for a CHANNEL write (needs `channel` + `marketplace`) and the marketplace
naming the REGISTRY to validate against (needs only the marketplace). A master
scope correctly sends `{ marketplace: "DE", locale: "de" }` with no channel — and
the channel filter dropped it, so `primaryContext` was null and
`getFieldDefinition` fell back to the static list where **60 of 60 master
`attr_*` columns refuse**. New pure exported `validationMarketplace()` reads the
marketplace BEFORE any channel filter; the channel-bearing list stays for
fan-out. Exported so a writability gate runs the SAME function the route runs —
a gate that reimplements it drifts, and the drift is a cell the UI calls writable
and the API refuses. **Rehearsed with the exact client body, 7/7**: accepted,
`updated: 1`, `weave_type` reads back from the master record, restored exactly.

**`#542(1)` — the refusal named the wrong thing.** An `attr_*` write with no
usable marketplace said *"Unknown or read-only category attribute"*, which is
false twice over and sent readers to the registry instead of the missing context.
Now it names the cause and does **not** default the marketplace from the
product's own market — that can differ from the schema the columns were built
against, and writing against a different schema silently is worse than refusing.

**`#542(3)` — the CAS token was a fiction on half the writes.** Measured on one
row: the prefixed route (`amazon_title` → `ChannelListing.title`) left
`version` at **64 → 64**, while the override-bag route took **64 → 65**. A client
holding v64 would pass CAS after a prefixed write and silently overwrite it. Both
paths now bump; re-measured 64 → 65 → 66.

**`#542(2)` — a cell advertised a write target it did not read from.**
`item_name` reports `writeTarget: channelListing`, `writeField: amazon_title` —
it writes `ChannelListing.title` — and the cell went on showing the master value
at `layer: "master"`. **The reason was one level deeper than the read logic:
`LISTING_SELECT` never selected `title`, `description` or `variationTheme`,** so
the projection could not see the column the prefixed route writes. Selecting them
and reading through the routed field: the cell now shows the written value at
`layer: "channel"`. An operator writing and seeing the old value has only one
honest reading — "my edit did not save".

All four rehearsed on the GALE fixture with the row captured and restored
byte-exact (version, title and `overrideData` all read back equal).

⚠ **Residue disclosed:** one probe wrote `attr_color` on Amazon·IT as a positive
control and I reverted it by removing the key — but I had not built the revert
into the probe, which is the habit that put four permanent rows in the audit log
earlier. Every subsequent probe carries its own restore. The applied writes also
left immutable audit rows, and `Product.version` advanced where a write bumped
it; neither is revertible and neither should be.

**`#573` — one scope validator, both endpoints.** Measured before changing:

```
columns  ?scope=AMAZON   → 200 scope.kind=master      ← silent fallback
columns  ?scope=channel  → 200 scope.kind=master      ← valid but incomplete, ALSO silent
columns  ?scope=nonsense → 200 scope.kind=master
sheet    (all three)     → 400
```

`columns` ignored `scope` entirely. **A silent fallback to master is the worst
available answer**, because master is a plausible payload — nothing in it says
"this is not what you asked for", so comparing the two endpoints would have shown
master against master and read as agreement. The stricter endpoint is the only
reason the mistake surfaced.

Both now share `resolveScope`, and all six cases return the same 400 text; valid
requests unregressed (`master` 102 cols, `channel/AMAZON` 97, on both).

⚠ Typed as `{ error: {...} | null }` rather than a discriminated union on `ok`:
this package compiles with `strictNullChecks` off, so `if (!sc.ok)` does not
narrow and the union version **read correctly and would not compile**. The same
tsconfig property that hid the `layerFor(null)` case in §15.12.

### §15.24 `#577` — the route conforms to the ratified envelope; `dry-run` retired

`POST …/import/diff` (multipart CSV) replaces the JSON `dry-run` I built. The
service layer — diff computation, stored `QUEUED` job, CAS apply, cancel, sweep —
is unchanged and still as rehearsed; only the route's input and projection moved.

The CSV is parsed **server-side, beside the exporter**, so D15.2's label-row /
key-row convention lives in one place rather than in two implementations that
must agree forever. Row 1 (labels) is ignored; row 2 is the key row.

**Verified with a real multipart upload, 19/19**, and end-to-end through apply:

```
envelope: jobId · file{} · scope{} · columns[] · rows[] · counts · blankCells
          · unmatchedColumns · expiresAt · coverageNote
server parsed the file (3 rows × 3 cols) · label row ignored · 0 unmatched columns
rows NESTED and keyed by column, identity as COMPONENTS (productId/aliasKey/aliasResolved)
columns[] carries optionLabels on 20 columns · counts changed 1 · job stored QUEUED

end-to-end: diff → job · apply → COMPLETED 1/4 · read-back applied · poll agrees · reverted
```

⚠ **The substantive miss was mine and it was not a naming one.** D15.14.3 rules
that the CLIENT renders labels from the columns contract's `optionLabels` — a
ruling I argued for — and my route omitted `columns[]` entirely, so the client
**could not do what the ruling requires**: `country_of_origin` would have diffed
`PK → IT` instead of `Pakistan → Italy`. Shipping a ruling without the field that
makes it possible is the same shape as a contract naming a layer it does not
carry.

⚠ **And one thing worth recording for whoever checks conformance next: the
envelope field names are NOT in the ratified design.** §2's D15.13/14/15 define
verdicts, `pins`, raw `before`/`after`, identity-as-components, the job poll
shape and "the diff token is the job" — but `blankCells`, `unmatchedColumns`,
`coverageNote`, `file{}`, `scope{}` and multipart-vs-JSON appear nowhere in
`docs/2026-09-02-wave4-design.md`. They live in the client's verifier. I have
conformed to them because one shape is right and the client is written — but
"conform to the ratified text" could not be checked against the text, and the
next reader deserves the names written INTO the design rather than inferred from
a test.

### §15.25 `F1a` + `F6`

**F1a — the master refusal named a channel that does not exist.** Measured: 11
master DE/de columns said *"Read-only on this channel — the marketplace does not
accept a value for this field."* on a scope with no channel, sending the operator
to look for a channel setting to change. The sentence now depends on the scope:
master names the master record and the reason class, channel keeps its own.
`studio-sheet.service.ts` mtime **08:04:03**. After: master 11× *"Read-only on
the master record — this field is not editable by hand in this market."*,
Amazon·DE unchanged.

**F6 — the registry lookup cost 4.3 seconds, not "N re-parses".** Measured before:

```
per getFieldDefinition('attr_weave_type', {marketplace:'DE'}):  5235 / 4305 / 3921 / 3737 ms
each call loaded and re-parsed all 17 cached DE schemas
a 50-row cascade of ONE attr field ≈ 215 s in registry lookups alone
```

After memoising the parsed definitions per marketplace
(`field-registry.service.ts` mtime **08:07:29**):

```
call 1  20,335 ms   (cold — parses the 17 schemas once)
call 2      72 ms
call 3      88 ms
call 4      32 ms
call 5      31 ms     ← the residue is the freshness-stamp query (27-81 ms)
```

So a 50-row cascade goes from **~215 s to one cold parse plus ~49 × 70 ms**.

**Invalidation is the schema's own freshness stamp** — `max(fetchedAt)` PLUS the
row count for the marketplace — so a refresh changes the key and the parse runs
again. The count is in the key deliberately: a row deleted without any newer
fetch leaves `max(fetchedAt)` unchanged while the set has changed. A TTL would
have been wrong in both directions — stale after a refresh, and re-parsing for
nothing when none happened.

⚠ **The first measurement of the fix looked wrong and I did not ship it on that
reading.** It showed `4858, 3836, 160, 103` — the second call slow, as if the
cache missed. Rather than assume, I instrumented the stamp: it is stable across
calls and the cache hits from call 2. The slow second reading was machine
variance in that run. **A cache I could not explain is a cache I would have had
to defend later on worse evidence.**

Remaining cost, named rather than hidden: the stamp query is one round trip per
lookup (~70 ms), so a 50-row cascade still spends ~3.5 s there. A short
in-process TTL would remove it, at the price of a second staleness mechanism —
not taken, and offered rather than assumed.

### §15.26 `#600` — the import job's state machine, revert, and the wire vocabulary

`product-studio.routes.ts` and `import-jobs.service.ts` mtime **08:22:17**, api
tsc clean. **11/11 verified end to end.**

**(1) A job could strand in `RUNNING`.** `applyStoredJob` set `RUNNING` and the
route's sheet read threw afterwards, leaving `RUNNING, processed: 0` forever —
cancel refused it (not QUEUED), re-apply refused it (not QUEUED), and nothing was
running. Now every precondition runs in a `preflight` BEFORE the transition, and
any later throw moves the row to `FAILED` with its reason. **The ordering is the
fix, not the removal of `?market=`** — the next precondition to fail would not
have been `market`. Verified: a job whose precondition fails comes back **still
`QUEUED`**, retryable, not stranded.

**(2) Apply takes no query at all.** The coordinate comes from the job. Verified:
`POST …/apply` with no query → `completed`, the value landed.

**(3) `POST …/jobs/:id/revert` built** to D15.14.4 — per-cell CAS on the stored
`after`. Verified both halves: a clean revert restores the `before`; and a cell
**edited since the import is skipped** with `refused — changed since import`
while **the later edit survives**. That pair is the test — restoring correctly
proves nothing about the case where someone else has since typed in the cell, and
that is the case an operator cannot detect for themselves.

**(4) Wire vocabulary:** states lowercase (`queued|running|completed|partial|
failed|reverted|cancelled`) mapped from the DB enum in one place; verdicts
`written|refused|unchanged`; `expiresAt` on both diff and job, `revertibleUntil`
struck.

⚠ **The first run failed 7 of 11 and the cause was one layer in from the fix.**
Storing `scope{}` was not enough: a MASTER scope's `marketplace` is **null** — it
describes the coordinate, not the market the sheet was opened on — so rebuilding
the read produced `unknown_market` on an empty string. **The very failure that
stranded the job, reappearing inside its own fix.** The market is now stored as
its own fact. Had I shipped on "the scope is stored", apply would have worked on
channel scopes and failed on every master one.

**Stranded row cleaned by value:** `cmtjp1ggn0009njd0l3minkms` RUNNING → `FAILED`
with the reason recorded on the row (started and failed; `CANCELLED` would record
an operator's choice that was never made). **0 studio-import jobs remain in
`RUNNING` anywhere.**

### §15.27 Item 5 + 6 — derived `follows`, un-pin, counts, `schema`, master read-back

api tsc clean. **14/14 verified.** mtimes: `studio-sheet.service.ts` **08:31:08**,
`product-studio.routes.ts` **08:29:13**, `products.routes.ts` **08:28:29**,
`import-jobs.service.ts` **08:27:26**.

**D14.2 `follows` derived.** Before: 6 cells on Amazon against 63 channel-routing
columns, and on eBay **3 flags where only 2 columns route to the channel** —
`description`, `name`, `basePrice` write MASTER there, so the flag asserted a
relationship that does not exist. After: **63/63 Amazon, 2/2 eBay, 0 flags on any
master-routing column.** An explicit `followMaster*` column still wins where one
exists — that is stored intent; elsewhere it is the observable fact.

**D14.2 un-pin — `DELETE …/products/:id/overrides/:fieldKey`.** The write path
could SET an override and nothing could clear one; SC.1 removed W2's key with raw
SQL because no path existed. **A layer you can write and cannot clear is a
one-way door.** Verified: stale `expectedVersion` → **409**; the key is removed
and returned as `previous`; the **version bumps** like any other ChannelListing
write (#542.3); removing an absent key is a safe **no-op**, not an error, so a
retry after a partial failure cannot fail on its own success. Audited with
before/after, because an override that vanishes with no record is
indistinguishable from one never set.

**D14.3 counts, server-stated:** master `{total 2142, filled 441, empty 1701,
notWritable 278, pinned 1, mapped null}`; Amazon·IT `{2037, 483, 1554, 236, 86,
mapped 210}`.

⚠ **`mapped` is `null` on master, not 0** — and my first pass got this wrong. The
enrichment only runs for a coordinate, so master never counts mapped cells at
all; emitting 0 would answer a question nobody asked. `null` also covers the
resolver having timed out. **0 is a real answer, so "not counted" cannot share
its value** — which is the whole point of the ruling, and I nearly shipped the
version that made them the same.

**#558 `schema: { marketplace, locale }`.** Verified on master: `schema.marketplace`
is `DE` while `scope.marketplace` is `null`. A client could not otherwise say
which marketplace's schema produced its columns — the contract-level twin of the
`#600` bug, where the same missing fact broke apply on every master job.

**Item 5 — master `currentVersion` read back.** Was `expectedVersion + 1`, under a
comment of my own explaining why computing is wrong: I fixed the channel half and
left this one. Verified: response `21`, row `21`, `versionOf: 'product'`
unchanged. The arithmetic holds only while the CAS bump is the only bump — which
is precisely the case a concurrency token exists to detect the absence of.

**Filed for later, not built:** `Timing-Allow-Origin: *` on the DEV API only,
env-gated — PES.2's Resource Timing reads zero cross-origin.

### §15.28 Item 7 + the dev timing header

**Item 7 — a revert that skips a cell is `partial`, not `reverted`.** `reverted`
on a job whose values are still applied is a **lie by state**: it tells the
operator the undo completed when the part that did not complete is precisely the
part someone else had edited — the part they most need to be told about. Same
rule apply already followed. `phase: 'apply' | 'revert'` is stored and returned,
because a job can now be `partial` **twice for different reasons** and the state
alone cannot say partial at what.

**7/7 verified:**

```
clean revert                → state reverted · phase revert · 0 refused
revert with a skipped cell  → state partial  · phase revert
poll agrees                 → partial / revert
the later edit survived     → "TOUCHED-AFTER"
```

⚠ **The poll dropped `phase` and the verification caught it.** Apply and revert
both returned it; the poll handler builds its own object and never included it —
so a panel that polls rather than reading the apply/revert response would show
"partial" with nothing to say partial at. **The exact gap `phase` exists to
close, reopened one handler over.** Fixed in a third save (08:40:34).

**`Timing-Allow-Origin: *` — dev-only, two gates.** `index.ts`'s existing
`onSend` hook, where the other headers are set (deliberately after the handler,
so a route cannot silently overwrite it):

```
NODE_ENV !== 'production'  AND  NEXUS_ENABLE_TIMING_ALLOW_ORIGIN === '1'
```

**The env flag is not redundant with `NODE_ENV`.** This API runs in contexts
where `NODE_ENV` is not reliably `production` — a staging box, a container with
the var unset, a `railway run` shell. A missing variable must produce "no
header", never "header on production", so **enabling it is the deliberate act
rather than disabling it.**

**Three readings, and the third is the one that counts:**

```
dev + flag=1                → *
dev, flag unset             → (absent)
PRODUCTION + flag=1         → (absent)   ← would matter, and nobody would notice it broken
```

Run recipe: `NEXUS_ENABLE_TIMING_ALLOW_ORIGIN=1` on the dev API only.

Saves sequenced deliberately — `import-jobs.service.ts` **08:39:01**, `index.ts`
**08:39:13** — twelve seconds apart, so a lane using the restart as a stimulus
gets two clean transitions instead of one ambiguous mid-reload window.

### §15.29 Item 8 — the diff runs the write path's validation, not a copy

`products.routes.ts` **08:54:43**, `import-diff.service.ts` **08:55:09**,
`product-studio.routes.ts` **08:55:24**. api tsc clean. **9/9 + the control.**

Measured before: `status=NOT_A_STATUS` previewed as `changed`, applied, and was
refused only at write time. The safe direction — nothing bad was stored — but **a
preview that promises a change which cannot happen is the one thing a preview
exists to prevent.**

**The design point is what "one validator" had to mean.** The write path's
validation is a ~600-line inline block; extracting it is a refactor of the
hottest write path, and **any function written to "do what it does" is a mirror
by construction** — right the day it is written, wrong the first time either copy
is edited. So the diff calls the write path itself with `dryRun: true`, which
returns between the end of validation and the transaction. The refusal sentences
are not paraphrases; they are the write path's own strings.

```
closed-list miss → refused · "Status must be one of ACTIVE, DRAFT, INACTIVE"
counts follow    → {unchanged 1, changed 0, refused 1, wouldPin 0}
D15.1 still 0/0  → {unchanged 147, changed 0, refused 0}
```

**The dry run's guarantee is structural, not a field.** This codebase has already
shipped a `dryRun` that was accepted, logged, echoed back and never forwarded, so
the flag read as honoured while the write happened. The early return therefore
sits **above every write in the handler**, including the `BulkOperation` row the
empty-validation branch creates. Verified as an **absence of effect**:

```
row values      unchanged      Product.version   24 → 24
AuditLog rows   493 → 493      BulkOperation     345 → 348 (exactly the 3 stored previews)
```

⚠ **One of my nine assertions was weak and I caught it in review, not in the
run.** "A valid value still previews as changed" passed with verdict
`unchanged` — because the value I chose already matched. **Had the validator
refused everything, that test would still have passed**, and so would the
closed-list test. Added the positive control:

```
status = DRAFT          → changed   (valid AND different)
status = NOT_A_STATUS   → refused
the row is still ACTIVE — neither preview wrote
```

A refusal test alone measures nothing: it passes on a validator that works and on
one that refuses everything. The pair is what separates them.

### §15.30 `#674` + `#675` — read = write store, and a no-op spends no version

**#674 — my regression from #508(1), and it was not staleness.** #508(1) made a
column-storage master cell prefer the resolver (which layers
`categoryAttributes` over the legacy column). That fixed the screen and left the
WRITE pointing at the column, so a `brand` PATCH landed in the column while the
cell went on showing the attribute — **permanently: no cache, no duration, a
different store.** The "staleness duration" nobody could measure did not exist.

Worse than display: `#641`'s reconcile reads that endpoint to resolve an unknown
write, so a landed `brand` write would have read back as the old value and
resolved `refused` — telling the operator to retype something already saved,
the exact lie `unknown` exists to prevent.

Fixed: the cell reads the column again, and where the resolver holds a
**different** non-blank value it carries `divergence { publishesAs, note }`
naming both. Verified: `brand` reads `masterColumn`; a `brand` PATCH **reads back
through the sheet in the same run**; the mark is **absent when the two agree** and
**present once they differ** — its absence is meaningful.

**#675 — a no-op write no longer spends a version**, bounded to callers carrying
`expectedVersion`:

```
same-value PATCH   → updated 0 · version 25 → 25 · BulkOperation 367 → 367 · AuditLog 506 → 506
mixed              → updated 1 · version +1 ONCE · the real change landed
tokenless          → updated 1  ← THE BOUND IS A BOUND
```

One consequence handled: with every cell a no-op, `validated` empties and the
route would have taken the "nothing survived validation" branch — **400 plus a
FAILED job row**, telling an operator their save failed because the value was
already correct. That is now a 200 `{ updated: 0, unchanged: n }`.

⚠ **A failing assertion that was the TEST's fault, not the code's.** "manufacturer
reads `masterColumn`" failed — because `manufacturer` is `null` on that row, so an
empty cell with `source: null` is correct. The honest control is a column field
that HAS a value: `name`, `sku`, `status` all read `masterColumn` and match the
database exactly. **A control asserted against an empty cell measures nothing** —
it would have failed identically on a correct and a broken implementation.
