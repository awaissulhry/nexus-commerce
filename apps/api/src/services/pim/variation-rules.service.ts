/**
 * VT.1 - `resolveVariationProjection`: the family's axes projected onto ONE coordinate.
 *
 * Design `docs/2026-09-13-variation-theme-column-design.md` §3.2-§3.4; contract `docs/vt1-contracts.md` §1-§2.
 *
 * THREE TIERS, one function, on the server: `override` (the coordinate's parent listing row, per `aliasKey`) ->
 * `rule` (the mapping page's category rule, then channel-wide) -> `derived` (from `Product.variationAxes`). The
 * tier is always on the wire and always on screen, because "why does this cell say that" is the question an
 * operator asks first.
 *
 * PURE. Every fact it needs is passed in - the schema facts, the listing row, the rule, the limits, the
 * vocabulary - so it runs under `tsx` with no database and is unit-tested against the REAL enum copied out of a
 * `CategorySchema` row. The sheet layer does the reading; this file does the deciding.
 *
 * Two measured rules it exists to enforce:
 *  - `''` is not an override (T16 - an ACTIVE Amazon-IT row carries `variationTheme = ""`).
 *  - an attribute binding is looked up in the schema's `properties`, never composed as `${axis}_name` (T15 -
 *    `color_name` does not exist on OUTERWEAR, so that fallback named nothing on every push that reached it).
 */

import { hasVariationMappingOverride, isOwnAxisKey, ownAxisKey, parseOwnAxisKey, parseVariationMapping, type OwnAxisSource } from '@nexus/shared/variation-mapping'
import { variationAxisValue, variationCollisionGroups, variationCollisionSummary } from './variation-collisions.js'
import type { ProjectionLimits, ProjectionVocabulary } from './family-projection-limits.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import {
  attributeTitle,
  bindSegmentToAttribute,
  canonicalThemeSegment,
  classifyThemes,
  deriveAmazonTheme,
  addsForTheme,
  dropsForTheme,
  marketplaceIdFor,
  normaliseStoredTheme,
  offeredThemes,
  themeSegments,
  type ThemeSchemaFacts,
  type ThemeTieBreak,
} from './variation-theme-segments.js'

// ------------------------------------------------------------------
// The cell - `docs/vt1-contracts.md` §1. This shape IS the wire.
// ------------------------------------------------------------------

export interface VariationThemeAxis {
  axisKey: string
  familyKey: string
  label: string
  channelName: string
  target: string | null
  included: boolean
  segment?: string
  unbound?: { reason: string }
  /**
   * Sheet pop-up P3 — present on a CHANNEL-ONLY axis (one the family does not have): where its values come from
   * (`own:<from>:<field>`, `familyKey` is that raw key) and, on eBay, whether its name is outside eBay's list for the
   * category (`custom`: shown on the listing, not in eBay's search filters).
   */
  own?: OwnAxisSource & { custom: boolean }
}

export type VariationSourceKind = 'derived' | 'rule' | 'override' | 'none'
export type VariationTieBreak = ThemeTieBreak | 'kept-from-listing'

export interface VariationThemeCell {
  axes: VariationThemeAxis[]
  theme: { code: string; label: string; deprecated: boolean } | null
  source: {
    kind: VariationSourceKind
    ruleLabel: string | null
    category: string | null
    label: string
    tieBreak?: VariationTieBreak
  }
  candidates: {
    kind: 'theme-enum' | 'aspects' | 'free'
    items: Array<{ code: string; label: string; coversAll: boolean; drops: string[]; adds: string[]; deprecated: boolean; required?: boolean }>
    limit: number | null
    schemaFetchedAt: string | null
    /**
     * R-VT-7 — FOUR words, and `'ok'` is only ever sent with a NON-EMPTY `items`. `'unavailable'` = the
     * schema could not be read; `'no-theme'` = it was read and this product type declares none. The web
     * mirror (`grid/renderers/variationTheme.tsx`) carries the same union.
     */
    state: 'ok' | 'freeform' | 'unavailable' | 'no-theme'
    unavailableReason?: string
  } | null
  masterCandidates: Array<{ key: string; label: string; axisKey: string; valueCount: number }> | null
  dropped: string[]
  collisions: { unresolved: number; summary: string } | null
  /** VTR step 0 — INCLUDED variants with no value on a delivered axis; `skus` capped at 10. `null` = variants not read (not computed is not zero). */
  valueGaps: { unresolved: number; summary: string; skus: string[] } | null
  locked: {
    reason: string
    externalId: string | null
    setChangeIs: 'relist' | 'new-parent' | 'in-place'
    orderChangeAllowed: boolean
    /**
     * VT.F item A5 — WHICH axes this coordinate has already published, so a per-axis lock is expressed on
     * the SHEET cell and not only in the Variants dock. `[]` is a measured empty (nothing published under
     * this marketplace id yet); the field is always present on a locked cell so a reader never has to
     * distinguish "no axes" from "this producer does not serve it".
     */
    lockedAxisKeys: string[]
  } | null
  /**
   * VT.F item A5 — the FAMILY axes this coordinate does not deliver yet, which is what `+ Add a <noun>` adds.
   *
   * 🔴 It exists because the cell's `+ Add` used to offer the CHANNEL's `candidates` as axes, and on eBay that
   * is the site's aspects: picking `Scollatura` produced an `axisKey` the family does not have and the PATCH
   * answered 400. The dock had it right (VP.4 computed `page.axes` minus the mapped ones) and the cell had a
   * second, wrong list — the fork the shared-editor rule exists to prevent. ONE function, `addableAxesFor`,
   * now feeds both hosts.
   */
  addableAxes: Array<{ axisKey: string; familyKey: string; label: string }>
  /**
   * Sheet pop-up P3 — the channel's own axes this coordinate could ADD that live in a channel column (eBay: the
   * category's variation-enabled aspects no delivered axis uses yet), each with how many INCLUDED variants already
   * carry a value. `filled`/`of` are `null` when the variants were not read (not computed is not zero).
   */
  ownCandidates: Array<{ axisKey: string; name: string; label: string; filled: number | null; of: number | null }>
  /**
   * Sheet pop-up P3 — may this coordinate take an axis under a name the operator types? `allowed: false` always
   * carries the reason (Amazon: its own themes only). `maxLength` is the channel's sourced name cap, or `null`.
   */
  ownNames: {
    allowed: boolean
    maxLength: number | null
    reason: string | null
    /**
     * eBay: the names the category lists but NOT for variations, each with the server's own refusal (219451), so the pop-up
     * refuses a typed name before it saves, in the words the save would use. Absent where the channel refuses none.
     */
    refused?: Array<{ name: string; reason: string }>
  }
  /**
   * Sheet pop-up P3 — per delivered axis (`familyKey`), the distinct values the INCLUDED variants carry here, in
   * variant order, and how many carry one. The pop-up's chips and its "N variants empty" line read this, and it is
   * computed from the same variants as `valueGaps`, so the two cannot disagree. Absent when variants were not read.
   */
  valueSummary?: Record<string, { values: string[]; filled: number; of: number }>
  write: {
    endpoint: 'variation-axes' | 'projection'
    expectedVersion: number
    aliasKey: string
    coordinate: { channel: string | null; market: string; accountId: string | null }
    childIds?: string[]
  } | null
  deliveryNote?: string
  writable: boolean
  writeBlockedReason: string | null
  vocabulary: { axisNoun: string; axisNounPlural: string; sectionTitle: string }
  separator: string
}

