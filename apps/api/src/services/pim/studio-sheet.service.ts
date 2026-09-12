/**
 * PES.5 — the Product Edit Studio's sheet read: ONE family, ONE scope.
 *
 * `docs/2026-09-01-product-edit-studio-layout.md` §1, `docs/pes5-phase0-backend.md` §3.
 *
 * The catalogue-wide master sheet (MS.1/MS.2, `sheet-rows.service.ts`) reads a
 * PAGE OF FAMILIES for a market. The studio reads ONE family, re-projected
 * through a scope:
 *
 *   master        — the stored truth. Rows = parent + children.
 *   channel×market— the same children, once per listing ALIAS, with each cell
 *                   showing which layer supplied it.
 *
 * It reuses that service's machinery rather than forking it: same columns, same
 * resolver, same readiness (now one definition — `readiness.service.ts`). The
 * shape of the work is unchanged and deliberately so:
 *
 *   1. the family                      <- one findMany
 *   2. its listings on this coordinate <- one findMany
 *   3. its aliases + link groups       <- two small findMany
 *   4. per row x column: pure
 *
 * No per-product round-trips. That is the rule the older per-product surfaces
 * broke and what made them unusable at sheet scale (project_master_sheet_gds4).
 *
 * ⚠ Quantity is PER ALIAS and is never summed. Three aliases of one product on
 * eBay·IT each draw on the same stock pool; adding them would advertise three
 * times the stock that exists (reference_oversell_is_per_channel_not_summed).
 * This module therefore emits no family-total quantity field at ALL — not even
 * a convenience one — so no client can accidentally render the sum.
 */
import { resolveAttributes, type ProductLike, type ChannelListingLike, type ResolvedAttributes } from './attribute-resolver.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { linkForCoordinate, type FieldLinkGroupLike } from './resolve-channel-field.js'
// PES.6's mapping barrel is imported LAZILY, inside the channel branch below.
// A static import pulls its transitive Redis-backed queue in at module load, so
// merely importing this service (master scope, a unit test, any consumer) would
// start connecting to Upstash and retry forever when it is unreachable —
// measured: the probe hung for two minutes emitting nothing but queue errors
// (reference_tool_registry_needs_redis). Types are `import type`, so they erase.
import type { ResolvedCell } from './mapping/resolve-batch.service.js'
import type { ResolvedCategory } from './mapping/category-mapping.service.js'
import { buildCoordinateValidators, evaluateRow, type FlatRow } from './readiness.service.js'
import { columnApplies, columnRequiredByAny, columnRequiredHere, columnForCategory, productRoleOf } from '@nexus/shared/master-sheet'
import { relationshipColumns, relationshipValues, RELATIONSHIP_GROUP } from './studio-relationships.js'
import { storedChannelState } from './channel-value-mutation.js'
import { shopifyDefinitionApplicability } from '@nexus/shared/shopify-linked-products'
import { UnknownMarketError, type SheetColumn, type SheetCoordinate, type SheetGroup, type SheetSpecCoverage } from './sheet-columns.service.js'
import { projectCellValue, readPath, isBlankValue } from './sheet-values.js'
import { pickFaceImage, FACE_IMAGE_SELECT, FACE_IMAGE_ORDER_BY } from '../product-read-cache.service.js'
import { mediaLocaleSchema, mediaObject, resolveMediaCollection } from '@nexus/shared/product-media'
import { getStudioColumns } from './studio-columns.js'
import { productCategoryContext } from './product-category-context.js'
import { isPrimaryChannelConnection } from '../connection-resolver.service.js'
import { categoryForListing } from './mapping/category-mapping.service.js'
import { savedAttributeFields } from './family-sheet-schema.js'
import { normalizeEbayListingValue } from './ebay-listing-values.js'
import { writerAcceptsField } from './master-field-gate.js'
import { completenessFor, decimalToNumber, type SheetCellValue, type SheetListing, type SheetReadiness, type ReadinessIssue } from './sheet-rows.service.js'
import type { MasterCompleteness } from './master-completeness.service.js'

// ────────────────────────────────────────────────────────────────────
// Types — the contract PES.2 / PES.3 / PES.4 consume
// ────────────────────────────────────────────────────────────────────

export type StudioScopeKind = 'master' | 'channel'

export interface StudioScope {
  kind: StudioScopeKind
  channel: string | null
  marketplace: string | null
  /** `Master` or `eBay · IT` — what the scope chip and messages say. */
  label: string
  connectionId: string | null
  locale: string
}

/**
 * Which layer supplied a cell. This is what the layout's provenance glyphs
 * render from: `master` -> the tinted link, anything pinned -> the pencil.
 */
export type CellLayer =
  | 'master'        // the family root's own value
  | 'variant'       // this child's own value, pinned over the parent's
  | 'alias'         // this alias's override, over master/variant
  | 'channel'       // a channel override on the primary listing
  | 'linked'        // supplied through a FieldLinkGroup
  | 'default'       // nothing anywhere

/**
 * What the global mapping engine (PES.6) would actually SHIP for this cell.
 *
 * Deliberately kept BESIDE `value` rather than replacing it. `value` is what is
 * stored and resolved through the master/variant/alias cascade; `mapped.value`
 * is what the mapping rules would send after transforms and enum
 * auto-correction. They differ whenever a rule transforms, defaults or corrects
 * — and the operator needs to see BOTH, because "what I typed" and "what ships"
 * disagreeing is the single thing this surface exists to expose. The layout is
 * explicit that the sheet only SHOWS mapping results (§1 Mapping); it does not
 * own them.
 */
export interface MappedCell {
  nexusDraft?: boolean
  requestedLocale?: string
  effectiveLocale?: string
  translationState?: import('./attribute-resolver.js').ResolvedValue['translationState']
  needsTranslation?: boolean
  sourceOwner?: { kind: 'listing' | 'system'; label: string; path: string } | null

