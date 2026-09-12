/**
 * PES.3 — the wire contract of a CHANNEL SCOPE of the Product Edit Studio sheet.
 *
 * `docs/2026-09-01-product-edit-studio-layout.md` §1 "Channel scope (e.g. eBay · IT) — alias groups".
 * Hand-written mirror of what PES.5 serves, because apps/web does not import from apps/api. Asserted
 * against a live response, never assumed.
 *
 * ── What an ALIAS is ────────────────────────────────────────────────────────────────────────────
 * A product may be listed on the same channel×market MORE THAN ONCE — four eBay·IT listings of the
 * one jacket, each with its own title, its own category, its own ItemID. Those are its listing
 * ALIASES (①②③…). Every alias shares the SAME child SKUs and the SAME stock pool; only the channel
 * fields differ.
 *
 * Measured on prod 2026-09-01, this is not hypothetical — it is a workaround already in the data.
 * `GALE-JACKET` holds 20 children and eBay ItemID 257584954808, while `GALE-JACKET-ALT1/2/3` and
 * `IT-GALE-JACKET` are CHILDLESS parent Products each carrying one more real ItemID at quantity 0
 * and price 0. 22 such shells exist (6 ACTIVE, 16 DRAFT), all eBay·IT. They are the aliases this
 * scope makes first-class; adopting them onto the real parent is a separate, Owner-gated decision,
 * so this surface DISPLAYS them and never re-points an ItemID by itself.
 *
 * ── Where the layers actually live ──────────────────────────────────────────────────────────────
 * Layout §3 originally routed per-alias-per-variant values through `VariantChannelListing`. PES.3's
 * prod probes found that table at 0 rows, hanging off `ProductVariation`, itself 0 rows and marked
 * in the schema as "a deprecated empty table — variants live as child Product rows". PES.0 CORRECTED
 * §3 on that evidence; the layers are:
 *
 *   alias × variant  →  ChannelListing on the CHILD  Product row   (912 of 977 rows on prod)
 *   alias            →  ChannelListing on the PARENT Product row   (65 of 977)
 *   master           →  the Product rows themselves, via resolveAttributes()
 *
 * The alias entity itself is PES.5 §2: a slim `ProductListingAlias` table (label, position, status,
 * `adoptedFromProductId`) with a nullable `aliasId` FK on `ChannelListing`.
 */

/**
 * ── Re-derived, not imported (Owner decision 10, 2026-09-01) ────────────────────────────────────
 * "We are actually building everything from scratch. We must not make use of anything that already
 * exists in the UI." `app/products/_sheet/types.ts` describes the same server shapes and was read as
 * SPECIFICATION; these are declared here so this lane owns them outright and the old tree can be
 * deleted at swap time without reaching into this one. The DS (`design-system/**`) remains the
 * substrate and IS imported.
 *
 * ROW/LISTING-level readiness vocabulary — deliberately distinct from PES.1's SCOPE-level
 * `ready|warn|blocked|absent` chips. No lane maps one onto the other locally (layout §3).
 */
export type ReadinessState = 'ready' | 'missing' | 'errors' | 'live' | 'unlisted'

export type SheetColumnKind = 'text' | 'longtext' | 'number' | 'select' | 'boolean' | 'date'

/** `listing` (AM.1) — a store that exists only on the ChannelListing; such a column appears on channel scopes only. */
export type SheetStorage = 'column' | 'categoryAttributes' | 'localizedContent' | 'listing'