// ------------------------------------------------------------------
// Inputs
// ------------------------------------------------------------------

export interface VariationCoordinate {
  /** `null` = the MASTER scope: the structure itself, not a projection of it. */
  channel: string | null
  market: string
  accountId: string | null
  /** '' = the primary listing. */
  aliasKey: string
  /** `Amazon - IT` - used verbatim in readiness messages and the editor title. */
  label: string
}

export interface VariationFamilyFacts {
  /** `Product.variationAxes` - the family's keys, in family order (`['Colore','Taglia']`). */
  familyAxes: string[]
  /** canonical axisKey -> the English label the sheet serves for that axis column. Derived, never spelled here. */
  axisLabels: Record<string, string>
  /** `Product.version` - the CAS token for the master write. */
  productVersion: number
  /** `Product.variationTheme` - the eBay axis SET store, ONE record for every eBay market (T2). */
  productTheme: string | null
  childIds: string[]
  /** For the collision rule. Absent => `collisions` is null (not computed is not zero). */
  variants?: Array<{ id: string; sku: string; included: boolean; axisValues: Record<string, string> }>
  /** MASTER only: the per-variant editable scalar columns (T1's rule), already filtered by the caller. */
  masterCandidates?: Array<{ key: string; label: string; axisKey: string; valueCount: number }>
}

export interface VariationListingFacts {
  /** `ChannelListing.version` - the CAS token for the projection write. */
  version: number
  variationTheme: string | null
  /** R-VT-13: either shape — the ORDERED `{axes:[…]}` or the flat legacy map. Parsed, never indexed. */
  variationMapping: unknown
  platformAttributes: Record<string, unknown> | null
  externalListingId: string | null
  listingStatus: string | null
  productType?: string | null
}

/** A mapping-page rule for this coordinate's category, or the channel-wide fallback (VX §11.1). */
export interface VariationRule {
  label: string
  category: string | null
  theme?: string | null
  mapping?: Array<{ axisKey: string; target: string | null; order?: number; included?: boolean }> | null
}

export interface VariationSchemaFacts {
  etsy?: { properties: Array<{ code: string; label: string; axisKey: string }>; fetchedAt: string | null; available: boolean }
  /** Amazon: the LATEST cached `CategorySchema` row for (marketplace, productType), expiry ignored (T17). */
  amazon?: { facts: ThemeSchemaFacts; fetchedAt: string | null } | null
  /**
   * eBay: the site's aspects for THIS coordinate's category. `aspects: []` with an `unavailableReason` means we
   * COULD NOT LOOK - measured on GALE eBay-DE, whose listing carries no category at all and whose IT category id
   * does not exist in the DE tree. That is a different sentence from "the category offers none".
   */
  ebay?: {
    categoryId: string | null
    aspects: Array<{ name: string; englishName?: string | null; variantEligible: boolean; required: boolean; columnKey?: string }>
    unavailableReason?: string | null
    /**
     * Sheet pop-up P3 — the category's aspects that are NOT enabled for variations (localised and English names). An
     * own axis under one of these names is refused: eBay answers 219451 ("… is not allowed as a variation specific").
     */
    nonVariationAspects?: string[]
  } | null
}

export interface ResolveVariationInput {
  coordinate: VariationCoordinate
  family: VariationFamilyFacts
  listing: VariationListingFacts | null
  rule: VariationRule | null
  schema: VariationSchemaFacts
  limits: ProjectionLimits
  vocabulary: ProjectionVocabulary
}

// ------------------------------------------------------------------
// Copy - design Appendix A, verbatim, ONE source
// ------------------------------------------------------------------

export const VT_COPY = {
  derived: 'Derived from the family axes',
  rule: (label: string) => `Follows rule ${label}`,
  override: 'Overridden here',
  setAxes: 'Set axes…',
  chooseTheme: 'Choose a theme',
  setOnParent: 'Set on the parent',
  amazonLock: (market: string, id: string, children: number) =>
    `Live on Amazon ${market} (${id}) — changing the theme creates a new parent and relinks ${children} children. Commit opens the plan.`,
  ebayLock: (site: string, id: string) =>
    `Live on eBay ${site} (item ${id}) — changing the set relists it. Reordering does not.`,
  genericLock: (channelName: string, market: string, id: string) =>
    `Live on ${channelName} ${market} (${id}) — changing the set is an operation. Commit opens the plan.`,
  /**
   * Sheet pop-up P3b, slice A4 (QUALITY-PLAN §4.11, the Owner's D1 a) — a product already on Shopify: Nexus has no
   * option create / update / delete call and refuses every change-only publish to it (`studio-publication.service.ts`),
   * so a saved order would never reach the store. Its options AND their order are locked here.
   */
  shopifyLock: (market: string, id: string) =>
    `Live on Shopify ${market} (${id}). Nexus cannot change the options of a product already on Shopify yet, so its options and their order are locked here.`,
  /** No listing here yet (product-sheet create path, step 4): the first save starts the coordinate's draft. */
  draftNote: (channelName: string, market: string) => `Saved to the ${channelName} · ${market} draft. Publish sends it.`,
  /** The draft creator's own refusal (`ensureDraftListings`), word for word, so the cell and the save agree. */
  connectAccount: (channelName: string, market: string) =>
    `Connect ${/^[aeiou]/i.test(channelName) ? 'an' : 'a'} ${channelName} account before listing on ${market}.`,
  aliasNoListing: (channelName: string, market: string) =>
    `This listing alias has no ${channelName} · ${market} listing. An edit never creates an alias listing.`,
  ebayNoCategory: (market: string) =>
    `This eBay ${market} listing has no category yet, so its variation specifics cannot be read.`,
  notASiteAspect:
    'Not a variation aspect on this eBay site — it publishes as a custom specific and is outside the filters.',
  noThemeCovers: "No theme on this product type covers this family's axes.",
  unboundAttribute: (segment: string) => `${segment} binds to no attribute of this product type.`,
  schemaUnavailable:
    'No cached schema for this product type on this marketplace, so its themes cannot be listed.',
  noCollisions: '0 collisions on this coordinate',
  /* Sheet pop-up P3 — channel-only axes. */
  ownNameMissing: (noun: string) => `Name this ${noun}.`,
  ownNameTooLong: (channelName: string, noun: string, max: number) => `${channelName} ${noun} names are at most ${max} characters.`,
  ebayNotForVariations: (name: string) =>
    `eBay lists ${name} for this category, but not for variations. eBay refuses it as a variation specific (error 219451). Choose another name.`,
  ebayNotAnAspect: (name: string) => `${name} is not a variation specific in this eBay category.`,
  amazonOwnAxes: 'Amazon decides the axes. Choose a theme from its list.',
  ownNotYet: (channelName: string) => `Axes that exist only on ${channelName} are not available yet.`,
  etsyOwnFromAttribute: 'An Etsy-only property takes its values from an attribute.',
  shopifyOwnFromAttribute: 'A Shopify-only option takes its values from an attribute.',
} as const

/** Amazon joins delivered names with ` / `; every other channel with a middot (design §3.3). */
export function separatorFor(channel: string | null): string {
  return String(channel ?? '').toUpperCase() === 'AMAZON' ? ' / ' : ' · '
}

