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

import { hasVariationMappingOverride, parseVariationMapping } from '@nexus/shared/variation-mapping'
import { variationCollisionGroups, variationCollisionSummary } from './variation-collisions.js'
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
    aspects: Array<{ name: string; englishName?: string | null; variantEligible: boolean; required: boolean }>
    unavailableReason?: string | null
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
  noListingHere: (channelName: string, market: string) =>
    `This family has no ${channelName} listing on ${market}, so there is nothing to project yet.`,
  ebayNoCategory: (market: string) =>
    `This eBay ${market} listing has no category yet, so its variation specifics cannot be read.`,
  notASiteAspect:
    'Not a variation aspect on this eBay site — it publishes as a custom specific and is outside the filters.',
  noThemeCovers: "No theme on this product type covers this family's axes.",
  unboundAttribute: (segment: string) => `${segment} binds to no attribute of this product type.`,
  schemaUnavailable:
    'No cached schema for this product type on this marketplace, so its themes cannot be listed.',
  noCollisions: '0 collisions on this coordinate',
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
 * is real evidence for it: `GALE-JACKET` holds B0F7J163XJ on Amazon-IT and item 257584954808 on eBay-IT, while
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
    return { reason: VT_COPY.genericLock('Shopify', coordinate.market, id), externalId: id, setChangeIs: 'in-place', orderChangeAllowed: true, lockedAxisKeys }
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
 * exactly **1** - GALE-JACKET eBay-IT (ACTIVE, item 257584954808) read `["Color","Size"]` from the listing column
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
    locked: null,
    /* MASTER's `+ Add axis` list is `masterCandidates` (the per-variant editable scalar columns, T1's
       rule) — a different vocabulary from a channel's "family axis not delivered here", so this is
       empty and the panel reads `masterCandidates` on that host. Empty, never absent: an optional
       field would put the two hosts back on two shapes. */
    addableAxes: [],
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

/** The shell every channel projection fills in, so no branch invents a field. */
function channelShell(input: ResolveVariationInput): VariationThemeCell {
  const channel = String(input.coordinate.channel ?? '').toUpperCase()
  const noListing = !input.listing
  return {
    axes: [],
    theme: null,
    source: { kind: 'none', ruleLabel: null, category: null, label: VT_COPY.setAxes },
    candidates: null,
    masterCandidates: null,
    dropped: [],
    collisions: null,
    locked: lockFor(input),
    /* Filled by each channel branch once it knows what it delivers — `applyAddableAxes` at the end of
       each resolver, so no branch can forget it and no branch computes its own list. */
    addableAxes: [],
    write: noListing ? null : {
      endpoint: 'projection',
      expectedVersion: input.listing!.version,
      aliasKey: input.coordinate.aliasKey ?? '',
      coordinate: { channel, market: input.coordinate.market, accountId: input.coordinate.accountId ?? null },
    },
    ...(channel === 'ETSY' ? { deliveryNote: 'Saved as a Nexus draft. Publishing Etsy variation properties is not available yet.' } : {}),
    writable: !noListing,
    writeBlockedReason: noListing ? VT_COPY.noListingHere(channelDisplayName(channel), input.coordinate.market) : null,
    vocabulary: input.vocabulary,
    separator: separatorFor(channel),
  }
}

function resolveAmazon(input: ResolveVariationInput): VariationThemeCell {
  const cell = channelShell(input)
  const wanted = familyAxisList(input.family)
  const explicitMapping = effectiveVariationMapping(input)
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

  const items = classifyThemes(facts).map((t) => {
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
  cell.dropped = cell.axes.filter((a) => !a.included).map((a) => a.axisKey)
  cell.collisions = collisionsFor(cell, input)
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
 */
export type VariationReadinessKind = 'theme-unset' | 'collision' | 'attribute-unbound'

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
        message: `${axis.segment ?? axis.label} on ${coordinateLabel} binds to no attribute of this product type.`,
        subjects: [axis.axisKey],
        severity: coordinateLabel.toUpperCase().startsWith('AMAZON') ? 'error' : 'warning',
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