/** One column of a channel's field family, as the channel schema defines it. */
export interface SheetColumn {
  managedBy?: 'productMedia'
  shopifyField?: import('@nexus/shared/shopify-information').InformationField
  familyRules?: Record<string, { required: boolean; sortOrder: number }>
  validation?: Record<string, unknown>
  key: string
  /** What `PATCH /api/products/bulk` expects in `changes[].field`. */
  writeField: string
  label: string
  group: string
  /** Stable canonical group ID. Older server responses may omit it. */
  groupKey?: string
  kind: SheetColumnKind
  storage: SheetStorage
  scope: 'global' | 'per_variant'
  options?: string[]
  optionLabels?: Record<string, string>
  /** `strict` = the channel accepts only the list (an off-list value WARNS, never blocks). */
  mode?: 'strict' | 'open'
  requiredBy: string[]
  /**
   * Product types that define this column; empty/absent = every type (the shared `SheetColumnRule`'s
   * own reading). MEASURED on the live wire 2026-09-04: Amazon·IT sends it on 63 of 97 columns,
   * eBay·IT on none. It was never mirrored here, so `columnApplies` — master's gate — could not see
   * it and this scope had no per-type gate at all.
   */
  applicableProductTypes?: string[]
  /** Types for which it is REQUIRED (the shared rule's `columnRequiredByAny`); Amazon·IT sends it, measured 2026-09-04. */
  requiredForProductTypes?: string[]
  maxLength?: number
  maxBytes?: number
  capFrom?: string
  editable: boolean
  /**
   * D16 — would the FORMULA writer accept this column on THIS coordinate (#756/#775)?
   *
   * 🔴 The server has been sending this all along and this mirror did not carry it, which is the
   * fourth wire→UI drift found today ([[reference_wire_parse_boundary_rules]]). It is not a copy of
   * master's flag: `studio-sheet.service.ts:1374` asks the writer that will actually enforce it, and
   * the two writers differ — a channel-routed column is gated by `isChannelWritable` (any mapped
   * field, any `attr_*`), a master-routed one by the `MASTER_WRITABLE` allow-list. Measured on the
   * wire 2026-09-02: **73 of 97 columns writable on Amazon·IT against 12 of 102 on master·IT**, and
   * eBay·IT reads master's 12 because `CHANNEL_FIELD_MAP` maps only three eBay fields. So this
   * varies by CHANNEL, not only by market — the axis next door to
   * [[reference_contract_field_varies_by_market]].
   *
   * ⚠ It is a COLUMN condition, deliberately not a row one: the channel write still throws when the
   * product has no listing on the coordinate, and the server does not encode that here. A cell can
   * therefore be `formulaWritable` and still be refused — which is why the refusal is rendered
   * verbatim and the text kept for correction rather than being treated as impossible.
   *
   * Absent means available (`formulaAvailability`'s ruling, #770), so an older server that does not
   * send it does not silently lock every column.
   */
  formulaWritable?: boolean
  width?: number
  helpText?: string
  defaultVisible: boolean
  deprecatedOptions?: string[]
  // ── AM.1 (2026-09-05) — the shape vocabulary, mirrored from `sheet-columns.service.ts` ─────────
  // All OPTIONAL: an older server omits them and every consumer must read absence as `scalar`.
  /** Default `scalar`. A `list` column's value is an array; a `measure` column's is `{ value, unit }`. */
  shape?: 'scalar' | 'list' | 'measure'
  /** list only. `max: null` = unbounded. A bounded list ≤ 10 arrives as slot columns instead. */
  cardinality?: { min: number; max: number | null }
  /** measure only. */
  unitOptions?: string[]
  /** This column is slot `index` (1-based) of the list `of`; the list itself is not a column. */
  slot?: { of: string; index: number; max: number; label: string }
  /** eBay: the aspect may vary per variation (informational — `scope` decides locking). */
  variantEligible?: boolean
  /** Every declaring channel hides it in its own UI. Still a column. */
  hidden?: boolean
  /** Each coordinate's own facts about this column, by coordinate label (`Amazon · IT`). */
  channels?: Record<string, {
    key: string
    attribute: string
    path: string[]
    label: string
    requirement: 'required' | 'requiredIfRelevant' | 'bestPractice' | 'optional'
    cardinality: { min: number; max: number | null }
    maxLength?: number
    maxBytes?: number
    options?: string[]
    mode?: 'strict' | 'open'
    store?: { kind: 'listingColumn'; column: string; followFlag?: string } | { kind: 'platformAttributes'; path: string[]; unitPath?: string[] }
    selectors?: string[]
    hidden: boolean
    editableOnExisting: boolean
    categories: string[]
  }>
}