const humanise = (key: string): string =>
  String(key ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim()

/** The English label for an axis: the sheet's own column label, else the family key humanised. */
function labelFor(axisKey: string, familyKey: string, labels: Record<string, string>): string {
  const label = labels?.[axisKey] ?? labels?.[familyKey] ?? humanise(familyKey)
  return label === 'Colour' ? 'Color' : label
}

export function channelDisplayName(channel: string): string {
  switch (String(channel ?? '').toUpperCase()) {
    case 'AMAZON': return 'Amazon'
    case 'EBAY': return 'eBay'
    case 'SHOPIFY': return 'Shopify'
    case 'ETSY': return 'Etsy'
    case 'WOOCOMMERCE': return 'WooCommerce'
    default: return humanise(channel)
  }
}

/**
 * Is this coordinate LIVE? The parent listing carries a published id and is not a draft or an ended listing.
 *
 * Derived from the published ID, never from the DECLARED axes. `family-projection.service.ts` documents why the
 * axis LOCK cannot be derived from the declared set (it equals the current set by construction, so every
 * coordinate would read as locked). WHETHER the coordinate is live is a different question, and the external id
 * is real evidence for it: `GALE-JACKET` holds B0FXD0620C on Amazon-IT and item 938554736087 on eBay-IT, while
 * its eBay-DE, Shopify and Etsy rows are DRAFT with no id at all.
 */
export function isLiveCoordinate(listing: VariationListingFacts | null): boolean {
  if (!listing?.externalListingId) return false
  const status = String(listing.listingStatus ?? '').toUpperCase()
  return status !== 'DRAFT' && status !== 'ENDED' && status !== 'DELETED'
}

/**
 * VT.1b item 3 (VT.4) — THE definition of "locked" for a variation coordinate, exported so the projection read and the
 * cell cannot disagree.
 *
 * They did: `ProjectionRead.locked` derived it from `platformAttributes.__lastPublishedAxes` (which only eBay's push
 * writes), so GALE's Amazon coordinates read UNLOCKED on the projection wire and LOCKED on the cell — two answers to
 * "may I change the set here" for the same live ASIN. `docs/vt1-contracts.md` §1 specifies the cell's, so the cell's
 * is the one both now use, and the projection keeps `lockedAxisKeys` beside it as the extra fact its own write path
 * needs (WHICH axes are already published, which only that store can answer).
 */
export function variationLockFor(input: {
  coordinate: Pick<VariationCoordinate, 'channel' | 'market'>
  family: Pick<VariationFamilyFacts, 'childIds'>
  listing: VariationListingFacts | null
}): VariationThemeCell['locked'] {
  return lockFor(input as ResolveVariationInput)
}

/**
 * VT.1b item 2 (VT.4) — can `fold` actually RUN here?
 *
 * `fold` appends the dropped axis's value label to a surviving axis's value, and it does that by PINNING the child's
 * axis cell. VT.4 measured that on both coordinates it tried, every `values[axis].write` is `null` with the server's
 * own reason — before and after a mapping is stored — so "an axis survives" was never enough to make fold available.
 * Availability now requires a WRITABLE target cell on at least one included variant, and the reason names the axis and
 * repeats the server's sentence rather than inventing one.
 *
 * `projection: null` = the caller has no per-coordinate cell facts (a category-wide rule read). That is NOT available:
 * whether a cell is writable is a coordinate fact, and answering `true` without it is the guess this fixes.
 */
export function foldAvailability(
  projection: {
    children: Array<{ included: boolean; values: Record<string, { write: unknown; writeBlockedReason?: string | null }> }>
    axes?: Array<{ key: string; label: string }>
  } | null,
  survivingAxisKeys: string[],
): { available: boolean; reason: string | null; foldInto: string | null } {
  if (survivingAxisKeys.length === 0) {
    return { available: false, reason: 'No axis survives on this coordinate to fold the dropped value into.', foldInto: null }
  }
  if (!projection) {
    return {
      available: false,
      foldInto: null,
      reason: 'Folding pins a value on each variant’s axis cell, and whether that cell can be written is decided per coordinate. Open the family to see it.',
    }
  }
  let blocked: string | null = null
  for (const axisKey of survivingAxisKeys) {
    for (const child of projection.children) {
      if (!child.included) continue
      const cell = child.values?.[axisKey]
      if (!cell) continue
      if (cell.write) return { available: true, reason: null, foldInto: axisKey }
      blocked ??= cell.writeBlockedReason ?? null
    }
  }
  const label = projection.axes?.find((a) => a.key === survivingAxisKeys[0])?.label ?? survivingAxisKeys[0]
  return {
    available: false,
    foldInto: null,
    reason: blocked
      ? `Folding writes a value on each variant’s ${label} cell, and that cell cannot be written here: ${blocked}`
      : `Folding writes a value on each variant’s ${label} cell, and no included variant has a writable ${label} cell on this coordinate.`,
  }
}

/**
 * VT.F item A5 — WHICH axes a coordinate has already published, from the ONE store that can answer it.
 *
 * `platformAttributes.__lastPublishedAxes[<marketplaceId>]` is written by the publish paths, so it is a
 * record of what went out — never derived from the DECLARED set, which equals the current set by
 * construction and would make every coordinate look fully locked (the same false negative the eBay
 * preflight documents for `priorPublishedAxisNames`). `family-projection.service.ts` had this block
 * inline for its own `locked.lockedAxisKeys`; both callers use this function now, so the dock and the
 * sheet cell cannot disagree about which axis is frozen.
 */
export function lockedAxisKeysFrom(
  platformAttributes: Record<string, unknown> | null | undefined,
  channel: string | null,
  market: string,
): string[] {
  const bag = ((platformAttributes ?? {}).__lastPublishedAxes ?? {}) as Record<string, unknown>
  const published = bag[marketplaceIdFor(String(channel ?? ''), market)]
  return Array.isArray(published) ? (published as unknown[]).filter((v): v is string => typeof v === 'string') : []
}

/**
 * VT.F item A5 — the family axes this coordinate does not deliver yet: what `+ Add a <noun>` adds.
 *
 * 🔴 Not the channel's candidate list. The cell's `+ Add` offered `candidates.items`, which on eBay are the
 * site's ASPECTS, so adding `Scollatura` produced an axisKey the family has no values for and the PATCH
 * answered 400. `included: false` counts as NOT delivered — a dropped axis is exactly one an operator may
 * want back.
 */
export function addableAxesFor(cell: Pick<VariationThemeCell, 'axes'>, family: VariationFamilyFacts): Array<{ axisKey: string; familyKey: string; label: string }> {
  const delivered = new Set(cell.axes.filter((a) => a.included).map((a) => a.axisKey))
  return familyAxisList(family).filter((a) => !delivered.has(a.axisKey))
}

function lockFor(input: ResolveVariationInput): VariationThemeCell['locked'] {
  const { coordinate, family, listing } = input
  if (!isLiveCoordinate(listing)) return null
  const channel = String(coordinate.channel ?? '').toUpperCase()
  const id = String(listing!.externalListingId)
  const lockedAxisKeys = lockedAxisKeysFrom(listing!.platformAttributes, channel, coordinate.market)
  if (channel === 'AMAZON') {
    return { reason: VT_COPY.amazonLock(coordinate.market, id, (family.childIds ?? []).length), externalId: id, setChangeIs: 'new-parent', orderChangeAllowed: false, lockedAxisKeys }
  }
  if (channel === 'EBAY') {
    return { reason: VT_COPY.ebayLock(coordinate.market, id), externalId: id, setChangeIs: 'relist', orderChangeAllowed: true, lockedAxisKeys }
  }
  if (channel === 'SHOPIFY') {
    return { reason: VT_COPY.shopifyLock(coordinate.market, id), externalId: id, setChangeIs: 'in-place', orderChangeAllowed: false, lockedAxisKeys }
  }
  return { reason: VT_COPY.genericLock(channelDisplayName(channel), coordinate.market, id), externalId: id, setChangeIs: 'relist', orderChangeAllowed: false, lockedAxisKeys }
}

/** The stored coordinate set, including explicit empty overrides. Reset skips legacy product fallback. */
export function ebayAxisSet(
  listing: VariationListingFacts | null,
  productTheme: string | null,
): { names: string[]; from: 'coordinate' | 'product' | 'none' } {
  const stored = (listing?.platformAttributes ?? {}) as Record<string, unknown>
  if (stored._variationAxesMode === 'inherit') return { names: [], from: 'none' }
  const own = Array.isArray(stored._variationAxes)
    ? (stored._variationAxes as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : []
  if (own.length > 0 || stored._variationAxesMode === 'override') return { names: own, from: 'coordinate' }
  const product = splitSetString(productTheme)
  if (product.length > 0) return { names: product, from: 'product' }
  return { names: [], from: 'none' }
}

/**
 * The ONE eBay declared-axis rule, for the three readers that disagreed (design T3, Appendix C; VX D1 / M3).
 *
 * Before VT.1:
 *   `ebay-variation-push.service.ts:904`  Product.variationTheme -> the coordinate's `_variationAxes`
 *   `ebay-family-axes.service.ts:232`     the LISTING's `variationTheme` column -> Product -> `_variationAxes`
 *   `family-projection.service.ts` (readStoredMapping)  Product -> `_variationAxes`
 * so the Variants page could show one set while the push sent another.
 *
 * After: the coordinate's `_variationAxes` when NON-EMPTY, else `Product.variationTheme`. The retired listing
 * COLUMN tier is gone - no push path reads it (T5), and keeping it would resurrect the store this change retires.
 *
 * Measured on the local catalogue before the change (`apps/api/scripts/_vt1-ebay-precedence.mts`, 38 eBay parent
 * listing rows): the PUSH's declared axes are identical on **38 of 38** rows; the family-axes READ changes on
 * exactly **1** - GALE-JACKET eBay-IT (ACTIVE, item 938554736087) read `["Color","Size"]` from the listing column
 * while the push sent `["Colore","Taglia"]`, and after this change the read agrees with what ships.
 *
 * Returns `null` (not `[]`) when nothing is declared, because both callers distinguish "no declared axes, discover
 * them" from "an empty declared set".
 */
export function ebayDeclaredAxes(platformAttributes: unknown, productTheme: string | null | undefined): string[] | null {
  const set = ebayAxisSet({ platformAttributes: (platformAttributes ?? null) as Record<string, unknown> | null } as VariationListingFacts, productTheme ?? null)
  return set.from === 'coordinate' || set.names.length > 0 ? set.names : null
}

/**
 * Split an eBay SET string. Kept byte-compatible with `parseThemeAxes` (`, / | ;`, trim, case-insensitive dedupe,
 * cap 5) WITHOUT importing it: that module is imported by the push service and by `family-projection-limits`, and
 * this file must stay pure. `variation-rules.vitest.test.ts` asserts the two agree on every stored value in the
 * catalogue plus the delimiter matrix, so a divergence fails a test rather than a listing.
 */
export function splitSetString(value: string | null | undefined): string[] {
  if (typeof value !== 'string') return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value.split(/[,/|;]/)) {
    const name = raw.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= 5) break
  }
  return out
}