  supplyingRule?: { id: string; name: string; version: number; href: string }
  value: unknown
  status: 'mapped' | 'unmapped'
  provenance: string | null
  /** Mapping inputs explain origin; the sheet never executes the rule itself. */
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

export interface StudioCellValue extends SheetCellValue {
  resettable?: boolean
  nexusDraft?: boolean
  shopifyWrite?: import('@nexus/shared/shopify-information').ShopifySheetWrite
  /**
   * The operator-authored formula for this cell, WITHOUT its leading `=`
   * (D16/#473). Absent — never null — when the cell has none (#415).
   *
   * The evaluated value lives in `value` like any other, so every existing
   * reader and publish path is unchanged; this is the expression behind it.
   * A client derives the `formula` provenance mark from `formula != null`;
   * nothing sends a provenance string.
   */
  /**
   * Set only when another layer holds a DIFFERENT non-blank value for this key
   * (#674). The cell shows — and edits — the layer the write targets; this names
   * the other one and what it means, rather than the sheet silently choosing.
   */
  divergence?: { publishesAs: unknown; note: string }
  formula?: string
  /**
   * Why the last evaluation produced no value. `formula` present WITH
   * `formulaError` present is a real and expected state — a formula whose
   * result was refused by a cap, a closed list, or a required check — so it
   * must not be collapsed into "no formula".
   */
  formulaError?: string
  /** The TRANSITIVE attribute closure the formula reads, not the direct refs. */
  dependsOn?: string[]
  layer: CellLayer
  /** True when THIS layer stores the value — the `✎` state. */
  pinned: boolean
  /** followMaster* for the six flagged fields; null for every other column. */
  follows: boolean | null
  editable: boolean
  linkGroupId: string | null
  /**
   * The mapping engine's verdict for this cell, or null in master scope / when
   * the engine returned nothing for this field. NEVER computed here: `status`
   * comes from PES.6, because `rule.source` can legitimately be EMPTY for a
   * constant/expression rule and anything deriving "is mapped" from a non-empty
   * source under-counts.
   */
  mapped: MappedCell | null
  /**
   * What `PATCH /api/products/bulk` expects in `changes[].field` — ALREADY
   * channel-prefixed (`ebay_title`) when `writeTarget` is `channelListing`.
   * The two always agree; sending the master field name with a channel target
   * would land the write on master, which is the whole failure this pair exists
   * to prevent.
   */
  writeField: string
  /**
   * Where an edit to this cell ACTUALLY lands. Derived from the TARGET layer
   * (where a write goes), never from `layer` (where the value reads from today).
   * A cell can inherit from master and still write to the channel — that is the
   * normal case for a channel override, and conflating the two is what made
   * every channel cell claim `master`.
   */
  writeTarget: 'master' | 'channelListing'
  /**
   * What to send as `changes[].target` on `PATCH /api/products/bulk`. Echo it
   * back rather than deriving it — the write contract is the mirror of this one
   * (#171.1), which is the whole reason `target` is a field and not a field-name
   * prefix.
   */
  writeVerb: 'master' | 'channel'
  /**
   * 🔴 TRUE when this cell is shown in a CHANNEL scope but writes to the MASTER
   * record — so an edit here changes every channel at once, not just this one.
   *
   * This is not a rare edge: `PATCH /api/products/bulk` can route only SIX
   * fields to a ChannelListing (`{amazon,ebay}_{title,description,variationTheme}`,
   * its `CHANNEL_FIELD_MAP`). Every other column on a channel scope — every
   * `attr_*`, every identity and logistics field — genuinely lands on master.
   * The UI must say so before the operator commits, rather than presenting a
   * channel-scoped grid whose cells quietly edit the shared record.
   */
  affectsAllChannels: boolean
  /** False when this cell must not be written yet; `writeBlockedReason` says why. */
  writable: boolean
  writeBlockedReason: string | null
}

export interface StudioRow {
  /** Multiple product owners can belong to one connected listing alias. */
  shopify?: import('@nexus/shared/shopify-information').ShopifySheetRow
  productMedia?: Array<{ id: string; type: string; preview: string | null; alt: string }>
  productMediaError?: string
  productRole?: import('@nexus/shared/master-sheet').ProductRole
  parentSku?: string | null
  familyId?: string | null
  id: string
  sku: string
  name: string | null
  parentId: string | null
  isParent: boolean
  /** Tree position: a legacy 'parent' band also represents a standalone listing. Use productRole for its product role. */
  rowKind: 'parent' | 'variant'
  status: string
  productType: string | null
  version: number
  basePrice: number | null
  childCount: number
  /**
   * The row's face image, for the pinned identity cell.
   *
   * Chosen by the SERVER-side `pickFaceImage` (isPrimary → first MAIN → lowest
   * sortOrder) — the same rule the drawer's client-side picker applies, so the
   * grid thumbnail and the drawer's main image cannot disagree. One rule, two
   * consumers.
   */
  imageUrl: string | null
  /** The row's OWN images. May be 0 while `imageUrl` is set — see below. */
  photoCount: number
  /**
   * True when `imageUrl` came from the PARENT because this row has none of its
   * own. Measured: 74 of 301 children (25%) have zero own images, so without
   * the fallback a quarter of rows would show nothing — and without this flag a
   * row would show a thumbnail beside `photoCount: 0` and read as a bug.
   * Tint it like any other inherited value.
   */
  imageInherited: boolean
  /**
   * This row's variation-axis values, e.g. `{ Color: 'Nero', Size: '3XL' }`.
   * `{}` when the row stores none — which is the common case on this catalogue
   * and must be rendered as absent, never inferred from the SKU.
   */
  axisValues: Record<string, string>
  /** null = the primary listing (or master scope). */
  aliasId: string | null
  values: Record<string, StudioCellValue>
  listing: SheetListing | null
  readiness: SheetReadiness
  completeness: MasterCompleteness
}

export interface AliasReadiness {
  /**
   * Required-fields-filled for this alias, or NULL when the schema declares no
   * required field here — there is nothing to be ready against, and reporting
   * `0` (alarming) or `100` (falsely reassuring) would both be inventions.
   * PES.1's scope chips use the same `null` convention.
   */
  percent: number | null
  state: SheetReadiness['state']
  errors: number
  warnings: number
  rowsMissingRequired: number
}

export interface AliasGroup {
  /** null = the product's PRIMARY listing, rendered as position 0. */
  id: string | null
  label: string
  position: number
  status: string
  externalListingId: string | null
  listingStatus: string | null
  isPublished: boolean | null
  readiness: AliasReadiness
  rowIds: string[]
}

/**
 * One variation axis of a family, as an EXPLICIT key→label map.
 *
 * `variationAxes` alone is a list of localised DISPLAY labels (`['Colore',
 * 'Taglia']`), and clients were string-matching those against value keys —
 * `'colore'.includes('color')` happens to hit, `'taglia'` vs `'size'` does not.
 * That is luck, not a mapping, so the pairing is done here once.
 *
 * ⚠ `coverage` is not decoration. The axis VALUES live in
 * `Product.variantAttributes`, and on this catalogue that is mostly empty —
 * rendering an axis column without checking coverage produces the very
 * emptiness the curated-view rule exists to remove.
 */
export interface StudioAxis {
  /** The key values are actually stored under, e.g. `Color`. */
  key: string
  /** The family's display label for it, e.g. `Colore`. Falls back to `key`. */
  label: string
  /** Rows in this family that actually carry a value for this axis. */
  rowsWithValue: number
  /** Rows in the family, for the ratio. */
  rowsTotal: number
  /**
   * `stored` — values are actually written under this key.
   * `declared` — the family lists this axis in `variationAxes` but NOTHING is
   *   stored under it. Measured: GALE-JACKET declares `Colore`/`Taglia` and
   *   stores under `Color`/`Size`, so both spellings appear and only the stored
   *   pair carries data.
   *
   * Explicit, because the alternative is guessing that `Colore` means `Color` —
   * `'colore'.includes('color')` happens to be true and `'taglia'` vs `'size'`
   * is not, which is luck rather than a mapping. Render the `stored` ones.
   */
  source: 'stored' | 'declared'
}

export interface StudioSheet {
  scope: StudioScope
  /**
   * D14.3 — server-stated counts for the scope bar's chips. `null` means NOT
   * COUNTED, which is a different fact from 0 — and 0 is a real answer, so they
   * must not share a value.
   */
  counts: {
    total: number
    filled: number
    empty: number
    notWritable: number
    pinned: number
    /** `null` when the mapping enrichment did not run — never 0 for that. */
    mapped: number | null
  }
  /**
   * #558 — the schema this payload was built against. NOT derivable from
   * `scope`: a master scope's `marketplace` is null, because a scope names a
   * coordinate and not the market the sheet was opened on.
   */
  schema: { marketplace: string; locale: string }
  family: {
    id: string
    sku: string
    name: string | null
    productType: string | null
    /** The raw declared display labels. Kept for compatibility. */
    variationAxes: string[]
    /** The explicit key→label map. Prefer this over `variationAxes`. */
    axes: StudioAxis[]
  }
  columns: SheetColumn[]
  /** AM.1 — the column groups in display order, with the channel's own title where there is one. */
  groups: SheetGroup[]
  /** [] in master scope. In channel scope always contains the primary group. */
  aliases: AliasGroup[]
  rows: StudioRow[]
  meta: {
    schemaMissing: string[]
    schemaAge: Array<{ productType: string; fetchedAt: string }>
    droppedKeys: string[]
    availableMarkets: string[]
    /** AM.1 — per channel spec: declared properties vs served columns (the conformance witness). */
    coverage: SheetSpecCoverage[]
    tookMs: number
    /**
     * Per-phase server time for THIS read (#513.3). Measured inside the request
     * because an outside instrument localises cost to a route and cannot say
     * what the route waits on.
     *
     * Measured on the 50-row `xracing` family: the per-cell row build — the
     * ~5,700 field resolutions the cost was attributed to — is **11-15 ms**.
     * The time is the per-market column build (cached after the first read) and
     * the mapping resolve.
     */
    phases?: Record<string, number>
    /** Channel scope only. How each product's rule set was selected. */
    mapping: {
      /**
       * Per product: which channel category drove the rules, and HOW it was
       * found. On production today `source` is always `'productType'` because
       * the `Category` table has 0 rows — surfaced verbatim rather than
       * presented as a category mapping that does not exist (hub ruling #15).
       */
      categoryByProduct: Record<string, ResolvedCategory>
      /** Products the resolver could not find. Named, never silently dropped. */
      missingProductIds: string[]
      /**
       * True when mapped values were resolved at PRODUCT level and therefore do
       * NOT account for per-alias overrides — the resolver is keyed by product,
       * and mapping rules are global per (channel, marketplace, category). Every
       * alias projection of one product currently shows the SAME mapped value.
       */
      productLevelOnly: boolean
      /** Null when the resolver was not run (master scope) or was skipped. */
      skippedReason: string | null
    } | null
  }
}

export interface GetStudioSheetInput {
  accountId?: string
  includeMapping?: boolean
  /** A parent OR a child id — the family root is resolved either way. */
  productId: string
  scope: StudioScopeKind
  market: string
  channel?: string
  locale?: string
}

export class UnknownProductError extends Error {
  readonly code = 'unknown_product'
  constructor(readonly productId: string) {
    super(`No product with id "${productId}"`)
    this.name = 'UnknownProductError'
  }
}

export class ScopeNotAvailableError extends Error {
  readonly code = 'scope_not_available'
  constructor(readonly channel: string, readonly market: string, readonly available: string[]) {
    // Both halves must speak about the same thing. The old wording asserted
    // marketplace CONFIGURATION ("is not an active channel") while the list it
    // printed was built from listing PRESENCE, so `?market=PL&channel=EBAY`
    // answered "Active here: none" on a market where AMAZON is configured and
    // active — sending an operator to check a connection that was fine.
    super(`${channel} has no marketplace configured on ${market}. Configured here: ${available.join(', ') || 'none'}`)
    this.name = 'ScopeNotAvailableError'
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

const PRODUCT_SELECT = {
  familyId: true, weightValue: true, weightUnit: true, dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
  costPrice: true, minMargin: true, minPrice: true, maxPrice: true, lowStockThreshold: true,
  hsCode: true, countryOfOrigin: true, ppeCategory: true, garmentClass: true,
  hazmatClass: true, hazmatUnNumber: true, notifiedBodyNumber: true, notifiedBodyName: true,
  declarationOfConformityUrl: true, impactProtectors: true,
  id: true, sku: true, name: true, parentId: true, isParent: true, status: true, productType: true,
  version: true, basePrice: true, categoryAttributes: true, localizedContent: true, translations: true, variantAttributes: true,
  description: true, bulletPoints: true, keywords: true, brand: true, manufacturer: true,
  gtin: true, ean: true, upc: true, totalStock: true, variationAxes: true,
} as const

const LISTING_SELECT = {
  id: true, productId: true, aliasId: true, version: true, channel: true, marketplace: true, listingStatus: true,
  isPublished: true, price: true, quantity: true, externalListingId: true, overrideData: true,
  titleOverride: true, descriptionOverride: true, priceOverride: true, quantityOverride: true,
  bulletPointsOverride: true, followMasterTitle: true, followMasterDescription: true,
  followMasterPrice: true, followMasterQuantity: true, followMasterImages: true,
  followMasterBulletPoints: true, offerActive: true, lastSyncedAt: true,
  // #542(2) — the three ChannelListing COLUMNS the prefixed write route targets
  // (`amazon_title` → `title`, etc.). They were never selected, which is why a
  // cell advertising `writeField: amazon_title` could not read what that write
  // had put there: the projection did not carry the column at all.
  title: true, description: true, variationTheme: true,
  // AM.1 — the listing's OWN bag: eBay item specifics and listing settings, Amazon's synced
  // attributes. Read for columns whose `channels[coord].store` is a `platformAttributes` path.
  platformAttributes: true,
} as const

const FOLLOW_FLAGS = ['followMasterTitle', 'followMasterDescription', 'followMasterPrice', 'followMasterQuantity', 'followMasterImages', 'followMasterBulletPoints'] as const

/**
 * Column key -> its followMaster* flag. Only SIX fields have one; every other
 * column returns `follows: null`, which is the honest answer rather than a
 * defaulted `true` that would paint a follow state on a cell that has none.
 *
 * Both key spaces are mapped because the sheet's columns carry BOTH the master
 * names (`name`, `description`) and the Amazon manifest names (`item_name`,
 * `product_description`, `bullet_point`) — measured on the live column set.
 */
const FOLLOW_BY_KEY: Record<string, (typeof FOLLOW_FLAGS)[number]> = {
  title: 'followMasterTitle', name: 'followMasterTitle', item_name: 'followMasterTitle',
  description: 'followMasterDescription', product_description: 'followMasterDescription',
  price: 'followMasterPrice', basePrice: 'followMasterPrice',
  quantity: 'followMasterQuantity',
  bulletPoints: 'followMasterBulletPoints', bullet_point: 'followMasterBulletPoints',
}


/**
 * The ONLY fields `PATCH /api/products/bulk` can route to a ChannelListing,
 * mirroring its `CHANNEL_FIELD_MAP`. Anything absent here writes to MASTER even
 * when the operator is looking at a channel scope.
 *
 * Kept as an explicit table rather than a prefix rule because the write endpoint
 * uses an explicit table: inventing `ebay_material` would be accepted by no
 * branch there and rejected as "Field not editable", so guessing would hand the
 * grid a field name that always fails.
 */
const CHANNEL_WRITABLE: Record<string, 'title' | 'description' | 'variationTheme' | 'bulletPoints' | 'price' | 'quantity'> = {
  price: 'price', quantity: 'quantity',
  title: 'title', name: 'title', item_name: 'title',
  description: 'description', product_description: 'description',
  variationTheme: 'variationTheme',
  // AM.1 — Amazon's `variation_theme` IS the listing's `variationTheme` column (one store): the
  // prefixed route `amazon_variationTheme` already exists.
  variation_theme: 'variationTheme',
  // AM.1 — the master bullet list on a channel scope writes the listing's own array
  // (`amazon_bulletPoints` → `bulletPointsOverride`, channel-field-map.ts). Slot columns
  // (`bulletPoints_3`) route through their base key and append `[3]` to the write field.
  bulletPoints: 'bulletPoints',
}

/** Channels whose prefix the write endpoint understands (`channelOf`). */
const CHANNEL_WRITE_PREFIX: Record<string, string> = { AMAZON: 'amazon', EBAY: 'ebay' }


export interface WriteRouting {
  writeField: string
  writeVerb: 'master' | 'channel'
  writeTarget: 'master' | 'channelListing'
  affectsAllChannels: boolean
  writable: boolean
  writeBlockedReason: string | null
}

/**
 * Where an edit to this cell LANDS. Pure, and exported so the rule can be tested
 * without a database — it is the single most dangerous thing in this payload to
 * get wrong.
 *
 * ⚠ Derived from the TARGET layer, never from the cell's current `layer`. The
 * first version keyed off `projection.id !== null`, which is FALSE for the
 * primary listing, so every cell on a channel scope claimed `master` — a pin
 * routed by it would have edited the shared record and changed every channel at
 * once. Found by PES.3's 409 rehearsal against the live contract.
 */
export function resolveWriteRouting(
  col: Pick<SheetColumn, 'key' | 'writeField' | 'storage'> & Partial<Pick<SheetColumn, 'slot' | 'editable' | 'helpText'>>,
  coordinate: { channel: string } | null,
  aliasId: string | null,
): WriteRouting {
  // Store fields use the contract's storage address through the shared attribute writer.
  // In particular, a store title must never write the shared Product.name column.
  if (coordinate && ['SHOPIFY', 'ETSY'].includes(coordinate.channel) && (coordinate.channel === 'SHOPIFY' || col.key !== 'sku')) {
    const baseKey = col.slot?.of ?? col.key
    return { writeField: `attr_${baseKey}${col.slot ? `[${col.slot.index}]` : ''}`,
      writeVerb: 'channel', writeTarget: 'channelListing', affectsAllChannels: false,
      writable: col.editable !== false, writeBlockedReason: col.editable === false ? col.helpText ?? 'This field is read-only.' : null }
  }
  const prefix = coordinate ? CHANNEL_WRITE_PREFIX[coordinate.channel] : undefined
  // A SLOT routes exactly as its list does; the slot index rides on the write field (`[3]`).
  const baseKey = col.slot ? col.slot.of : col.storage === 'localizedContent' && col.key === 'name' ? 'title' : col.key
  const slotSuffix = col.slot ? `[${col.slot.index}]` : ''
  const chanField = CHANNEL_WRITABLE[baseKey]
  // Route 1 (pre-existing): the six prefixed fields that map to ChannelListing
  // COLUMNS — {amazon,ebay}_{title,description,variationTheme}.
  const routesToColumn = Boolean(coordinate && prefix && chanField)

  // Route 2 (PES.5 / #169): everything stored in a JSONB bag now lands in
  // `ChannelListing.overrideData` for the coordinate, via `target: 'channel'` on
  // the bulk PATCH. The resolver already read that layer; only the write was
  // missing, which is why ~90% of channel cells rendered not-writable.
  //
  // `storage: 'column'` stays master: sku / gtin / status / productType are
  // master truth, and a per-channel SKU is a different feature (#171.4).
  // Shopify and Etsy use their explicit field stores in the earlier route.
  // This compatibility route remains limited to Amazon and eBay.
  const routesToOverride = Boolean(coordinate && prefix) && !routesToColumn && col.storage !== 'column'

  const routesToChannel = routesToColumn || routesToOverride

  return {
    // The six column-backed fields still need their prefixed name; an
    // override-bag write uses the ordinary field name plus `target: 'channel'`.
    writeField: routesToColumn ? `${prefix}_${chanField}${slotSuffix}` : col.writeField,
    // The six column-backed fields route by their PREFIX (legacy path) and must
    // NOT also send target:'channel'; the override bag routes by target.
    writeVerb: routesToOverride ? 'channel' : 'master',
    writeTarget: routesToChannel ? 'channelListing' : 'master',
    // Only a channel-scoped cell that STILL lands on master edits the shared
    // record — now just the identity/column fields.
    affectsAllChannels: Boolean(coordinate) && !routesToChannel,
    // Alias writes are routable now: `marketplaceContexts[].aliasKey` carries
    // the coordinate and the upsert's ON CONFLICT names `aliasKey`, so the merge
    // lands on THE listing the cell belongs to rather than the primary.
    writable: true,
    writeBlockedReason: null,
  }
}


/**
 * Read a row's variation-axis values out of `Product.variantAttributes`.
 *
 * Two things are filtered, both measured on production 2026-09-01:
 *  • a literal `variantAttributes` key holding the string `"[object Object]"` —
 *    a stringified object written as a value by some upstream path. 2 rows carry
 *    it, and both are GALE-JACKET children, the family the default view was
 *    being designed against.
 *  • any non-string value, so a nested object can never reach a cell as
 *    `[object Object]` a second time.
 */
export function readAxisValues(variantAttributes: unknown): Record<string, string> {
  if (!variantAttributes || typeof variantAttributes !== 'object' || Array.isArray(variantAttributes)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(variantAttributes as Record<string, unknown>)) {
    if (k === 'variantAttributes') continue
    if (typeof v !== 'string') continue
    if (v === '[object Object]' || v.trim() === '') continue
    out[k] = v
  }
  return out
}

/** Identity and coverage follow the same effective cells the operator edits, including resets. */
export function axisValuesFromCells(legacy: unknown, declared: string[], cells: Record<string, { value: unknown; mapped?: { status: string; value?: unknown } }>): Record<string, string> {
  const declaredKeys = new Set(declared.map(canonicalVariantAxis))
  const result = Object.fromEntries(Object.entries(readAxisValues(legacy)).filter(([key]) => declaredKeys.has(canonicalVariantAxis(key))))
  for (const axis of declared) {
    const match = Object.entries(cells).find(([key]) => canonicalVariantAxis(key) === canonicalVariantAxis(axis))
    if (!match) continue
    const existing = Object.keys(result).filter(key => canonicalVariantAxis(key) === canonicalVariantAxis(axis))
    const key = existing[0] ?? match[0]
    for (const old of existing) delete result[old]
    const cell = match[1], value = cell.mapped?.status === 'mapped' ? cell.mapped.value : cell.value
    if ((typeof value === 'string' && value.trim()) || typeof value === 'number' || typeof value === 'boolean') result[key] = String(value)
  }
  return result
}

/**
 * Pair the family's declared display labels with the keys values are actually
 * stored under, and report how many rows carry each.
 *
 * Matching is normalised (case- and space-insensitive) and falls back to the key
 * itself — never a substring guess. `Colore`/`Color` pair; `Taglia`/`Size` do
 * not, and a wrong pairing is worse than an unpaired axis, so an unmatched key
 * keeps its own name as the label.
 */
export function buildAxes(declaredLabels: string[], rowValues: Array<Record<string, string>>): StudioAxis[] {
  const keys = new Set<string>()
  for (const v of rowValues) for (const k of Object.keys(v)) keys.add(k)
  // A declared label with no stored values still deserves a column definition —
  // the operator declared the axis, it is simply unfilled.
  for (const l of declaredLabels) if (![...keys].some((k) => norm(k) === norm(l))) keys.add(l)

  return [...keys].map((key) => {
    const rowsWithValue = rowValues.filter((v) => typeof v[key] === 'string').length
    return {
      key,
      label: declaredLabels.find((l) => norm(l) === norm(key)) ?? key,
      rowsWithValue,
      rowsTotal: rowValues.length,
      // An axis nobody has written a value under is DECLARED, not stored — even
      // if the family lists it. Saying which is which is the whole point.
      source: rowsWithValue > 0 ? ('stored' as const) : ('declared' as const),
    }
  })
}

const norm = canonicalVariantAxis

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/**
 * #728 — THE value a sheet column holds for a product, in ONE place.
 *
 * The sheet loop below and the formula engine's lookup both need "what does
 * this column read for this row". They had different answers: the sheet read
 * master COLUMNS from the Product, while a formula's `$ref` resolved only
 * against `resolveAttributes` — 18 keys on the programme fixture — so `$sku`,
 * `$name`, `$basePrice` and `$manufacturer` all evaluated to null while the
 * same columns showed values on the sheet one pane away. Two derivations, two
 * answers; this is the single one both now call.
 *
 * Returns the RAW value only. Source, inheritance and divergence are the
 * sheet's business and stay in the loop.
 */
export function sheetValueForColumn(
  col: Pick<SheetColumn, 'key' | 'kind' | 'storage'> & Partial<Pick<SheetColumn, 'shape' | 'slot'>>,
  product: Record<string, unknown>,
  resolved: Record<string, { value?: unknown } | undefined>,
): unknown {
  // AM.1 — a slot reads its LIST's store and projects one item; a list/measure column normalises
  // the stored shape. The base key is the store's key (`bulletPoints` for `bulletPoints_3`).
  const baseKey = col.slot ? col.slot.of : col.storage === 'localizedContent' && col.key === 'name' ? 'title' : col.key
  let base: unknown
  if (col.storage === 'column') {
    base = normalise(product[baseKey], col.kind)
    if (baseKey === 'countryOfOrigin' && isBlankValue(base)) base = resolved.country_of_origin?.value ?? null
  }
  else {
    base = resolved[baseKey]?.value
    // The content trio (`description`, `bulletPoints`, `keywords`) lives per locale AND as a Product
    // column; `name` already reads its column on every market, so these read the column as the
    // fallback for the same reason — the master's default text is the master's text. Measured
    // 2026-09-05: master·IT showed `description` empty on every GALE row while Product.description
    // was the store the bulk PATCH writes.
    if (resolved[baseKey] === undefined && col.storage === 'localizedContent' && baseKey in product) base = normalise(product[baseKey], col.kind)
  }
  if (base === undefined) base = null
  return projectCellValue(col, base)
}

/**
 * The flat map a formula's `$ref` resolves against: every key the sheet exposes
 * for this row — columns AND attributes — valued by `sheetValueForColumn`.
 * A ref outside this map is UNKNOWN, and that is the whole point: it is the
 * same set the editor's autocomplete offers, so the two cannot disagree.
 */
export function formulaLookupMap(
  columns: Array<Pick<SheetColumn, 'key' | 'kind' | 'storage'> & Partial<Pick<SheetColumn, 'scope' | 'shape' | 'slot'>>>,
  product: Record<string, unknown>,
  resolved: Record<string, { value?: unknown } | undefined>,
  parent?: Record<string, unknown> | null,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {}
  // Attributes first, so a column of the same name wins — the column is the
  // layer the sheet shows and the write targets (#677).
  for (const [k, v] of Object.entries(resolved)) flat[k] = v?.value ?? null
  for (const col of columns) {
    const value = sheetValueForColumn(col, product, resolved)
    flat[col.key] = isBlankValue(value) && parent && col.scope === 'global'
      ? sheetValueForColumn(col, parent, resolved) : value
  }
  return flat
}

function normalise(v: unknown, kind: SheetColumn['kind']): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (kind === 'number') return decimalToNumber(v)
  if (typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') return decimalToNumber(v)
  return v
}

/** The row's OWN storage for a key — what decides pinned vs inherited. */
function ownValue(row: ProductLike, col: SheetColumn, locale: string): unknown {
  if (col.storage === 'categoryAttributes') return row.categoryAttributes?.[col.key]
  if (col.storage === 'localizedContent') return row.localizedContent?.[locale]?.[col.key === 'name' ? 'title' : col.key]
  return (row as unknown as Record<string, unknown>)[col.key]
}

/** Map the resolver's `ValueSource` onto the studio's layer vocabulary. */
function layerFor(source: string | null, hasAlias: boolean): CellLayer {
  // `null` = an EMPTY cell (#449): no layer supplied a value. Typed explicitly
  // rather than left to fall through `default:` — this file's tsconfig has
  // `strictNullChecks` off, so a null reaching a `string` parameter compiles
  // silently, and the behaviour would be right by accident rather than by
  // intent.
  if (source === null) return 'default'
  switch (source) {
    case 'master':
    case 'masterLocale':
    case 'masterColumn':
      return 'master'
    case 'variant':
    case 'variantLocale':
      return 'variant'
    case 'channelOverride':
    case 'channelExplicit':
      // The SAME storage means "this alias's value" when the row belongs to an
      // alias, and "the primary listing's channel override" when it does not.
      // One field, two honest names, decided by the row — not by the caller.
      return hasAlias ? 'alias' : 'channel'
    default:
      return 'default'
  }
}


/**
 * The mapping resolve is an ENRICHMENT, not the payload. The stored values are
 * the truth and stay editable without it, so it gets a budget and the sheet
 * ships without it rather than making the operator wait on it.
 */
/**
 * Layout spec §9.3 / §9.3c / §9.3d — column widths the contract owns, EVERY scope.
 *
 * `name` 220 (#371): the 21 name cells on eBay·IT hold 3 distinct values that are
 * byte-identical for their first 127 characters, and neither 380px (~45-50 chars)
 * nor 220px (~26-30) reaches the first difference — the extra 160px bought no
 * discrimination, while what does distinguish those rows already has its own
 * columns (Colore x Taglia).
 *
 * The three long-text columns 110 (#395/#396): gated on §9.3a, which landed — a
 * long-text cell renders its state as a mark with the counter in the tooltip, so
 * the column no longer has to be wide enough to read the value. Every scope,
 * because the argument is about the FIELD KIND, not the scope: 160px cannot show
 * a bullet point on any scope either, and in the sheet these cells' job is
 * `empty · filled · near · over · unchecked`, not content.
 */
const SPEC_WIDTHS: Record<string, number> = {
  name: 220,
  description: 110,
  // AM.1 — the bullet list is served as ten slot columns; each is a long-text cell of the same kind.
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`bulletPoints_${i + 1}`, 110])),
}