/** The channels that can carry an alias group. Mirrors `SheetChannel` on the master sheet. */
export type ChannelScopeChannel = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Provenance — PES.5 §3.2 `StudioCellValue`
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The RAW per-cell source as `attribute-resolver.ts` reports it. PES.5 keeps sending this so the
 * drawer (PES.4) can name the exact origin; the SHEET reads `layer` instead.
 */
export type ChannelValueSource =
  | 'master'
  | 'masterLocale'
  | 'masterColumn'
  | 'variant'
  | 'variantLocale'
  | 'aliasOverride'
  | 'aliasExplicit'
  | 'channelOverride'
  | 'channelExplicit'
  | 'default'

/**
 * The layer the SERVER folds a cell to (PES.5 §3.2). This is the authoritative provenance — layout
 * §1's `🔗 / ✎` glyphs render from it, and the client no longer re-derives it.
 */
export type StudioLayer =
  | 'master'
  | 'variant'
  | 'alias'
  | 'aliasVariant'
  | 'channel'
  | 'linked'
  | 'default'

/**
 * What the SHEET paints. Layout §1's visible cascade is three states, not seven:
 *
 *   `aliasVariant`  ✎  pinned on this alias × this variant — the most specific
 *   `alias`         ✎  pinned on the alias, inherited by every variant under it
 *   `master`        🔗 inherited from the master record (or a link group)
 *   `unset`         —  nothing anywhere (the DS empty value, never a badge)
 */
export type CascadeLayer = 'aliasVariant' | 'alias' | 'master' | 'unset'

/** Where a write for this cell goes. Supplied by the server so the grid never re-derives it. */
export type StudioWriteTarget = 'master' | 'channelListing'

/** What `changes[].target` accepts on `PATCH /api/products/bulk` (§14). */
export type StudioWriteVerb = 'master' | 'channel'

/**
 * The mapping engine's verdict for one cell (PES.6's resolver, composed in-process by PES.5).
 *
 * Layout §1: "The sheet only SHOWS its results as `🔗` derived values with mapped/unmapped/error
 * status." So this is READ-ONLY here — the sheet never runs the engine and never computes `status`:
 * a constant or expression rule legitimately has an EMPTY `rule.source`, and anything inferring
 * mapped-ness from a non-empty source under-counts.
 */
export interface MappedCell {
  nexusDraft?: boolean
  requestedLocale?: string
  effectiveLocale?: string
  translationState?: 'current' | 'fallback' | 'draft' | 'reviewed' | 'outdated' | 'missing'
  needsTranslation?: boolean

  sourceOwner?: { kind: 'listing' | 'system'; label: string; path: string } | null

  supplyingRule?: { id: string; name: string; version: number; href: string }
  value: unknown
  status: 'mapped' | 'unmapped'
  provenance: string | null
  /** Resolver metadata for explaining origin; never evaluated by the browser. */
  sourcePath?: string | null
  fallbackPath?: string | null
  usesExpression?: boolean
  legacySource?: 'source' | 'fallback' | 'default' | 'missing'
  appliedTransforms: string[]
  warnings: string[]
  errors: string[]
  mappingErrors?: string[]
  autoCorrected: { from: string; to: string } | null
  requiredByRule: boolean
  overLimit: { chars?: number; bytes?: number } | null
}

/** PES.5 §3.2 — `SheetCellValue` plus the studio's provenance and write routing. */
export interface StudioCellValue {
  nexusDraft?: boolean
  requestedLocale?: string
  effectiveLocale?: string
  translationState?: 'current' | 'fallback' | 'draft' | 'reviewed' | 'outdated' | 'missing'
  needsTranslation?: boolean