// ------------------------------------------------------------------
// The resolver
// ------------------------------------------------------------------

export function resolveVariationProjection(input: ResolveVariationInput): VariationThemeCell {
  const channel = input.coordinate.channel === null ? null : String(input.coordinate.channel).toUpperCase()
  if (channel === null) return resolveMaster(input)
  if (channel === 'AMAZON') return resolveAmazon(input)
  if (channel === 'EBAY') return resolveEbay(input)
  return resolveNamedAxes(input)
}

/** The family's axes as `{ axisKey, familyKey, label }`, in family order. */
function familyAxisList(family: VariationFamilyFacts): Array<{ axisKey: string; familyKey: string; label: string }> {
  return (family.familyAxes ?? [])
    .filter((a) => typeof a === 'string' && a.trim().length > 0)
    .map((familyKey) => {
      const axisKey = canonicalVariantAxis(familyKey)
      return { axisKey, familyKey, label: labelFor(axisKey, familyKey, family.axisLabels ?? {}) }
    })
}

function resolveMaster(input: ResolveVariationInput): VariationThemeCell {
  const axes = familyAxisList(input.family).map((a) => ({
    axisKey: a.axisKey, familyKey: a.familyKey, label: a.label, channelName: a.label, target: a.axisKey, included: true,
  }))
  const hasAxes = axes.length > 0
  return {
    axes,
    theme: null,
    source: {
      kind: hasAxes ? 'derived' : 'none',
      ruleLabel: null,
      category: null,
      label: hasAxes ? VT_COPY.derived : VT_COPY.setAxes,
    },
    candidates: null,
    masterCandidates: input.family.masterCandidates ?? [],
    dropped: [],
    collisions: null,
    valueGaps: null,
    locked: null,
    /* MASTER's `+ Add axis` list is `masterCandidates` (the per-variant editable scalar columns, T1's
       rule) — a different vocabulary from a channel's "family axis not delivered here", so this is
       empty and the panel reads `masterCandidates` on that host. Empty, never absent: an optional
       field would put the two hosts back on two shapes. */
    addableAxes: [],
    ownCandidates: [],
    ownNames: { allowed: false, maxLength: null, reason: null },
    write: {
      endpoint: 'variation-axes',
      expectedVersion: input.family.productVersion,
      aliasKey: '',
      coordinate: { channel: null, market: input.coordinate.market, accountId: null },
      childIds: input.family.childIds ?? [],
    },
    writable: true,
    writeBlockedReason: null,
    vocabulary: input.vocabulary,
    separator: separatorFor(null),
  }
}

/**
 * Sheet pop-up P3 — may this channel take an axis under a typed name? eBay (P3-D1 b), Etsy (its two custom variation
 * slots) and Shopify (P3b, slice A4: a free option name ≤ 255, values from a Shared per-variant attribute) may; Amazon
 * never (its themes only, the Owner's rule). Any other channel is refused with this reason (no silent drop at publish).
 */
function ownNamesFor(channel: string, limits: ProjectionLimits | undefined, refused?: string[]): VariationThemeCell['ownNames'] {
  const maxLength = limits?.nameLength ?? null
  if (channel === 'EBAY' || channel === 'ETSY' || channel === 'SHOPIFY') return { allowed: true, maxLength, reason: null, ...(refused?.length ? { refused: refused.map(name => ({ name, reason: VT_COPY.ebayNotForVariations(name) })) } : {}) }
  if (channel === 'AMAZON') return { allowed: false, maxLength: null, reason: VT_COPY.amazonOwnAxes }
  return { allowed: false, maxLength, reason: VT_COPY.ownNotYet(channelDisplayName(channel)) }
}

/** A channel-only axis's name check, shared by every channel that takes typed names. `null` = the name is fine. */
function ownNameProblem(name: string, channel: string, noun: string, maxLength: number | null): string | null {
  if (!name) return VT_COPY.ownNameMissing(noun)
  if (maxLength !== null && name.length > maxLength) return VT_COPY.ownNameTooLong(channelDisplayName(channel), noun, maxLength)
  return null
}