/** Identity codes: refused on a parent row for a different reason than an axis. */
const IDENTITY_CODE_KEYS = new Set(['ean', 'gtin', 'upc'])

const MAPPING_TIMEOUT_MS = 8_000

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
      // Do not hold the process open for a timer that is only a deadline.
      if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref()
    }),
  ])
}

// ────────────────────────────────────────────────────────────────────
// The read
// ────────────────────────────────────────────────────────────────────

/** The distinct eBay leaf category ids the given products are listed under on this market. */
export async function ebayCategoryIdsFor(
  prisma: { channelListing: { findMany: (args: unknown) => Promise<Array<{ platformAttributes: unknown }>> } },
  productIds: string[],
  market: string,
): Promise<string[]> {
  if (productIds.length === 0) return []
  const rows = await prisma.channelListing.findMany({
    where: { productId: { in: productIds }, channel: 'EBAY', marketplace: String(market).toUpperCase() },
    select: { platformAttributes: true },
  })
  const ids = new Set<string>()
  for (const r of rows) {
    const id = (r.platformAttributes as { categoryId?: unknown } | null)?.categoryId
    if (typeof id === 'string' && id.trim()) ids.add(id.trim())
    else if (typeof id === 'number') ids.add(String(id))
  }
  return [...ids].sort()
}