  resettable?: boolean
  shopifyWrite?: import('@nexus/shared/shopify-information').ShopifySheetWrite
  value: unknown
  source: ChannelValueSource
  inheritedFrom: string | null
  /** True when the value comes from above and this row has none of its own. */
  inherited: boolean
  /** The server's fold — what the glyph renders from. */
  layer: StudioLayer
  /** This layer stores its own value (the ✎ glyph). */
  pinned: boolean
  /** `followMaster*` for the six flagged fields; null for everything else. */
  follows: boolean | null
  editable: boolean
  /** 🔗 when a `FieldLinkGroup` supplies the value. */
  linkGroupId: string | null
  /**
   * The mapping engine's verdict, or null in master scope / when the engine returned nothing for
   * this field. Sits BESIDE `value`, never replacing it: `value` is what is stored and resolved
   * through the cascade, `mapped.value` is what the rules would derive.
   */
  mapped: MappedCell | null
  /** What `PATCH /api/products/bulk` expects in `changes[].field`. */
  writeField: string
  writeTarget: StudioWriteTarget
  /**
   * The server's own `changes[].target` for this cell. **Echoed, never derived** (§14).
   *
   * 🔴 It is NOT what this lane sends any more (#697, hub-ruled). The writer keys `changes[].target`
   * on `writeTarget` — the row the write LANDS on — because that is what the endpoint uses the
   * field for: `hasMasterTargetedChange` (`products.routes.ts:2703`) decides which row's version the
   * CAS guards, while ROUTING for a non-`attr_*` field ignores `target` altogether
   * (`isChannelChange`, `:1354`). The six column-backed fields
   * (`{amazon,ebay}_{title,description,variationTheme}`) carry `writeTarget: 'channelListing'` with
   * `writeVerb: 'master'`, and sending the verb made every title/description save on a channel scope
   * CAS against the PRODUCT's version for a write that only touched the listing — measured on the
   * wire at 14:52 (`amazon_title`, `expectedVersion: 3`, listing at 82).
   *
   * The comment here used to say deriving one from the other "re-introduces exactly the bug this
   * pair exists to prevent" (a double route). Checked against the route before acting on it: the
   * write is a single `if/else if/else` (`:2536`), so there is no second route to fire. The field
   * stays because the server states it and a reader may want it; nothing on this lane sends it.
   */
  writeVerb: StudioWriteVerb
  /**
   * 🔴 BINDING (ruling #58): this write lands on the MASTER record, so it changes the value for
   * EVERY channel — not just the one on screen. The UI must say so before committing.
   *
   * Was `true` for 399 of the 441 cells on eBay·IT and is now **126** (§14): the override route
   * made 315 of them channel-local. The remainder are `storage: 'column'` master-truth fields —
   * sku, status, productType — which stay shared on purpose, so this warning is now rare and
   * meaningful rather than ambient.
   */
  affectsAllChannels: boolean
  /**
   * False when this cell must not be written at all — e.g. a row under a NON-PRIMARY alias, whose
   * write path is UNPROVEN until PES.5-ii. A blocked cell gets no edit and no cascade affordance.
   */
  writable: boolean
  /** The server's own words for why `writable` is false. Shown verbatim; never paraphrased. */
  writeBlockedReason?: string | null
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Rows — PES.5 §3.2 `StudioRow`
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `parent` is the family root's row FOR ONE ALIAS — the alias-level listing, which the sheet draws
 * as the group band. `variant` is a child SKU under that alias.
 */
export type StudioRowKind = 'parent' | 'variant'

export interface StudioRow {
  /** Multiple product owners can belong to one connected listing alias. */
  shopify?: import('@nexus/shared/shopify-information').ShopifySheetRow
  productMedia?: Array<{ id: string; type: string; preview: string | null; alt: string }>
  productMediaError?: string
  productRole?: import('@nexus/shared/master-sheet').ProductRole
  parentSku?: string | null
  familyId?: string | null
  /** The Product id. NOT unique across the grid — the same child appears under every alias. */
  id: string
  sku: string
  name: string | null
  parentId: string | null
  isParent: boolean
  status: string
  productType: string | null
  version: number
  childCount: number
  /** Which alias group this row belongs to. `null` = the PRIMARY listing (PES.5 §3.2). */
  aliasId: string | null
  rowKind: StudioRowKind
  values: Record<string, StudioCellValue>
  readiness: ChannelReadiness
  /** The master price, sent for every row. */
  basePrice: number | null
  /** This row's listing on this coordinate, or null when it has none. */
  listing: SheetListing | null
  /** Filled ÷ applicable master attributes — what the drawer's completeness footer reads. */
  completeness: MasterCompleteness
  /**
   * 🔴 THE FACE IMAGE — on the wire since before this lane rendered it, and missing from this mirror
   * (#709b). The server sends `imageUrl`, `photoCount` and `imageInherited` on every row of every
   * scope (measured: 21/21 on master·IT, Amazon·DE and eBay·IT), master declared and drew them, and
   * this type — a local MIRROR of PES.5 §3.2's `StudioRow`, not an import of it — did neither. The
   * Owner found it by looking at two scopes side by side: *"why don't I see the images here?"*
   *
   * Optional exactly as master declares them: a coordinate whose rows carry no picture is a real
   * state, not a contract violation.
   */
  imageUrl?: string | null
  photoCount?: number
  /** True when `imageUrl` is the PARENT's picture because this row has none of its own. */
  imageInherited?: boolean
  /**
   * What this row varies BY, as the server states it: `{"Size":"XS","Color":"Nero"}` (#721).
   *
   * The identity band's second line. Another field the wire has always carried and this mirror
   * never declared — the same drift as the image trio, found the same way (tsc, the moment a
   * renderer reached for it). The KEYS are the family's axis names, so they are the server's
   * vocabulary and not a fixed pair.
   */
  axisValues?: Record<string, string> | null
}

/** PES.5's `SheetListing` — the row's own listing state on this coordinate. */
export interface SheetListing {
  id: string
  /**
   * 🔴 The version a CHANNEL write must CAS against — the LISTING's, never the product's.
   *
   * Measured 2026-09-01: 868 of 977 listings (89%) carry a version differing from their product's,
   * so sending `StudioRow.version` here conflicts against the wrong number and 409s on a conflict
   * that never happened. A spurious conflict is worse than no CAS: it teaches an operator to
   * dismiss the one message that should always mean something.
   */
  version: number
  listingStatus: string
  isPublished: boolean
  /** #112 — operator offer control. Landed on the wire, so a verb can read current state. */
  offerActive: boolean
  price: number | null
  quantity: number | null
  externalListingId: string | null
  /** The six SSOT fields that have a follow flag; attributes have none. */
  follows: Record<string, boolean>
}

export interface MasterCompleteness {
  overall: { filled: number; total: number; pct: number }
  required: { filled: number; total: number; missing: Array<{ key: string; label: string }> }
  byGroup: Array<{ group: string; filled: number; total: number }>
}

/**
 * A row as this lane holds it: `StudioRow` plus the grid identity the tree needs.
 *
 * `rowId` exists because `id` is not unique — the same child SKU under three aliases is three rows,
 * and AG would collapse them into one node otherwise.
 */
export interface ChannelSheetRow extends StudioRow {
  rowId: string
  /** `AliasGroup.position` copied down, so a renderer never has to look the group up to draw ①②③. */
  aliasPosition: number
}

export interface ChannelReadinessIssue {
  key: string
  label: string
  message: string
  severity: 'error' | 'warn'
}

/** ROW/LISTING-level readiness (5-state). Never mapped onto PES.1's scope-level 4-state. */
export interface ChannelReadiness {
  state: ReadinessState
  /**
   * REQUIRED, matching the server (`SheetReadiness.issues: ReadinessIssue[]`). It was optional here
   * — a fifth field-drift found by #129's scan, and the one that blocked PES.4's dock from
   * accepting this row type at all. An optional mirror of a required field is not a harmless
   * loosening: every consumer then writes `?? []` and a genuinely absent array reads as "no issues".
   */
  issues: ChannelReadinessIssue[]
  ref?: string
}

/** PES.5 §3.2 — `AliasGroup.readiness`. */
export interface AliasReadiness {
  /**
   * 🔴 NULL when the schema declares no required field for this coordinate — there is nothing to be
   * ready against. The server is explicit that reporting `0` (alarming) or `100` (falsely
   * reassuring) would both be INVENTIONS, and PES.1's scope chips use the same convention.
   * Rendering it as 0% was a live defect here until the field-drift scan of #129 caught it.
   */
  percent: number | null
  state: ReadinessState
  errors: number
  warnings: number
  rowsMissingRequired: number
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The alias group — PES.5 §3.2 `AliasGroup`
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One listing alias.
 *
 * The PRIMARY listing is always `{ id: null, position: 0, label: 'Primary' }`, so this lane renders
 * ONE uniform list of groups and never special-cases the un-aliased rows (PES.5 §3.2). Every place
 * that keys on an alias therefore goes through `aliasKeyOf()` rather than using `id` raw.
 */
export interface AliasGroup {
  id: string | null
  label: string
  position: number
  status: string
  externalListingId: string | null
  /**
   * 🔴 NULLABLE, and measured rather than assumed. On a coordinate with no listing the server sends
   * `listingStatus: null` and `isPublished: null` (verified on eBay·DE, where the family has zero
   * rows) — my mirror declared both non-nullable, so `?? 'DRAFT'` type-checked as unreachable
   * defensive code when it was the live path, and the wire-null guard could not see the defect
   * either: the type said it could not happen.
   *
   * `reference_wire_parse_boundary_rules` — a local mirror of a server type drifts; add fields,
   * never relax the constraint. This is the same rule in the other direction: never TIGHTEN one
   * past what the wire actually sends.
   */
  listingStatus: string | null
  isPublished: boolean | null
  readiness: AliasReadiness
  /** The `StudioRow.id`s in this group. */
  rowIds: string[]
}

export interface ChannelScope {
  kind: 'master' | 'channel'
  channel: ChannelScopeChannel
  marketplace: string
  label: string
  connectionId: string | null
  locale: string
}

export interface StudioFamily {
  id: string
  sku: string
  name: string | null
  productType: string | null
  variationAxes: string[]
}

/** PES.5 §3.2 — the channel scope page. */
export interface ChannelScopePage {
  scope: ChannelScope
  family: StudioFamily
  columns: SheetColumn[]
  /** `[]` in master scope; one uniform list here, primary included. */
  aliases: AliasGroup[]
  rows: StudioRow[]
  readiness: unknown
  meta: {
    schemaMissing: string[]
    schemaAge: Array<{ productType: string; fetchedAt: string }>
    droppedKeys: string[]
    tookMs: number
    /**
     * The mapping run's own report. `productLevelOnly` is the honesty flag that matters to this
     * lane: mapping rules are global per (channel, marketplace, category) and the resolver is keyed
     * by PRODUCT, so every alias projection of one product currently shows the SAME mapped value —
     * a derived cell does NOT yet account for per-alias overrides. The sheet says so rather than
     * letting an operator read four aliases as four independently mapped listings.
     */
    mapping?: {
      productLevelOnly: boolean
      missingProductIds: string[]
      skippedReason: string | null
    } | null
  }
}

/**
 * The grid identity for a row.
 *
 * ⚠ There is deliberately NO family-total quantity anywhere in this lane. PES.5 §3.2: "Quantity is
 * per alias, never summed … The contract carries no 'total quantity' field precisely so no client
 * can invent one" (reference_oversell_is_per_channel_not_summed). Nothing here adds one up.
 */
export function aliasKeyOf(aliasId: string | null): string {
  return aliasId ?? 'primary'
}

/**
 * The alias key **as the write endpoint expects it** — `''` for the primary listing.
 *
 * 🔴 NOT `aliasKeyOf`, and the difference is a silent mis-write waiting to happen. `aliasKeyOf`
 * returns `'primary'` and exists only to build a SHEET ROW ID; the server stores `aliasKey = ''`
 * on a primary listing and names it in the upsert's `ON CONFLICT`. Sending `'primary'` would miss
 * the conflict target and INSERT a second listing rather than merging into the real one.
 *
 * Derived from the read contract's own mapping: `studio-sheet.service.ts:631` looks a listing up by
 * `${product.id}:${projection.id ?? ''}`, so `aliasId ?? ''` is the key by construction.
 */
export function wireAliasKey(aliasId: string | null): string {
  return aliasId ?? ''
}

export function studioRowId(aliasId: string | null, productId: string): string {
  return `${aliasKeyOf(aliasId)}:${productId}`
}