/**
 * Sheet pop-up P3 — one eBay channel-only axis. `own:channel:<column>` is a variation-enabled aspect of the category
 * and keeps eBay's own name; `own:shared:<attribute>` carries the operator's name (P3-D1 b): refused when empty,
 * too long, or one eBay lists for the category but not for variations (219451); `custom` when eBay does not list it.
 */
function ebayOwnAxis(
  key: string,
  own: OwnAxisSource,
  typedName: string | null,
  ebay: NonNullable<VariationSchemaFacts['ebay']> | null,
  unavailableReason: string | null,
  input: ResolveVariationInput,
): VariationThemeAxis {
  const eligible = (ebay?.aspects ?? []).filter(a => a.variantEligible)
  const noun = input.vocabulary.axisNoun
  if (own.from === 'channel') {
    const aspect = eligible.find(a => !!a.columnKey && canonicalVariantAxis(a.columnKey) === canonicalVariantAxis(own.field))
    const name = aspect?.name ?? typedName ?? humanise(own.field)
    return { axisKey: canonicalVariantAxis(key), familyKey: key, label: aspect?.englishName ?? name, channelName: name, target: aspect?.name ?? null, included: true,
      own: { ...own, custom: false },
      ...(aspect ? {} : { unbound: { reason: unavailableReason ?? VT_COPY.ebayNotAnAspect(name) } }) }
  }
  const name = (typedName ?? '').trim()
  const listed = eligible.some(a => a.name.toLocaleLowerCase() === name.toLocaleLowerCase())
  const refused = !listed && (ebay?.nonVariationAspects ?? []).some(n => n.toLocaleLowerCase() === name.toLocaleLowerCase())
  const problem = unavailableReason ?? ownNameProblem(name, 'EBAY', noun, input.limits?.nameLength ?? null) ?? (refused ? VT_COPY.ebayNotForVariations(name) : null)
  return { axisKey: canonicalVariantAxis(key), familyKey: key, label: name || humanise(own.field), channelName: name || humanise(own.field), target: name || null, included: true,
    own: { ...own, custom: !listed }, ...(problem ? { unbound: { reason: problem } } : {}) }
}

/** Sheet pop-up P3 — a channel-only axis on Shopify, Etsy or another named-axes channel. */
function namedOwnAxis(key: string, own: OwnAxisSource, typedName: string | null, channel: string, input: ResolveVariationInput): VariationThemeAxis {
  const name = (typedName ?? '').trim()
  const policy = ownNamesFor(channel, input.limits)
  const problem = !policy.allowed ? policy.reason
    : channel === 'ETSY' && own.from !== 'shared' ? VT_COPY.etsyOwnFromAttribute
      /* A4 — Shopify has no option list of its own: an own option is a typed name over a Shared attribute's values. */
      : channel === 'SHOPIFY' && own.from !== 'shared' ? VT_COPY.shopifyOwnFromAttribute
        : ownNameProblem(name, channel, input.vocabulary.axisNoun, policy.maxLength)
  return { axisKey: canonicalVariantAxis(key), familyKey: key, label: name || humanise(own.field), channelName: name || humanise(own.field), target: name || null, included: true,
    own: { ...own, custom: true }, ...(problem ? { unbound: { reason: problem } } : {}) }
}

/** The shell every channel projection fills in, so no branch invents a field. */
function channelShell(input: ResolveVariationInput): VariationThemeCell {
  const channel = String(input.coordinate.channel ?? '').toUpperCase()
  const noListing = !input.listing
  // Product-sheet create path, step 4 (D1 = A) — with no listing here the theme is still writable: its first save
  // (token 0 = "I saw no listing") starts the family's draft on this coordinate and lands on the new parent draft.
  // Only the primary listing is started, and only with an account to start it under.
  const blockedReason = !noListing ? null
    : input.coordinate.aliasKey ? VT_COPY.aliasNoListing(channelDisplayName(channel), input.coordinate.market)
      : !input.coordinate.accountId ? VT_COPY.connectAccount(channelDisplayName(channel), input.coordinate.market) : null
  return {
    axes: [],
    theme: null,
    source: { kind: 'none', ruleLabel: null, category: null, label: VT_COPY.setAxes },
    candidates: null,
    masterCandidates: null,
    dropped: [],
    collisions: null,
    valueGaps: null,
    locked: lockFor(input),
    /* Filled by each channel branch once it knows what it delivers — `applyAddableAxes` at the end of
       each resolver, so no branch can forget it and no branch computes its own list. */
    addableAxes: [],
    ownCandidates: [],
    ownNames: ownNamesFor(channel, input.limits, channel === 'EBAY' ? input.schema.ebay?.nonVariationAspects : undefined),
    write: blockedReason ? null : {
      endpoint: 'projection',
      expectedVersion: input.listing?.version ?? 0,
      aliasKey: input.coordinate.aliasKey ?? '',
      coordinate: { channel, market: input.coordinate.market, accountId: input.coordinate.accountId ?? null },
    },
    ...(channel === 'ETSY' ? { deliveryNote: 'Saved as a Nexus draft. Publishing Etsy variation properties is not available yet.' }
      : noListing && !blockedReason ? { deliveryNote: VT_COPY.draftNote(channelDisplayName(channel), input.coordinate.market) } : {}),
    writable: !blockedReason,
    writeBlockedReason: blockedReason,
    vocabulary: input.vocabulary,
    separator: separatorFor(channel),
  }
}