export async function getStudioSheet(input: GetStudioSheetInput): Promise<StudioSheet> {
  const t0 = Date.now()
  // #513(3) — per-phase server timing, IN the request. An outside instrument
  // localises cost to a route and cannot say what the route WAITS on; a 50-row
  // family measured 9,045 ms and the question is which phase owns it.
  // Kept on `meta` rather than logged: a number nobody can read is not a
  // measurement, and this makes every slow read self-describing.
  const phases: Record<string, number> = {}
  let _pm = Date.now()
  const mark = (name: string) => { const n = Date.now(); phases[name] = (phases[name] ?? 0) + (n - _pm); _pm = n }
  const market = String(input.market).toUpperCase()
  const wantChannel = input.scope === 'channel' ? String(input.channel ?? '').toUpperCase() : null
  const { default: prisma } = await import('../../db.js')

  // ── 1. the family ─────────────────────────────────────────────────
  const seed = await prisma.product.findFirst({
    where: { id: input.productId, deletedAt: null },
    select: { id: true, parentId: true },
  })
  if (!seed) throw new UnknownProductError(input.productId)
  const rootId = seed.parentId ?? seed.id

  const family = await prisma.product.findMany({
    where: { OR: [{ id: rootId }, { parentId: rootId }], deletedAt: null },
    // `images` rides the family read — one query, not one per row.
    select: { ...PRODUCT_SELECT, images: { select: { ...FACE_IMAGE_SELECT, id: true, mediaType: true, posterUrl: true, alt: true }, orderBy: FACE_IMAGE_ORDER_BY } },
    orderBy: [{ parentId: { sort: 'asc', nulls: 'first' } }, { sku: 'asc' }],
  })
  mark('family')
  const root = family.find((p) => p.id === rootId)
  if (!root) throw new UnknownProductError(input.productId)
  const children = family.filter((p) => p.id !== rootId)

  // ── 2. the columns for this scope ─────────────────────────────────
  let productTypes = [...new Set(family.map((p) => p.productType).filter(Boolean) as string[])]
  const variationAxes = [...new Set(family.flatMap((p) => (Array.isArray(p.variationAxes) ? p.variationAxes : [])))]
  // Narrowing to ONE channel matters: `maxLength`/`maxBytes` are the TIGHTEST
  // cap across the coordinates in the set, so asking for every channel shows
  // eBay's scope Amazon's tighter title cap and calls it eBay's.
  //
  // ⚠ This used `channels`, which does NOT narrow — it force-INCLUDES past the
  // presence filter and excludes nothing. The comment above described a
  // correctness property the code never had: measured on GALE-JACKET, master /
  // Amazon·IT / eBay·IT returned byte-identical column sets and all 36 capped
  // columns on the EBAY scope carried `capFrom: "Amazon · IT"`. `onlyChannels`
  // is the real filter.
  // AM.1 — the eBay leaf categories this family is listed under decide which aspects the eBay
  // coordinate declares. One light read of the family's eBay listings, before the column build.
  const context = wantChannel ? await productCategoryContext(family.map(p => p.id), wantChannel, market, input.accountId) : null
  if (wantChannel === 'AMAZON') productTypes = context!.categories
  const ebayCategoryIds = wantChannel === 'EBAY' ? context!.categories : []
  const columnSet = await getStudioColumns({
    accountId: context?.connectionId,
    locale: input.locale,
    market,
    productTypes,
    familyIds: [...new Set(family.map(p => p.familyId).filter((v): v is string => !!v))],
    savedFields: savedAttributeFields(family.map(p => p.categoryAttributes)),
    variationAxes,
    ebayCategoryIds,
    etsyCategoryIds: wantChannel === 'ETSY' ? context!.categories : [],
    scopeKind: wantChannel ? 'channel' : 'master',
    // ⚠ BOTH options, and the pair is load-bearing. `onlyChannels` narrows to
    // this channel's caps; `includeEmptyChannels` keeps a coordinate the product
    // is NOT yet listed on. Narrowing alone dropped every unlisted coordinate
    // (`coordinatesFor` filters on `present`), so eBay·DE returned zero
    // coordinates and the scope threw `scope_not_available` — killing the create
    // path, which is exactly the case where an operator opens a scope to list
    // there for the first time. The two pull in opposite directions on one call.
    ...(wantChannel ? { onlyChannels: [wantChannel], includeEmptyChannels: true } : {}),
  })
  mark('columns')
  const { columns, coordinates, locale: marketLocale, droppedKeys, schemaMissing, schemaAge, availableMarkets, groups: columnGroups, coverage } = columnSet
  const locale = (input.locale ?? marketLocale).toLowerCase()

  let coordinate: SheetCoordinate | null = null
  if (wantChannel) {
    coordinate = coordinates.find((c) => c.channel === wantChannel) ?? null
    if (!coordinate) {
      // `coordinates` is ALREADY narrowed to `wantChannel` by `onlyChannels`, so
      // deriving "where else could I go" from it can only ever return
      // [wantChannel] or nothing — it structurally cannot answer the question
      // the field exists to answer. Re-read the market's FULL coordinate set so
      // the answer comes from the marketplace rows. Error path only, and the
      // build is cached, so the happy path pays nothing for it.
      const full = await getStudioColumns({ market, productTypes, variationAxes, ebayCategoryIds, includeEmptyChannels: true })
      throw new ScopeNotAvailableError(wantChannel, market, [...new Set(full.coordinates.map((c) => c.channel))])
    }
  }

  const scope: StudioScope = coordinate
    ? { kind: 'channel', channel: coordinate.channel, marketplace: coordinate.marketplace, label: coordinate.label, connectionId: null, locale }
    : { kind: 'master', channel: null, marketplace: null, label: 'Master', connectionId: null, locale }

  // ── 3. aliases, listings, link groups ─────────────────────────────
  const familyIds = family.map((p) => p.id)

  // #473 — one read for the whole family's formulas. Never per cell: a 97-column
  // sheet would otherwise be one query per cell per row.
  //
  // `channel`/`marketplace`/`locale` are NOT NULL with `''` as the "not scoped"
  // sentinel, deliberately: Postgres treats NULLs as DISTINCT in a unique index,
  // so nullable columns would accept the SAME master formula twice with no way
  // to say which wins (reference_prisma_upsert_on_conflict). Match with `''`,
  // never `null`.
  let formulaRows = await prisma.cellFormula.findMany({
    where: {
      productId: { in: familyIds },
      scope: coordinate ? 'channel' : 'master',
      channel: coordinate ? coordinate.channel : '',
      marketplace: coordinate ? coordinate.marketplace : '',
      channelConnectionId: coordinate ? context?.connectionId ?? '' : '',
      // A formula may be pinned to one locale or apply to every locale (`''`).
      // Both are matched here and the locale-specific one wins below.

    },
    select: { productId: true, aliasKey: true, fieldKey: true, locale: true, expr: true, lastError: true, dependsOn: true },
  })
  mark('formulas')
  const formulaByProduct = new Map<string, Map<string, (typeof formulaRows)[number]>>()
  for (const f of formulaRows) {
    const column = columns.find(c => c.key === f.fieldKey)
    if (f.locale && f.locale.toLowerCase() !== locale && (!column || column.storage === 'localizedContent')) continue
    let m = formulaByProduct.get(`${f.productId}:${f.aliasKey ?? ''}`)
    if (!m) { m = new Map(); formulaByProduct.set(`${f.productId}:${f.aliasKey ?? ''}`, m) }
    const existing = m.get(f.fieldKey)
    // Locale-specific beats the all-locale row; otherwise first wins.
    if (!existing || (existing.locale === '' && f.locale !== '')) m.set(f.fieldKey, f)
  }

  const [aliasRows, listingRows, linkGroups] = await Promise.all([
    coordinate
      ? prisma.productListingAlias.findMany({
          where: { productId: rootId, channel: coordinate.channel, marketplace: coordinate.marketplace, status: 'ACTIVE', channelConnectionId: context?.connectionId ?? null },
          orderBy: { position: 'asc' },
        })
      : Promise.resolve([]),
    coordinate
      ? prisma.channelListing.findMany({
          where: { productId: { in: familyIds }, channel: coordinate.channel, marketplace: coordinate.marketplace, channelConnectionId: context?.connectionId ?? null },
          select: LISTING_SELECT,
        })
      : Promise.resolve([]),
    prisma.fieldLinkGroup.findMany({
      where: { productId: rootId },
      select: { fieldKey: true, variantId: true, translatePolicy: true, sourceLanguage: true, members: true, id: true },
    }),
  ])
  mark('related')

  // ── 3b. what the MAPPING ENGINE would ship for these cells ────────
  // Composed IN-PROCESS (hub ruling #15.2 / #20.1): one payload, no second HTTP
  // hop, and PES.2/3 are barred from fetching PES.6 separately. `status` and
  // every verdict below come from PES.6 — this service never decides what
  // "mapped" means, because a constant/expression rule has an EMPTY
  // `rule.source` and anything inferring mapped-ness from that under-counts.
  let mappingMeta: StudioSheet['meta']['mapping'] = null
  const mappedByRow: Record<string, Record<string, ResolvedCell>> = {}
  if (coordinate && input.includeMapping !== false) {
    // Let the resolver select each listing's category. Pinning the master's Amazon productType
    // here selected OUTERWEAR rules on eBay and bypassed category mappings on both channels.
    try {
      // The IMPORT is bounded too, not just the call. PES.6's barrel connects to
      // its Redis-backed queue during module INITIALISATION, so a dynamic import
      // of it blocks before any function of ours runs — measured locally as >60s
      // with no output at all. Bounding only the call left the hang untouched.
      const { resolveChannelValues } = await withTimeout(
        import('./mapping/index.js'),
        MAPPING_TIMEOUT_MS,
        `mapping module load exceeded ${MAPPING_TIMEOUT_MS}ms (its queue backend is unreachable)`,
      )
      // ⚠ BOUNDED. The mapping resolver reaches a Redis-backed queue on the way
      // in; when that host is unreachable it does not throw, it RETRIES —
      // measured locally as an indefinite hang emitting only queue errors. An
      // unbounded await here would hang the whole sheet read on an infrastructure
      // problem that has nothing to do with the stored values the operator is
      // trying to edit. A read that fails fast and says why beats one that spins
      // (reference_networkidle_gate_hung_request).
      const resolutions = await withTimeout(
        Promise.all(['', ...aliasRows.map(alias => alias.id)].map(async aliasKey => ({ aliasKey, result: await resolveChannelValues({
          aliasKey,
          channelConnectionId: context?.connectionId ?? null,
          channel: coordinate.channel,
          marketplace: coordinate.marketplace,
          productIds: familyIds,
          // Asked by the CHANNEL's own field names (`bullet_point`, `item_name`), which is what the
          // engine's rules are keyed on — never by the merged sheet keys or slot keys. Measured
          // 2026-09-05: sending 186 sheet keys made the resolve 3.7 s; ~107 channel keys is the truth.
          fieldKeys: [...new Set(columns.map((c) => c.channels?.[coordinate.label]?.key ?? c.channels?.[coordinate.label]?.attribute).filter((k): k is string => !!k))],
          locale,
        }) }))),
        MAPPING_TIMEOUT_MS * Math.max(1, Math.ceil(familyIds.length / 250)),
        'Channel mapping resolution timed out; retry to validate the complete family.',
      )
      const resolved = resolutions[0].result
      for (const { aliasKey, result } of resolutions) for (const [id, cells] of Object.entries(result.byProduct)) mappedByRow[`${id}:${aliasKey}`] = cells
      mark('mapping')
      mappingMeta = {
        categoryByProduct: resolved.categoryByProduct,
        missingProductIds: [...new Set(resolutions.flatMap(({ result }) => result.missingProductIds))],
        productLevelOnly: false,
        skippedReason: null,
      }
    } catch (err) {
      // A mapping failure must not take the sheet down: the stored values are
      // still the truth and are still editable. The cells report `mapped: null`
      // and the reason travels with the payload instead of vanishing into a log.
      mappingMeta = {
        categoryByProduct: {},
        missingProductIds: familyIds,
        productLevelOnly: true,
        skippedReason: err instanceof Error ? err.message : String(err),
      }
    }
  }

  scope.connectionId = context?.connectionId ?? null

  // listings keyed by `${productId}:${aliasId ?? ''}`
  const listingByRow = new Map<string, (typeof listingRows)[number]>()
  for (const l of listingRows) listingByRow.set(`${l.productId}:${l.aliasId ?? ''}`, l)

  // ── 4. the alias groups to project the family through ─────────────
  // The PRIMARY listing is always a group, so the client renders ONE uniform
  // list and never special-cases the un-aliased rows.
  const groups: Array<{ id: string | null; label: string; position: number; status: string }> = [
    { id: null, label: 'Primary', position: 0, status: 'ACTIVE' },
    ...aliasRows.map((a) => ({ id: a.id, label: a.label, position: a.position, status: a.status })),
  ]
  const projections = coordinate ? groups : [{ id: null, label: 'Master', position: 0, status: 'ACTIVE' }]

  // ── 5. pure per-row work ──────────────────────────────────────────
  // Validators are per (coordinate, productType, isParent) — built once here,
  // never per row.
  const validatorCache = new Map<string, ReturnType<typeof buildCoordinateValidators>>()
  const readinessCoord: SheetCoordinate = coordinate ?? { channel: 'MASTER' as SheetCoordinate['channel'], marketplace: market, label: 'Master', inMarket: true }
  const missingSchemaFor = (category: string | null | undefined) => !!coordinate &&
    ((coordinate.channel !== 'SHOPIFY' && !category) ||
      (schemaMissing ?? []).some(key => key === category || key === `${coordinate.channel}:${category}` || key === `${coordinate.channel}:*`))
  const validatorsFor = (row: { isParent: boolean; productType: string | null; familyId?: string | null }) => {
    const key = `${row.isParent}:${row.productType ?? ''}:${row.familyId ?? ''}`
    let v = validatorCache.get(key)
    if (!v) { v = buildCoordinateValidators(columns, readinessCoord, row); validatorCache.set(key, v) }
    return v
  }

  const linkGroupLikes: FieldLinkGroupLike[] = linkGroups as unknown as FieldLinkGroupLike[]
  const rows: StudioRow[] = []

  for (const projection of projections) {
    mark('preRows')
    for (const product of family) {
      const productRole = productRoleOf({ ...product, childCount: product.parentId ? 0 : children.length })
      const isParent = productRole === 'parent'
      const parent = product.parentId ? (root as unknown as ProductLike) : null
      const listingRow = coordinate ? listingByRow.get(`${product.id}:${projection.id ?? ''}`) ?? null : null

      const effectiveCategory = coordinate
        ? categoryForListing(context?.defaults[product.id], coordinate.channel, listingRow?.platformAttributes).channelCategoryId
        : product.productType
      const rowShape = { isParent, productType: effectiveCategory, familyId: product.familyId ?? root.familyId }
      const resolved: ResolvedAttributes = resolveAttributes({
        localizableKeys: columns.filter(c => c.storage === 'localizedContent').map(c => c.slot?.of ?? (c.key === 'name' ? 'title' : c.key)),
        product: product as unknown as ProductLike,
        parent,
        // Master scope resolves WITHOUT a listing so a cell shows the stored
        // truth; channel scope resolves WITH it so the cell shows what that
        // listing would actually publish.
        channelListing: (listingRow as unknown as ChannelListingLike) ?? null,
        locale,
      })

      const values: Record<string, StudioCellValue> = {}
      for (const header of columns) {
        const col = coordinate ? columnForCategory(header, coordinate.label, effectiveCategory) : header
        const routing = resolveWriteRouting(col, coordinate, projection.id)

        let base: SheetCellValue | null = null
        let divergence: { publishesAs: unknown; note: string } | null = null
        if (col.storage === 'column') {
          // #674 — the cell shows the layer the WRITE targets, and says so when
          // another layer disagrees.
          //
          // #508(1) had this branch prefer the resolver, which layers
          // `categoryAttributes` OVER the legacy column. That fixed the screen
          // (the sheet showed what publishes) and left the WRITE pointing at the
          // column — so a `brand` PATCH landed in the column and the cell went on
          // showing the attribute, permanently. Not staleness: no cache, no
          // duration, a different store. Worse than display, because #641's
          // reconcile reads this endpoint to resolve an unknown write and would
          // have called a landed write `refused`, telling the operator to retype
          // something already saved.
          //
          // Read store = write store. Where the resolver holds a DIFFERENT
          // non-blank value the cell carries it explicitly rather than silently
          // showing one or the other — the honest state until canonicality is
          // ruled (Owner item 29). Measured: exactly one key has an attribute
          // twin (`brand`, on one product), so this mark is rare by construction
          // and its absence is meaningful.
          // ONE derivation, shared with the formula lookup (#728). Behaviour
          // here is unchanged — proven by hashing this endpoint's response
          // before and after the extraction.
          const raw = sheetValueForColumn(col, product as unknown as Record<string, unknown>, resolved)
          if (!isBlank(raw)) base = { value: raw, source: 'masterColumn', inheritedFrom: null, inherited: false }
          else if (parent && col.scope === 'global') {
            const inherited = sheetValueForColumn(col, parent as unknown as Record<string, unknown>, resolved)
            if (!isBlankValue(inherited)) base = { value: inherited, source: 'masterColumn', inheritedFrom: rootId, inherited: true }
          }
          const alt = resolved[col.key]
          if (alt && !isBlank(alt.value) && String(alt.value) !== String(raw ?? '')) {
            divergence = {
              publishesAs: alt.value,
              note: `This cell edits the master column, which holds ${JSON.stringify(raw ?? null)}. An attribute of the same name holds ${JSON.stringify(alt.value)}, and that is what publishes.`,
            }
          }
        } else {
          // AM.1 — ONE derivation for every storage (`sheetValueForColumn`): a slot reads its list's
          // store and projects one item, a list/measure normalises its shape, the content trio falls
          // back to its Product column. This branch used to read `resolved[col.key]` directly, so a
          // master slot (`bulletPoints_3`) — a key no store holds — read nothing (rehearsal 2026-09-05:
          // the write landed in `Product.bulletPoints[2]` and the cell stayed empty).
          const baseKey = col.slot ? col.slot.of : col.storage === 'localizedContent' && col.key === 'name' ? 'title' : col.key
          const raw = sheetValueForColumn(col, product as unknown as Record<string, unknown>, resolved)
          if (resolved[baseKey] || !isBlankValue(raw)) {
            const hit = resolved[baseKey]
            const own = ownValue(product as unknown as ProductLike, { ...col, key: baseKey }, locale)
            const fromColumn = !hit || isBlankValue(hit.value)
            base = {
              value: raw,
              source: fromColumn ? 'masterColumn' : hit.source,
              inheritedFrom: fromColumn ? null : hit.inheritedFrom,
              inherited: !fromColumn && !isParent && col.scope === 'global' && isBlank(own) && hit.inheritedFrom !== null,
            }
          }
        }
        // #449 / D14 — a declared column is a PROMISE: every row carries a cell
        // for every declared column, empty where there is no value.
        //
        // `continue` here is the Owner's "I cannot write a lot of attributes such
        // as color". Measured on XAVIA Amazon·IT: 97 declared columns, 21 cells
        // per row, so **76 declared columns had no cell on any row** — `color`
        // among them. `values['color']` was `undefined`, so the client's
        // `isCellEditable` said false and there was nothing to carry a reason.
        // The write path worked the whole time; the read never offered the cell.
        //
        // An empty cell is NOT skipped and NOT half-built: it carries the same
        // routing as a filled one, so a client never has to synthesise
        // `writable`/`writeVerb` — those are the server's answers. It also still
        // carries `mapped`, because a cell with no stored value can have a
        // DERIVED one, and dropping it hid the derived layer on exactly the
        // cells where it is the only content.
        // The same stored-state reader drives the grid, import previews and channel mapping.
        // An explicit blank is a stored value; follow flags suppress stale listing snapshots.
        const channelFacts = coordinate ? col.channels?.[coordinate.label] : undefined
        if (coordinate && routing.writeTarget === 'channelListing' && listingRow) {
          const channelColumn = routing.writeVerb === 'master' ? CHANNEL_WRITABLE[col.slot?.of ?? col.key] : undefined
          const store = channelFacts?.store ?? (channelColumn ? { kind: 'listingColumn' as const,
            column: channelColumn === 'bulletPoints' ? 'bulletPointsOverride' : channelColumn,
            followFlag: FOLLOW_BY_KEY[col.slot?.of ?? col.key] } : undefined)
          const stored = storedChannelState(listingRow as unknown as Record<string, unknown>, store,
            [...new Set([col.slot?.of ?? col.key, channelFacts?.key ?? col.key])])
          if (stored.state === 'stored') {
            const raw = coordinate.channel === 'EBAY' ? normalizeEbayListingValue(col.key, stored.value) : stored.value
            base = { value: projectCellValue(col, col.shape === 'measure' || col.shape === 'list' ? raw : normalise(raw, col.kind)),
              source: 'channelExplicit', inheritedFrom: null, inherited: false }
          }
        }

        if (!base && coordinate && (col.key === 'categoryId' || col.key === 'productType' || col.key === 'taxonomy_id') && effectiveCategory) {
          base = { value: effectiveCategory, source: 'master', inheritedFrom: rootId, inherited: true }
        }
        const empty: SheetCellValue = { value: null, source: null, inheritedFrom: null, inherited: false }
        const cell = base ?? empty

        const link = coordinate
          ? linkForCoordinate(linkGroupLikes, col.key, coordinate.channel, coordinate.marketplace, isParent ? null : product.id, locale)
          : null
        const layer = link ? 'linked' : layerFor(cell.source, projection.id !== null)
        // D14.2 — `follows` is DERIVED from where the cell writes, never from a
        // fixed list of six.
        //
        // Measured 2026-09-02: on Amazon·IT the fixed list set it on 6 cells
        // while **63 columns route to the channel** — 57 channel cells said
        // nothing. Worse, on eBay·IT it was set on 3 cells where only 2 columns
        // route to the channel: `description`, `name` and `basePrice` write
        // MASTER there, so the flag asserted a follow relationship that does not
        // exist. An absent flag reads "not applicable"; a false one reads "this
        // cell tracks master" when nothing tracks anything.
        //
        // Where the listing carries an explicit `followMaster*` column that is
        // the stored INTENT and wins. Everywhere else it is the observable fact:
        // a cell follows master while the channel layer holds no value of its
        // own.
        const followFlag = FOLLOW_BY_KEY[col.slot?.of ?? col.key]
        const follows = routing.writeTarget === 'channelListing' && listingRow
          ? followFlag
            ? (listingRow as unknown as Record<string, boolean>)[followFlag] !== false
            : layer !== 'channel' && layer !== 'alias'
          : null

        // The two live refusal rules, each with the sentence it owes an operator.
        // Order matters: the parent-row rule is the more specific one, so it
        // speaks first when both apply.
        const blockedByAxis = isParent && col.scope === 'per_variant'
        const shopifyOwnerApplies = !col.shopifyField || (col.shopifyField.owner === 'PRODUCT' ? !product.parentId : !isParent)
        const shopifyApplicability = col.shopifyField?.definition ? shopifyDefinitionApplicability(col.shopifyField.definition, rowShape.productType) : null
        const cellEditable = col.editable && shopifyOwnerApplies && !shopifyApplicability && columnApplies(col, rowShape)
        // The COLUMN's own refusal speaks first, because it applies on every row.
        // Measured while verifying this: `sku` is both per-variant scoped AND
        // read-only, and putting the axis rule first made the parent row say
        // "set on each variant" while the variant row said "read-only" — sending
        // the operator to a cell they still cannot edit. A reason that redirects
        // has to be true at the destination.
        // F1a — the sentence must not name a channel on a scope that has none.
        // Measured: 11 master DE/de columns said "Read-only on this channel"
        // where there IS no channel, which sends the operator looking for a
        // channel setting to change. A master cell names the master record and
        // the reason class instead.
        const cellBlockedReason = !col.editable
          ? col.helpText || (col.storage === 'listing'
            ? 'This listing field has no manual writer. Its stored value is preserved.'
            : coordinate
            ? 'Read-only on this channel — the marketplace does not accept a value for this field.'
            : 'Read-only on the master record — this field is not editable by hand in this market.')
          : !shopifyOwnerApplies ? `This Shopify field belongs to ${col.shopifyField?.owner === 'PRODUCT' ? 'the product row' : 'a variant row'}.`
          : shopifyApplicability ? shopifyApplicability
          : !columnApplies(col, rowShape) && !blockedByAxis
            ? 'Not applicable to this category.'
          : blockedByAxis
            ? IDENTITY_CODE_KEYS.has(col.key)
              ? 'Set on each variant — an identity code belongs to the individual product, not the family.'
              : 'Set on each variant — this is a variation axis, so the family row has no single value.'
            : null

        // The mapping engine is keyed by the CHANNEL's field name (`bullet_point`, not the merged
        // `bulletPoints`); a slot takes its item out of the engine's array value.
        const mappedKey = coordinate?.channel === 'EBAY' ? channelFacts?.key ?? col.key : channelFacts?.attribute && channelFacts.path.length === 0 ? channelFacts.attribute : channelFacts?.key ?? (col.slot ? col.slot.of : col.key)
        const rowMapping = mappedByRow[`${product.id}:${projection.id ?? ''}`]
        const mRaw = rowMapping?.[mappedKey] ?? rowMapping?.[col.slot ? col.slot.of : col.key]
        const m = mRaw && col.slot
          ? { ...mRaw, value: Array.isArray(mRaw.value) ? (mRaw.value[col.slot.index - 1] ?? null) : col.slot.index === 1 ? mRaw.value : null,
              ...(isBlank(mRaw.value) && col.slot.index > Math.max(1, channelFacts?.cardinality?.min ?? 1) ? { errors: [], mappingErrors: [] } : {}) }
          : mRaw
        // #473 — ABSENT, not null, when the cell has no formula (#415's rule,
        // which the wire already follows). Most cells carry none of the three,
        // so spreading a conditional object keeps the payload delta at zero for
        // them rather than adding three null keys to every cell on the sheet.
        const fx = formulaByProduct.get(`${product.id}:${coordinate ? projection.id ?? '' : ''}`)?.get(col.key)
        values[col.key] = {
          ...cell,
          ...(m?.effectiveLocale ? { requestedLocale: m.requestedLocale, effectiveLocale: m.effectiveLocale, translationState: m.translationState, needsTranslation: m.needsTranslation }
            : !coordinate && resolved[col.slot?.of ?? (col.storage === 'localizedContent' && col.key === 'name' ? 'title' : col.key)]?.effectiveLocale ? {
              requestedLocale: locale, effectiveLocale: resolved[col.slot?.of ?? (col.storage === 'localizedContent' && col.key === 'name' ? 'title' : col.key)].effectiveLocale,
              translationState: resolved[col.slot?.of ?? (col.storage === 'localizedContent' && col.key === 'name' ? 'title' : col.key)].translationState,
              needsTranslation: ['fallback', 'outdated'].includes(resolved[col.slot?.of ?? (col.storage === 'localizedContent' && col.key === 'name' ? 'title' : col.key)].translationState ?? ''),
            } : {}),
          // Show the effective channel value that preview validates, including an empty mapping.
          // The separate mapping object retains transforms, provenance and diagnostics.
          value: coordinate?.channel === 'SHOPIFY'
            ? m ? m.value : cell.source === 'channelExplicit' ? cell.value : null
            : m?.status === 'mapped' ? m.value : cell.value,
          ...(divergence ? { divergence } : {}),
          ...(fx
            ? {
                formula: fx.expr,
                // `lastError` set means the last evaluation produced no value.
                // Carried alongside `formula`, never instead of it.
                ...(fx.lastError ? { formulaError: fx.lastError } : {}),
                ...(fx.dependsOn.length > 0 ? { dependsOn: fx.dependsOn } : {}),
              }
            : {}),
          mapped: m
            ? {
                value: m.value,
                requestedLocale: m.requestedLocale, effectiveLocale: m.effectiveLocale, translationState: m.translationState, needsTranslation: m.needsTranslation,
                sourceOwner: m.sourceOwner,
                status: m.status,
                provenance: m.provenance,
                supplyingRule: m.supplyingRule,
                sourcePath: m.rule?.source ?? null,
                fallbackPath: m.rule?.fallback ?? null,
                usesExpression: m.rule?.transforms?.some(op => op.type === 'expr') ?? false,
                legacySource: m.legacySource,
                appliedTransforms: m.appliedTransforms,
                warnings: m.warnings,
                errors: m.errors,
                mappingErrors: m.mappingErrors,
                autoCorrected: m.autoCorrected,
                requiredByRule: m.required && (!col.slot || col.slot.index <= (channelFacts?.cardinality?.min ?? 1)),
                overLimit: m.overLimit,
              }
            : null,
          layer,
          // `pinned` is about THIS layer holding the value, which is exactly
          // "the value did not come from somewhere further up".
          pinned: layer === 'alias' || layer === 'channel' || (layer === 'variant' && !isParent),
          follows,
          editable: cellEditable,
          linkGroupId: link ? (linkGroups.find((g) => g.fieldKey === col.key)?.id ?? null) : null,
          ...routing,
          // #513/#522 — `writable` MIRRORS editability, and the reason travels
          // with whichever rule said no.
          //
          // Measured 2026-09-02: `writable` was `true` on 100% of cells in every
          // scope — including the 13 (master), 11 (Amazon), 9 (eBay) and 7
          // (Shopify) that `editable: false` already refused — and
          // `writeBlockedReason` was never set anywhere. A client reading
          // `writable` was told yes on every cell in the sheet. That is the
          // honesty defect; the missing sentence was only its symptom.
          //
          // `routing` is spread ABOVE deliberately: it decides WHERE a writable
          // cell writes, and this decides WHETHER it can be written at all. The
          // two are different questions and the second is the one a client asks
          // first.
          writable: cellEditable,
          writeBlockedReason: cellBlockedReason,
        }
      }

      const listing: SheetListing | null = listingRow
        ? {
            id: listingRow.id,
            // The token a channel write must CAS on — see SheetListing.version.
            version: listingRow.version,
            listingStatus: listingRow.listingStatus,
            isPublished: listingRow.isPublished,
            price: decimalToNumber(listingRow.priceOverride ?? listingRow.price),
            quantity: listingRow.quantityOverride ?? listingRow.quantity ?? null,
            externalListingId: listingRow.externalListingId,
            offerActive: listingRow.offerActive !== false,
            // #327(8) — the Listings pane had no time reference at all. This is
            // when a sync last RAN, which is NOT "last checked against the
            // channel": nothing here polls the channel to confirm the remote
            // still matches. Named `lastSyncedAt` so a renderer cannot label it
            // as a freshness check it is not; null means never synced.
            lastSyncedAt: listingRow.lastSyncedAt ? listingRow.lastSyncedAt.toISOString() : null,
            follows: Object.fromEntries(FOLLOW_FLAGS.map((f) => [f, (listingRow as unknown as Record<string, boolean>)[f] !== false])),
          }
        : null

      // Face image: the row's own, else the FAMILY's — the same two-step the
      // catalogue already does (sync-control.routes.ts). Measured: 74 of 301
      // children have no images of their own, so without the fallback a quarter
      // of rows would show nothing.
      // Mirrors FACE_IMAGE_SELECT exactly — createdAt included, because
      // pickFaceImage's contract takes an array already sorted by
      // [sortOrder, createdAt] and the type says so.
      const ownImages = product.images ?? []
      const parentImages = root.images ?? []
      const ownFace = pickFaceImage(ownImages.filter(image => (image.mediaType ?? 'IMAGE') === 'IMAGE'))
      const face = ownFace ?? (isParent ? null : pickFaceImage(parentImages.filter(image => (image.mediaType ?? 'IMAGE') === 'IMAGE')))
      let productMedia: StudioRow['productMedia'], productMediaError: string | undefined
      try {
        const media = resolveMediaCollection({ locale: mediaLocaleSchema.parse(input.locale ?? marketLocale),
          own: coordinate ? mediaObject(listingRow?.platformAttributes)._productMediaLocales : product.localizedContent,
          shared: coordinate ? product.localizedContent : undefined, parent: isParent ? undefined : root.localizedContent,
          ownIds: ownImages.map(image => image.id), parentIds: isParent ? [] : parentImages.map(image => image.id) })
        const assets = new Map([...parentImages, ...ownImages].map(image => [image.id, image]))
        productMedia = media.collection.items.map(item => { const asset = assets.get(item.assetId); return {
          id: item.assetId, type: asset?.mediaType ?? 'FILE', preview: asset ? asset.mediaType === 'IMAGE' ? asset.url : asset.posterUrl : null,
          alt: item.alt ?? asset?.alt ?? '',
        } })
      } catch { productMediaError = 'Saved media needs attention. Open the gallery to inspect it.' }

      const axisValues = axisValuesFromCells((product as unknown as { variantAttributes?: unknown }).variantAttributes, root.variationAxes ?? [], values)

      const flat: FlatRow = {}
      for (const [k, cell] of Object.entries(values)) flat[k] = cell.mapped?.status === 'mapped' ? cell.mapped.value : cell.value
      const issues: ReadinessIssue[] = evaluateRow(flat, validatorsFor(rowShape)).map((i) => ({
        key: i.field,
        label: columns.find((c) => c.key === i.field)?.label ?? i.field,
        message: i.message,
        severity: i.severity === 'error' ? 'error' : 'warn',
      }))
      for (const column of columns) {
        if (!columnApplies(column, rowShape)) continue
        const localized = values[column.key]
        if (localized?.needsTranslation) issues.push({ key: column.key, label: column.label,
          message: `${locale} content ${localized.translationState === 'outdated' ? 'is outdated' : 'is missing'}${localized.effectiveLocale ? `; showing ${localized.effectiveLocale} fallback` : ''}.`,
          severity: columnRequiredByAny(column, rowShape) || localized.mapped?.requiredByRule ? 'error' : 'warn' })
        for (const message of values[column.key]?.mapped?.errors ?? []) {
          // A blocking mapping verdict replaces the weaker warning for the same field.
          for (let index = issues.length - 1; index >= 0; index--) {
            if (issues[index].key === column.key && issues[index].severity === 'warn') issues.splice(index, 1)
          }
          if (!issues.some(issue => issue.key === column.key && issue.severity === 'error')) {
            issues.push({ key: column.key, label: column.label, message, severity: 'error' })
          }
        }
      }
      if (missingSchemaFor(effectiveCategory)) {
        const categoryKey = coordinate?.channel === 'ETSY' ? 'taxonomy_id' : coordinate?.channel === 'EBAY' ? 'categoryId' : 'productType'
        const categoryColumn = columns.find(column => column.key === categoryKey || Object.values(column.channels ?? {}).some(facts => facts.key === categoryKey))
        issues.push({ key: categoryColumn?.key ?? categoryKey, label: 'Channel requirements', severity: 'error',
          message: `Requirements for ${effectiveCategory ?? 'this category'} on ${coordinate!.label} are unavailable. Readiness cannot be verified until the category schema is loaded.` })
      }
      const hasErrors = issues.some((i) => i.severity === 'error')
      const readiness: SheetReadiness = {
        state: hasErrors
          ? 'errors'
          : listing && listing.externalListingId && listing.isPublished
            ? 'live'
            : !listing && coordinate
              ? 'unlisted'
              : issues.length > 0
                ? 'missing'
                : 'ready',
        issues,
        ref: listing?.externalListingId ?? undefined,
      }

      const plainValues: Record<string, SheetCellValue> = {}
      for (const [k, v] of Object.entries(values)) plainValues[k] = v

      rows.push({
        id: product.id,
        sku: product.sku,
        name: product.name ?? null,
        parentId: product.parentId,
        productRole,
        parentSku: product.parentId ? root.sku : null,
        isParent,
        rowKind: product.parentId === null ? 'parent' : 'variant',
        status: product.status ?? 'ACTIVE',
        productType: effectiveCategory ?? null,
        familyId: rowShape.familyId,
        version: product.version ?? 1,
        basePrice: decimalToNumber(product.basePrice),
        childCount: isParent ? children.length : 0,
        imageUrl: face,
        photoCount: ownImages.filter(image => (image.mediaType ?? 'IMAGE') === 'IMAGE').length,
        imageInherited: face !== null && ownFace === null,
        productMedia,
        ...(productMediaError ? { productMediaError } : {}),
        axisValues,
        aliasId: projection.id,
        values: { ...values, ...relationshipValues({ parentId: product.parentId, isParent }, product.parentId ? root.sku : null) },
        listing,
        readiness,
        completeness: completenessFor(columns, rowShape, plainValues),
      })
    }
  }

  // ── 6. alias group summaries ──────────────────────────────────────
  const aliases: AliasGroup[] = coordinate
    ? groups.map((g) => {
        const mine = rows.filter((r) => r.aliasId === g.id)
        const errors = mine.reduce((n, r) => n + r.readiness.issues.filter((i) => i.severity === 'error').length, 0)
        const warnings = mine.reduce((n, r) => n + r.readiness.issues.filter((i) => i.severity === 'warn').length, 0)
        const rowsMissingRequired = mine.filter((r) => r.readiness.issues.some((i) => i.severity === 'error')).length
        // Readiness is measured against the REQUIRED-field schema (layout §1),
        // not overall completeness: a listing is publishable when what the
        // channel demands is present, regardless of optional richness.
        //
        // Count this coordinate's static and evaluated conditional requirements.
        // Other marketplace requirements cannot affect this destination.
        let filled = 0
        let total = 0
        for (const r of mine) {
          for (const c of columns) {
            if (!columnApplies(c, { isParent: r.isParent, productType: r.productType, familyId: r.familyId })) continue
            if (!r.values[c.key]?.mapped?.requiredByRule && !columnRequiredHere(c, coordinate.label, r.productType, r.familyId, r.values)) continue
            total++
            if (!r.values[c.key]?.needsTranslation && !isBlank(r.values[c.key]?.value)) filled++
          }
        }
        const headRow = mine.find((r) => r.isParent) ?? mine[0]
        return {
          id: g.id,
          label: g.label,
          position: g.position,
          status: g.status,
          externalListingId: headRow?.listing?.externalListingId ?? null,
          listingStatus: headRow?.listing?.listingStatus ?? null,
          isPublished: headRow?.listing?.isPublished ?? null,
          readiness: {
            percent: mine.some(row => missingSchemaFor(row.productType)) ? null : total > 0 ? Math.round((filled / total) * 100) : null,
            state: errors > 0 ? 'errors' : rowsMissingRequired > 0 ? 'missing' : headRow?.readiness.state ?? 'unlisted',
            errors,
            warnings,
            rowsMissingRequired,
          },
          rowIds: mine.map((r) => r.id),
        }
      })
    : []

  // #327(14) — routing on the COLUMN, not only on cells that happen to hold a
  // value. `values` omits a cell entirely when it is blank (`if (!base) continue`
  // below), so on a measured Amazon·IT read only 7 of 142 fields carried a write
  // target: routing was present exactly where it was least needed (already-filled
  // fields) and absent on the empty field the operator is about to edit — which is
  // what left the drawer guessing. `resolveWriteRouting` is a pure function of
  // (column, coordinate): its third parameter is never read, so the answer cannot
  // vary by row and belongs here. Emitted ALONGSIDE the per-cell copies, not
  // instead of them, so no existing consumer changes.
  // #371 / layout spec §9.3 — the master-scope width the SERVER owns, so PES.2's
  // client-side `SPEC_WIDTHS` allow-list can shrink to nothing.
  //
  // `name` arrives from the field registry at 380, a width chosen for the
  // catalogue grid. In the studio it is wrong for a measured reason: every row
  // of a family carries the SAME parent title (all 21 GALE-JACKET rows share an
  // identical 100-char name), so at 380 the widest column on the sheet is also
  // the one that discriminates between rows least.
  //
  // EVERY scope, per §9.3c (UX.1, spec owner). The spec originally said "master"
  // because that is where it was measured, not because the channel scope had
  // been ruled differently — and re-measuring made the case stronger: on
  // eBay·IT the 21 name cells hold 3 distinct values that are byte-identical
  // for their first 127 characters. 380px shows ~45-50 characters and 220px
  // shows ~26-30, so NEITHER reaches the first difference; the extra 160px buys
  // no discrimination at all, and what does distinguish those rows already has
  // its own columns (Colore x Taglia). On the channel scope it also pays for
  // itself: eBay·IT measured 1,404px of columns against a 1,372px grid area,
  // and 160px back takes it to 1,244 — the first scope here to fit at 1440 with
  // no horizontal scroll.
  //
  // Serving 220 on one scope and 380 on the other would leave the client
  // compensating for a contract that disagrees with itself, which is exactly
  // what PES.2's `SPEC_WIDTHS` map was.
  // P11 — computed once, here, because it is the only place that knows BOTH
  // the column set and the family. `buildAxes` pairs each axis with the KEY its
  // values are actually stored under; the labels never enter the comparison.
  const familyAxes = buildAxes(
    (root.variationAxes as string[]) ?? [],
    rows.filter((r) => !r.isParent).map((r) => r.axisValues),
  )
  const axisKeys = new Set((root.variationAxes ?? []).map(canonicalVariantAxis))

  const columnsWithRouting = columns.map((col) => ({
    ...col,
    ...resolveWriteRouting(col, coordinate, null),
    ...(SPEC_WIDTHS[col.key] !== undefined ? { width: SPEC_WIDTHS[col.key] } : {}),
    // Case-insensitive EXACT key match — `color` is the column, `Color` the
    // stored axis key. Never a substring: that is what made `size` invisible.
    // Both `stored` and `declared` axes count: a declared axis IS one of the
    // family's axes even with nothing written under it yet, and coverage is
    // reported separately per axis in `family.axes[].rowsWithValue`.
    axis: col.scope === 'per_variant' && axisKeys.has(canonicalVariantAxis(col.key)),
    // #756 — would the FORMULA writer accept this column here? Asked of the
    // writer's own gate, not a copy. Routing decides the scope: a write landing
    // on the Product is gated by MASTER_WRITABLE; the channel writer merges into
    // `overrideData` and has NO field gate at all, so every channel-routed
    // column is writable as far as the column is concerned. (The channel write
    // still throws when the product has no listing on the coordinate — a row
    // condition, not a column one, and deliberately not encoded here.)
    // #775 — ONE gate, asked of the ROUTED name, with no scope branch: the
    // writer a formula now uses is the writer an ordinary cell edit uses, so
    // "can a formula write this" and "can the operator type into this" are the
    // same question. Asked of `writeField` because that is the name the writer
    // receives — #758 asked this same function the routed name here and the raw
    // key in the writer, so the sheet offered columns the writer refused.
    // AND the column must be editable at all. Measured after the widening:
    // `sku` and `condition_type` are in the writer's gate but read-only on the
    // sheet, so the gate alone would let a formula write what an operator
    // cannot type — MORE than the rule allows, not less. "Anything the operator
    // can type" has two halves and the writer's gate is only one of them.
    formulaWritable: col.shopifyField || coordinate && resolveWriteRouting(col, coordinate, null).writeTarget === 'master' ? false :
      col.editable && writerAcceptsField(resolveWriteRouting(col, coordinate, null).writeField),
  }))

  return {
    scope,
    family: {
      id: root.id,
      sku: root.sku,
      name: root.name ?? null,
      productType: root.productType ?? null,
      variationAxes: (root.variationAxes as string[]) ?? [],
      axes: familyAxes,
    },
    columns: [...relationshipColumns.map(col => ({ ...col, ...resolveWriteRouting(col, coordinate, null), writable: false, affectsAllChannels: false, writeBlockedReason: col.helpText, formulaWritable: false, axis: false })), ...columnsWithRouting],
    groups: [RELATIONSHIP_GROUP, ...(columnGroups ?? [])],
    aliases,
    rows,
    // D14.3 — counts are SERVER-STATED. A client deriving them from the rows it
    // was sent would be counting a page and calling it a total (#357).
    //
    // `null` means "not counted", which is a different fact from 0 — and 0 is a
    // real answer here, so the two must not share a value. `mapped` is null
    // exactly when the enrichment did not run: reporting 0 mapped cells because
    // the resolver timed out would be a measurement of our own failure
    // presented as a property of the data.
    counts: (() => {
      const all = rows.flatMap((r) => Object.values(r.values))
      return {
        total: all.length,
        filled: all.filter((c) => c.value !== null).length,
        empty: all.filter((c) => c.value === null).length,
        notWritable: all.filter((c) => !c.writable).length,
        pinned: all.filter((c) => c.pinned).length,
        // `null` on a MASTER scope too, not 0: the enrichment only runs for a
        // coordinate (`if (coordinate)`), so master never counts mapped cells at
        // all. Reporting 0 there would answer a question nobody asked — the
        // same error as reporting 0 when the resolver timed out.
        mapped: !coordinate || mappingMeta?.skippedReason
          ? null
          : all.filter((c) => c.mapped?.status === 'mapped').length,
      }
    })(),
    // #558 — the schema this payload was built against.
    //
    // `scope.marketplace` is NULL on a master scope, because a scope names a
    // COORDINATE and not the market the sheet was opened on. So without this a
    // client holding a master payload cannot say which marketplace's schema
    // produced its columns and caps. That gap is not hypothetical: storing the
    // scope without the market is exactly what made `apply` throw
    // `unknown_market` on every master job (#600) — the same fact missing in the
    // same place, one layer down.
    schema: { marketplace: market, locale },
    meta: { schemaMissing, schemaAge, droppedKeys, availableMarkets, coverage, tookMs: Date.now() - t0, phases: { ...phases, rows: Date.now() - _pm }, mapping: mappingMeta },
  }
}

export { UnknownMarketError }