function resolveAmazon(input: ResolveVariationInput): VariationThemeCell {
  const cell = channelShell(input)
  const wanted = familyAxisList(input.family)
  // Sheet pop-up P3 — Amazon takes no channel-only axis (its themes decide); a stored one is never read as a segment.
  const explicitMapping = effectiveVariationMapping(input)?.filter(a => !isOwnAxisKey(a.axisKey)) ?? null
  const wantedKeys = explicitMapping ? explicitMapping.map(a => canonicalThemeSegment(a.target ?? a.axisKey)) : wanted.map(a => a.axisKey)
  const amazon = input.schema.amazon ?? null
  const facts: ThemeSchemaFacts = amazon?.facts ?? { properties: {}, themes: [], deprecated: [] }
  const properties = facts.properties ?? {}
  const dead = new Set(facts.deprecated ?? [])

  // -- the three tiers, in order --------------------------------------
  const stored = normaliseStoredTheme(input.listing?.variationTheme)
  const hasOverride = hasVariationMappingOverride(input.listing?.variationMapping)
  const ruleTheme = hasOverride ? null : normaliseStoredTheme(input.rule?.theme)
  let code: string | null = null
  let kind: VariationSourceKind = 'none'
  let tieBreak: VariationTieBreak | undefined
  if (stored) {
    code = stored
    kind = 'override'
    tieBreak = 'kept-from-listing'
  } else if (ruleTheme) {
    code = ruleTheme
    kind = 'rule'
  } else {
    const derived = deriveAmazonTheme(wantedKeys, facts)
    if (derived) {
      code = derived.match.code
      kind = hasOverride ? 'override' : input.rule?.mapping ? 'rule' : 'derived'
      tieBreak = derived.tieBreak
    }
  }

  // -- the axes the theme delivers, in the THEME's order, each bound to a real property --
  const axes: VariationThemeAxis[] = []
  const deliveredKeys: string[] = []
  if (code) {
    for (const segment of themeSegments(code)) {
      const bound = bindSegmentToAttribute(segment, properties)
      const mapped = explicitMapping?.find(a => a.target === bound?.attribute)
      const fromFamily = wanted.find(a => a.axisKey === (explicitMapping ? canonicalVariantAxis(mapped?.axisKey ?? '') : canonicalThemeSegment(segment)))
      const axisKey = fromFamily?.axisKey ?? canonicalThemeSegment(segment)
      deliveredKeys.push(axisKey)
      const title = attributeTitle(bound?.attribute ?? null, properties)
      axes.push({
        axisKey,
        familyKey: fromFamily?.familyKey ?? segment,
        label: fromFamily?.label ?? humanise(axisKey),
        channelName: title ?? humanise(bound?.attribute ?? segment),
        target: bound?.attribute ?? null,
        included: true,
        segment,
        ...(bound && fromFamily ? {} : { unbound: { reason: !fromFamily ? `No family axis supplies ${segment}.` : VT_COPY.unboundAttribute(segment) } }),
      })
    }
  }
  // Axes the theme does NOT deliver are named as dropped - never silently absent (VX §6).
  for (const a of wanted) {
    if (deliveredKeys.indexOf(a.axisKey) >= 0) continue
    axes.push({ axisKey: a.axisKey, familyKey: a.familyKey, label: a.label, channelName: a.label, target: null, included: false })
  }

  cell.axes = axes
  cell.theme = code
    ? { code, label: axes.filter((a) => a.included).map((a) => a.channelName).join(' / ') || code, deprecated: dead.has(code) }
    : null
  cell.source = {
    kind,
    ruleLabel: kind === 'rule' ? (input.rule?.label ?? null) : null,
    category: kind === 'rule' ? (input.rule?.category ?? null) : null,
    label: kind === 'override' ? VT_COPY.override
      : kind === 'rule' ? VT_COPY.rule(input.rule?.label ?? '')
        : kind === 'derived' ? VT_COPY.derived
          : wanted.length === 0 ? VT_COPY.setAxes : VT_COPY.chooseTheme,
    ...(tieBreak ? { tieBreak } : {}),
  }
  if (kind === 'none' && wanted.length > 0) {
    // The axes exist and no theme covers them: the cell reads `Choose a theme` and every axis is unbound.
    cell.axes = wanted.map((a) => ({
      axisKey: a.axisKey, familyKey: a.familyKey, label: a.label, channelName: a.label, target: null, included: true,
      unbound: { reason: VT_COPY.noThemeCovers },
    }))
  }

  // Wave 2 A4 — only the themes Amazon accepts, plus this cell's own theme even when Amazon deprecated it.
  const items = offeredThemes(classifyThemes(facts), code).map((t) => {
    const labels = themeSegments(t.code).map((segment) => {
      const bound = bindSegmentToAttribute(segment, properties)
      return attributeTitle(bound?.attribute ?? null, properties) ?? humanise(bound?.attribute ?? segment)
    })
    const drops = dropsForTheme(t.keys, wantedKeys)
    const adds = addsForTheme(t.keys, wantedKeys)
    return {
      code: t.code,
      label: labels.join(' / '),
      // `Covers every axis` means exactly that AND nothing more: a theme that also demands a value the family
      // does not have is a different offer, and `adds` is how the editor says so.
      coversAll: drops.length === 0 && adds.length === 0 && wantedKeys.length > 0,
      drops,
      adds,
      deprecated: t.deprecated,
    }
  })
  cell.candidates = {
    kind: 'theme-enum',
    items,
    limit: input.limits?.axes ?? null,
    schemaFetchedAt: amazon?.fetchedAt ?? null,
    state: !amazon ? 'unavailable' : items.length ? 'ok' : 'no-theme',
    ...(!amazon ? { unavailableReason: VT_COPY.schemaUnavailable } : {}),
  }
  applyLimitAndCollisions(cell, input)
  return cell
}

/** Null means inherit; an empty array is a deliberate empty projection. */
export function effectiveVariationMapping(input: ResolveVariationInput): Array<{ axisKey: string; target: string | null }> | null {
  if (hasVariationMappingOverride(input.listing?.variationMapping)) return parseVariationMapping(input.listing!.variationMapping).entries
  if (input.rule?.mapping) return input.rule.mapping.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).filter(a => a.included !== false)
  return null
}

function resolveEbay(input: ResolveVariationInput): VariationThemeCell {
  const cell = channelShell(input)
  const wanted = familyAxisList(input.family)
  const ebay = input.schema.ebay ?? null
  const eligible = (ebay?.aspects ?? []).filter(a => a.variantEligible)
  const unavailable = !ebay || !ebay.categoryId || !!ebay.unavailableReason
  const unavailableReason = ebay?.unavailableReason ?? VT_COPY.ebayNoCategory(input.coordinate.market)
  const set = ebayAxisSet(input.listing, input.family.productTheme)
  const storedNames = (input.listing?.platformAttributes?._axisNameLabels ?? {}) as Record<string, unknown>
  const rule = set.from !== 'coordinate' ? input.rule?.mapping : null
  const entries = set.from === 'coordinate' || (!rule && set.from === 'product')
    ? set.names.map(axisKey => ({ axisKey, target: typeof storedNames[axisKey] === 'string' ? String(storedNames[axisKey]) : null }))
    : rule ? rule.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).filter(a => a.included !== false)
      : wanted.map(a => ({ axisKey: a.familyKey, target: null }))
  cell.axes = entries.map(entry => {
    const own = parseOwnAxisKey(entry.axisKey)
    if (own) return ebayOwnAxis(entry.axisKey, own, entry.target ?? null, ebay, unavailable ? unavailableReason : null, input)
    const axisKey = canonicalVariantAxis(entry.axisKey)
    const family = wanted.find(a => a.axisKey === axisKey)
    const explicit = entry.target ?? (set.from === 'coordinate' && typeof storedNames[family?.familyKey ?? ''] === 'string' ? String(storedNames[family!.familyKey]) : null)
    const aspect = explicit ? eligible.find(a => a.name === explicit) : eligible.find(a => canonicalVariantAxis(a.name) === axisKey || canonicalVariantAxis(a.englishName ?? '') === axisKey)
    const target = explicit ?? aspect?.name ?? null
    return { axisKey, familyKey: family?.familyKey ?? entry.axisKey, label: family?.label ?? humanise(entry.axisKey), channelName: target ?? entry.axisKey, target, included: true,
      ...(!family ? { unbound: { reason: `The family has no ${entry.axisKey} axis.` } } : aspect ? {} : { unbound: { reason: unavailable ? unavailableReason : VT_COPY.notASiteAspect } }) }
  })
  for (const axis of wanted) if (!cell.axes.some(a => a.axisKey === axis.axisKey)) cell.axes.push({ ...axis, channelName: axis.label, target: null, included: false })
  const kind: VariationSourceKind = set.from === 'coordinate' ? 'override' : rule ? 'rule' : wanted.length || set.names.length ? 'derived' : 'none'
  cell.source = { kind, ruleLabel: kind === 'rule' ? input.rule!.label : null, category: kind === 'rule' ? input.rule!.category : null,
    label: kind === 'override' ? VT_COPY.override : kind === 'rule' ? VT_COPY.rule(input.rule!.label) : kind === 'derived' ? (set.from === 'product' ? 'Inherited from the shared variation theme' : VT_COPY.derived) : VT_COPY.setAxes }
  // P3 A2 — a category eBay could not be read for cannot check a typed name (219451): own names wait, with the reason.
  if (unavailable) cell.ownNames = { allowed: false, maxLength: cell.ownNames.maxLength, reason: unavailableReason }
  cell.candidates = { kind: 'aspects', items: eligible.map(a => ({ code: a.name, label: a.name, coversAll: false, drops: [], adds: [], deprecated: false, required: !!a.required })),
    limit: input.limits.axes, schemaFetchedAt: null, state: unavailable ? 'unavailable' : eligible.length ? 'ok' : 'no-theme', ...(unavailable ? { unavailableReason } : {}) }
  applyLimitAndCollisions(cell, input)
  return cell
}

/** Shopify/Etsy preserve the complete stored mapping, including deliberately omitted axes. */
function resolveNamedAxes(input: ResolveVariationInput): VariationThemeCell {
  const cell = channelShell(input)
  const channel = String(input.coordinate.channel ?? '').toUpperCase()
  const wanted = familyAxisList(input.family)
  const mapping = effectiveVariationMapping(input)
  const etsy = input.schema.etsy
  const entries = mapping ?? wanted.map(a => ({ axisKey: a.familyKey, target: channel === 'ETSY' ? etsy?.properties.find(p => canonicalVariantAxis(p.axisKey) === a.axisKey)?.code ?? null : a.label }))
  cell.axes = entries.map(entry => {
    const own = parseOwnAxisKey(entry.axisKey)
    if (own) return namedOwnAxis(entry.axisKey, own, entry.target ?? null, channel, input)
    const axisKey = canonicalVariantAxis(entry.axisKey)
    const family = wanted.find(a => a.axisKey === axisKey)
    const property = channel === 'ETSY' ? etsy?.properties.find(p => p.code === entry.target) : null
    const target = channel === 'ETSY' ? entry.target : entry.target ?? family?.label ?? entry.axisKey
    return { axisKey, familyKey: family?.familyKey ?? entry.axisKey, label: family?.label ?? humanise(entry.axisKey), channelName: property?.label ?? target ?? family?.label ?? entry.axisKey, target, included: true,
      ...(!family ? { unbound: { reason: `The family has no ${entry.axisKey} axis.` } } : channel === 'ETSY' && !property ? { unbound: { reason: 'Choose a variation property from this Etsy category.' } } : {}) }
  })
  for (const axis of wanted) if (!cell.axes.some(a => a.axisKey === axis.axisKey)) cell.axes.push({ ...axis, channelName: axis.label, target: null, included: false })
  const kind: VariationSourceKind = hasVariationMappingOverride(input.listing?.variationMapping) ? 'override' : input.rule?.mapping ? 'rule' : wanted.length ? 'derived' : 'none'
  cell.source = { kind, ruleLabel: kind === 'rule' ? input.rule!.label : null, category: kind === 'rule' ? input.rule!.category : null,
    label: kind === 'override' ? VT_COPY.override : kind === 'rule' ? VT_COPY.rule(input.rule!.label) : kind === 'derived' ? VT_COPY.derived : VT_COPY.setAxes }
  cell.candidates = channel === 'SHOPIFY'
    ? { kind: 'free', items: [], limit: input.limits.axes, schemaFetchedAt: null, state: 'freeform' }
    : { kind: 'aspects', items: (etsy?.properties ?? []).map(p => ({ code: p.code, label: p.label, coversAll: false, drops: [], adds: [], deprecated: false })), limit: input.limits.axes, schemaFetchedAt: etsy?.fetchedAt ?? null, state: !etsy?.available ? 'unavailable' : etsy.properties.length ? 'ok' : 'no-theme', ...(!etsy?.available ? { unavailableReason: 'The variation properties for this Etsy taxonomy have not been loaded.' } : {}) }
  applyLimitAndCollisions(cell, input)
  return cell
}

/**
 * The coordinate's LIMIT, then the collision rule.
 *
 * Trailing axes beyond `limits.axes` become `included: false` and are named in `dropped`; the number is the
 * channel's own, never a constant here (`family-projection-limits.ts` sources every one of them, and Amazon's is
 * the widest segment count in its own enum - measured 4 on OUTERWEAR, IT and DE).
 */
function applyLimitAndCollisions(cell: VariationThemeCell, input: ResolveVariationInput): void {
  /* A5: every channel branch ends here, so the add list is computed in exactly one place. */
  const limit = input.limits?.axes ?? null
  if (limit !== null && limit >= 0) {
    let kept = 0
    for (const axis of cell.axes) {
      if (!axis.included) continue
      kept += 1
      if (kept > limit) axis.included = false
    }
  }
  cell.addableAxes = addableAxesFor(cell, input.family)
  cell.ownCandidates = ownCandidatesFor(cell, input)
  cell.dropped = cell.axes.filter((a) => !a.included).map((a) => a.axisKey)
  cell.collisions = collisionsFor(cell, input)
  cell.valueGaps = valueGapsFor(cell, input)
  const summary = valueSummaryFor(cell, input)
  if (summary) cell.valueSummary = summary
}

/** How many INCLUDED variants carry a value under `key`, and of how many. `null` = variants not read. */
function fillOf(key: string, input: ResolveVariationInput): { filled: number | null; of: number | null } {
  const variants = input.family.variants
  if (!variants) return { filled: null, of: null }
  const included = variants.filter(v => v.included)
  return { filled: included.filter(v => variationAxisValue(v.axisValues, key).trim()).length, of: included.length }
}

/**
 * Sheet pop-up P3 — eBay's variation-enabled aspects that no delivered axis uses yet, as channel-only candidates
 * (`own:channel:<column>`). An aspect a family axis already maps to, or one an own axis already reads, is not
 * offered twice. Other channels offer none here: their own axes take a typed name (`ownNames`).
 */
export function ownCandidatesFor(cell: Pick<VariationThemeCell, 'axes'>, input: ResolveVariationInput): VariationThemeCell['ownCandidates'] {
  if (String(input.coordinate.channel ?? '').toUpperCase() !== 'EBAY') return []
  const ebay = input.schema.ebay ?? null
  if (!ebay || ebay.unavailableReason) return []
  const delivered = cell.axes.filter(a => a.included)
  const usedNames = new Set(delivered.map(a => (a.target ?? a.channelName).toLocaleLowerCase()))
  const usedFields = new Set(delivered.flatMap(a => a.own?.from === 'channel' ? [canonicalVariantAxis(a.own.field)] : []))
  return ebay.aspects
    .filter(a => a.variantEligible && a.columnKey && !usedFields.has(canonicalVariantAxis(a.columnKey)) && !usedNames.has(a.name.toLocaleLowerCase()))
    .map(a => {
      const axisKey = ownAxisKey({ from: 'channel', field: a.columnKey! })
      return { axisKey, name: a.name, label: a.englishName ?? a.name, ...fillOf(axisKey, input) }
    })
}

/** Sheet pop-up P3 — the pop-up's value chips: per delivered axis, the distinct values INCLUDED variants carry. */
export function valueSummaryFor(cell: Pick<VariationThemeCell, 'axes'>, input: ResolveVariationInput): VariationThemeCell['valueSummary'] | null {
  const variants = input.family.variants
  if (!variants) return null
  const included = variants.filter(v => v.included)
  const out: NonNullable<VariationThemeCell['valueSummary']> = {}
  for (const axis of cell.axes.filter(a => a.included)) {
    const values: string[] = []
    let filled = 0
    for (const variant of included) {
      const value = variationAxisValue(variant.axisValues, axis.familyKey).trim()
      if (!value) continue
      filled += 1
      if (!values.includes(value)) values.push(value)
    }
    out[axis.familyKey] = { values, filled, of: included.length }
  }
  return out
}

/**
 * Two INCLUDED variants that share the surviving key can no longer be told apart (VX §6).
 *
 * `variants` absent => `null`, because NOT COMPUTED is not ZERO: a cell reporting `0 collisions` when nobody
 * looked is the could-not-measure / measured-empty confusion inside a contract field.
 */
export function collisionsFor(cell: VariationThemeCell, input: ResolveVariationInput): VariationThemeCell['collisions'] {
  const variants = input.family.variants
  if (!variants) return null
  const groups = variationCollisionGroups(cell.axes.filter(a => a.included).map(a => a.familyKey), variants)
  const unresolved = groups.reduce((sum, group) => sum + group.members.length, 0)
  return { unresolved, summary: variationCollisionSummary(unresolved, input.coordinate.label, cell.axes.filter(a => !a.included).map(a => a.label)) }

}

/** VTR step 0 — the listing wizard refuses a child with no value for a theme attribute; publish now reads the same fact. */
export function valueGapsFor(cell: VariationThemeCell, input: ResolveVariationInput): VariationThemeCell['valueGaps'] {
  const variants = input.family.variants
  if (!variants) return null
  const axes = cell.axes.filter(a => a.included)
  const gaps = variants.filter(v => v.included).map(v => ({ sku: v.sku, axes: axes.filter(a => !variationAxisValue(v.axisValues, a.familyKey).trim()).map(a => a.label) }))
    .filter(v => v.axes.length > 0)
  if (!gaps.length) return { unresolved: 0, summary: '', skus: [] }
  const named = gaps.slice(0, 10).map(v => `${v.sku} (${v.axes.join(', ')})`).join(', ')
  return { unresolved: gaps.length, skus: gaps.slice(0, 10).map(v => v.sku),
    summary: `${gaps.length} ${gaps.length === 1 ? 'variant has' : 'variants have'} no value for an axis on ${input.coordinate.label}: ${named}${gaps.length > 10 ? ` and ${gaps.length - 10} more` : ''}.` }
}

/**
 * VT.1 Phase 5 — the three readiness items a variation projection can raise (`docs/vt1-contracts.md` §4).
 *
 * PURE, derived from the cell the sheet already computed, so the number an operator reads in the Needs-attention
 * list is the number the cell shows. `VariationReadinessKind` is the vocabulary VT.4's catalogue filter routes on.
 *
 * Severities, and why:
 *  - `theme-unset` ERROR: a live Amazon push with no theme is an 8541-class failure, so the channel WILL refuse.
 *  - `collision` ERROR: two included variants arrive indistinguishable; the projection PATCH refuses it too
 *    (`collision_unresolved`), so the two agree.
 *  - `attribute-unbound` WARNING: the push still goes out with the axis missing — which is exactly what the
 *    adapter's `${axis}_name` fallback did silently before VT.1 replaced it.
 *  - VTR step 0: `theme-deprecated` (ERROR on a draft, WARNING on a live listing) and `value-missing` (ERROR) — the two
 *    checks the listing wizard made and studio publish did not.
 */
export type VariationReadinessKind = 'theme-unset' | 'collision' | 'attribute-unbound' | 'theme-deprecated' | 'value-missing'

export interface VariationReadinessItem {
  /** The FACT the catalogue filter and the readiness index narrow on — never the sentence. */
  kind: VariationReadinessKind
  coordinate: string
  message: string
  /** `attribute-unbound` / `theme-unset`: the axisKeys or segments. `collision`: capped at 10 subjects. */
  subjects: string[]
  severity: 'error' | 'warning'
}

/**
 * VT.1b (VT.4's request) — the value `ReadinessIndex.variationSource` stores for one coordinate.
 *
 * ONLY the provenance: `'derived' | 'rule' | 'overridden' | 'none'`. `unset` and `collides` are deliberately NOT here —
 * they are already expressible from `missing[].kind` (`theme-unset` / `collision`), and a fact with two homes is a fact
 * two readers can disagree about. `null` means NOT COMPUTED: no cell (a child row, which has no projection of its own)
 * or no axes at all. `null` must never be read as `'derived'`.
 *
 * The spelling is the CATALOGUE FILTER's (`variation-mapping:derived|rule|overridden|unset|collides`), not
 * `source.kind`'s (`override`), so the narrowing needs no translation table: the one place they differ is mapped here.
 */
export function variationSourceFor(cell: VariationThemeCell | null | undefined): 'derived' | 'rule' | 'overridden' | 'none' | null {
  if (!cell) return null
  if (cell.axes.length === 0) return null
  switch (cell.source.kind) {
    case 'override': return 'overridden'
    case 'rule': return 'rule'
    case 'derived': return 'derived'
    case 'none': return 'none'
    default: return null
  }
}

export function variationReadinessItems(cell: VariationThemeCell | null, coordinateLabel: string): VariationReadinessItem[] {
  if (!cell) return []
  const out: VariationReadinessItem[] = []
  if (cell.source.kind === 'none' && cell.axes.length > 0) {
    out.push({
      kind: 'theme-unset',
      coordinate: coordinateLabel,
      message: `No variation theme on ${coordinateLabel} — the family's axes match none of this product type's themes.`,
      subjects: cell.axes.map((a) => a.axisKey),
      severity: 'error',
    })
  }
  // VTR step 0 — the projection save refuses a deprecated Amazon theme, so a draft cannot publish one either. A LIVE
  // listing keeps its theme (changing it means a new parent), so there it warns and other updates still go out.
  if (cell.theme?.deprecated) {
    out.push({
      kind: 'theme-deprecated',
      coordinate: coordinateLabel,
      message: `Amazon has deprecated the variation theme ${cell.theme.code} on ${coordinateLabel}. ${cell.locked
        ? 'The live listing keeps it; new variants and a theme change need a current theme.' : 'Choose a current theme before publishing.'}`,
      subjects: [cell.theme.code],
      severity: cell.locked ? 'warning' : 'error',
    })
  }
  if (cell.valueGaps && cell.valueGaps.unresolved > 0) {
    out.push({ kind: 'value-missing', coordinate: coordinateLabel, message: cell.valueGaps.summary, subjects: cell.valueGaps.skus, severity: 'error' })
  }
  if (cell.collisions && cell.collisions.unresolved > 0) {
    out.push({
      kind: 'collision',
      coordinate: coordinateLabel,
      message: cell.collisions.summary,
      subjects: cell.dropped,
      severity: 'error',
    })
  }
  // Only when the theme itself resolved: an unset theme already leaves every axis unbound, and reporting both
  // would count one fact twice on the same coordinate.
  if (cell.source.kind !== 'none') {
    const unbound = cell.axes.filter((a) => a.included && !!a.unbound)
    for (const axis of unbound) {
      out.push({
        kind: 'attribute-unbound',
        coordinate: coordinateLabel,
        // Sheet pop-up P3 — a channel-only axis carries its own reason (219451 name, not a variation aspect, …) and is an
        // ERROR everywhere: there is no family value to fall back to, so sending it would send the refused name itself.
        message: axis.own ? `${axis.channelName} on ${coordinateLabel}: ${axis.unbound!.reason}` : `${axis.segment ?? axis.label} on ${coordinateLabel} binds to no attribute of this product type.`,
        subjects: [axis.axisKey],
        severity: axis.own || coordinateLabel.toUpperCase().startsWith('AMAZON') ? 'error' : 'warning',
      })
    }
  }
  return out
}

/** The child-row state: the column is a dash with `Set on the parent` (VT.8). */
export function childVariationCell(): { value: null; writable: false; writeBlockedReason: string } {
  return { value: null, writable: false, writeBlockedReason: VT_COPY.setOnParent }
}

export { marketplaceIdFor }
