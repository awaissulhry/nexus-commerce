import { variationAxisValue, variationCollisionGroups, variationCollisionSummary } from './variation-collisions.js'
import { loadVariationProjectionInput } from './variation-theme-facts.js'
import { resolveVariationProjection, type VariationThemeCell } from './variation-rules.service.js'
import { familyAccountId } from './family-account.js'
import { orderedVariationMapping, parseVariationMapping, variationMappingOrder, variationMappingTarget } from '@nexus/shared/variation-mapping'
import { resolveWorkspaceDestination } from './workspace-destination.js'
import { completeAxisValueOrder } from './shared-variation-values.js'
/**
 * VP.2 — the Variants page's backend: one family read, and one projection read/write per coordinate.
 *
 * Spec `docs/2026-09-11-variants-page-spec.md` §3–§5; FINAL contract `docs/vp2-contracts.md`.
 *
 * The page's founding rule is "one grid re-projected per scope", so this file has exactly two reads: the
 * SHARED family (axes, children, which channels they reach) and ONE channel's PROJECTION of it (mapping,
 * inclusion, split). Everything either read reports is derived here, once, on the server — every count the
 * bands and chips render arrives in the payload, because a count derived twice is a count that will disagree.
 *
 * ## What this file does NOT own
 *
 * It writes no cell values. Axis values are edited through the sheet's existing editor and pinned channel
 * values through the bulk PATCH's channel routing — spec §4.3 is explicit that no new write path for VALUES
 * is created here. What this file writes is the projection's own state: the axis-to-target MAPPING, and
 * whether a family member is INCLUDED on a coordinate.
 */
import prisma from '../../db.js'
// VT.1 — MOVED to a leaf so the SHEET can read the exclusion set without importing this module (which imports
// `studio-sheet.service.ts`, so the import would close a cycle and hand back a half-built module). Re-exported here
// because this module's existing callers import it from here.
import { readExcludedListingIds } from './variation-excluded.js'
export { readExcludedListingIds }
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { marketplaceIdFor } from './variation-theme-segments.js'
import { ebayDeclaredAxes, foldAvailability, lockedAxisKeysFrom, variationLockFor } from './variation-rules.service.js'
import { loadAmazonThemeFacts, resolveVariationCategory } from './variation-theme-facts.js'
import { addsForTheme, attributeTitle, bindSegmentToAttribute, classifyThemes, dropsForTheme, themeSegments } from './variation-theme-segments.js'
import { ProductRelationshipError } from './product-relationship.service.js'
import { readAxisValues, UnknownProductError, type StudioSheet } from './studio-sheet.service.js'
import { getInformationSheet as getStudioSheet } from './information-sheet.js'
import { coordinatesFor, type SheetColumn } from './sheet-columns.service.js'
import { legacyAliasIndexesPresent } from './listing-alias.service.js'
import { axisSynonymKey } from '../ebay-theme-axes.js'
import { readPresentationOrder, preparePresentationOrder, writePresentationOrderInTransaction, type PresentationOrderChange } from '../ebay-presentation-order.service.js'
import {
  isFreeformTarget, limitsFor, parseThemeAxes, vocabularyFor,
  type ProjectionLimits, type ProjectionVocabulary, type TargetOption,
} from './family-projection-limits.js'

// ────────────────────────────────────────────────────────────────────
// Vocabularies
// ────────────────────────────────────────────────────────────────────

/**
 * The PROJECTION vocabulary — spec §3.3's five cell words, and a THIRD vocabulary on purpose.
 *
 * `readinessMeta` already refuses to map its two vocabularies onto each other because `live` has no scope
 * counterpart and `absent` has no row counterpart. The same argument applies again here: `excluded` and
 * `not_set_up` have no readiness counterpart, and `live` has no exclusion counterpart. So a projection cell
 * carries BOTH its projection state and its row readiness, side by side, and nothing converts between them.
 */
export type ProjectionState = 'listed' | 'draft' | 'excluded' | 'not_set_up' | 'needs_value'

/** Honest-copy §3: exclusion is local; an existing identity may still sell. */
export function excludedReason(hasRow: boolean, childExternalId: string | null | undefined, parentExternalId: string | null | undefined, coordinateLabel: string): string {
  if (!hasRow) return 'No listing record on this coordinate. Tick it to create one as a draft.'
  const id = childExternalId || parentExternalId
  return id
    ? `Excluded here. ${id} still offers this variant on ${coordinateLabel} until the listing is revised. No listing change has been sent, and stock updates for this record still go out.`
    : 'Excluded from this listing. Nothing was ever sent for this variant.'
}

export type RowReadinessState = 'ready' | 'missing' | 'errors' | 'live' | 'unlisted'

/**
 * 🔴 TWO measurements, deliberately NOT one object.
 *
 * They were `readiness: { pct, state }` until 2026-09-11, and that put the row's READINESS state beside the
 * row's COMPLETENESS ratio under one name. Measured on GALE-JACKET · Amazon·IT: `{ pct: 14, state: 'live' }`
 * on a listing with **8 of 8 required attributes filled**. A reader takes `pct` as the percentage OF `state`;
 * there it pointed the opposite way. The substrate warns about exactly this — *"Row completeness also includes
 * optional attributes. Information completeness does not establish publication eligibility."*
 */
export interface RowReadiness {
  state: RowReadinessState
  /** The REQUIRED-fields ratio — the same metric `scope-readiness.service.ts` reports. */
  requiredPct: number | null
  /** Why `requiredPct` is null. Relayed from the substrate's own wording, never reworded here. */
  note: string | null
}

export interface RowCompleteness {
  /** Optional attributes INCLUDED. This is what spec §3.3's `CompletenessPill` renders. */
  pct: number | null
  filled: number
  total: number
}

export interface ProjectionCellState {
  included: boolean
  state: ProjectionState
  externalId: string | null
  readiness: RowReadiness | null
  completeness: RowCompleteness | null
  /** One sentence saying WHY this state. Server-stated so two surfaces cannot word it differently. */
  reason: string
}

// ────────────────────────────────────────────────────────────────────
// Family model
// ────────────────────────────────────────────────────────────────────

export interface FamilyAxis {
  /** The declared axis key, e.g. `Colore` — the only spelling a client ever sees. */
  key: string
  label: string
  /** The key values are actually stored under, e.g. `Color`. May differ from `key`. */
  storedKey: string
  source: 'stored' | 'declared'
  /**
   * The values the CHILDREN carry, with how many carry each. Ordered by `valueOrder` when one exists,
   * otherwise by first appearance over a SKU-ascending read — which is alphabetical and therefore meaningless
   * for a size axis (`3XL, 4XL, 5XL, L, M, S, …`). `valueOrder.source` says which you got.
   */
  values: Array<{ code: string; label: string; count: number }>
  /**
   * 🔴 The OPERATOR-STATED order of this axis's values, when one is stored.
   *
   * VP.3 asked where a meaningful order could come from, having correctly found that nothing derivable gives
   * one: these two axes have no schema option list, so first-appearance over SKU order is all a client can do.
   * There IS a stored answer, and it is the only one on this catalogue — the parent listing's
   * `platformAttributes._axisValueOrder`, which an operator arranged in the eBay presentation-order editor.
   * Measured on GALE-JACKET: `__dim1__` (size) = `XXS, XS, S, M, L, XL, XXL, 3XL, 4XL, 5XL`.
   *
   * `codes` is that list VERBATIM, so it may name values no child currently carries — which is information,
   * not noise: on this family it contains `XXS`, a size the children have lost (see `axisValuesSuspect`).
   * `coverage` is deliberately NOT computed from it; the counts stay derived from what children actually
   * carry, so this cannot silently change a number the grid disagrees with.
   *
   * The `__dimN__` keys are ARRAY-POSITION-derived from `AXIS_SYNONYM_GROUPS`, which is append-only for
   * exactly that reason; `axisSynonymKey` is the one joiner and is imported rather than re-derived.
   */
  valueOrder: {
    source: 'stored' | 'sku-alphabetical'
    /** Which coordinate the stored order was read from, e.g. `EBAY:IT`. Null when derived. */
    from: string | null
    codes: string[]
  }
}

export interface FamilyChild {
  id: string
  sku: string
  name: string | null
  image: string | null
  imageInherited: boolean
  status: string
  version: number
  axisValues: Record<string, string>
  axisValuesSuspect: Array<{ axisKey: string; reason: string }>
  readiness: RowReadiness | null
  completeness: RowCompleteness | null
  projections: Record<string, ProjectionCellState>
}

export interface FamilyChannel {
  channel: string
  market: string
  label: string
  connected: boolean
  accountId: string | null
  note: string | null
}

export interface FamilyRead {
  version: number
  family: { parentId: string; parentSku: string; role: 'parent' | 'standalone' }
  axes: FamilyAxis[]
  children: FamilyChild[]
  parent: Omit<FamilyChild, 'axisValues' | 'projections'> & {
    projections: Record<string, ProjectionCellState & { listings: number }>
  }
  coverage: {
    /**
     * 🔴 NULLABLE, following this codebase's own rule (`StudioSheet.counts.mapped`: *"null when the mapping
     * enrichment did not run — never 0 for that"*). Zero is a real answer; NOT COUNTED is a different fact;
     * they must not share a value.
     *
     * Before 2026-09-11 these were plain numbers and one payload could assert `missing: 0` beside
     * `childrenMissingAxisValues: 40` — measured on AIREON, whose two declared axes have nothing stored, so
     * the product is empty and `2 × 0 = 0` is literally true and useless. A band rendering it read
     * "0 of 0 combinations exist · 0 missing" on a forty-child family, identical to a complete one.
     * `null` here makes that contradiction impossible to construct rather than merely visible.
     */
    combinations: number | null
    existing: number | null
    missing: string[][] | null
    /** Which case this is, so a consumer never invents a third spelling of "the axes are empty". */
    state: 'ok' | 'no-axes' | 'no-values'
    duplicates: string[][]
    childrenMissingAxisValues: string[]
    /**
     * VP.2, measured: the same axis value can live in three stores that disagree (see the ledger entry of
     * 2026-09-11). Reported rather than silently resolved — the page showing a value the master sheet shows
     * as empty is a real difference an operator is entitled to see named.
     */
    axisValueConflicts: Array<{ childId: string; sku: string; axisKey: string; stores: Record<string, string> }>
  }
  channels: FamilyChannel[]
  meta: { tookMs: number; phases: Record<string, number> }
}

/**
 * A key that is not an axis value but has been written into an axis bag by some upstream path. Measured on
 * production 2026-09-01 and again 2026-09-11: two GALE-JACKET children carry a literal `variantAttributes`
 * key holding the string `"[object Object]"`, in BOTH bags.
 */
const BLANK_AXIS_KEYS = new Set(['variantAttributes'])

function cleanAxisBag(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (BLANK_AXIS_KEYS.has(k)) continue
    if (typeof v !== 'string' || !v.trim() || v === '[object Object]') continue
    out[k] = v
  }
  return out
}

/**
 * A child's axis values, as the UNION of the three stores that carry them, with a stated precedence.
 *
 * Measured on GALE-JACKET 2026-09-11: `categoryAttributes.variations` holds values for 20 of 20 children;
 * `Product.variantAttributes` for 2 of 20 (and both of those are the rows carrying the corrupt
 * `"[object Object]"` key); the sheet's own `attr_color` / `attr_size` cells for 0 of 20. Reading any ONE of
 * them makes the page wrong about most of the family, so all three are read and disagreements are reported.
 *
 * Precedence: the sheet CELL first (it is what the operator edits and sees), then `variations` (what the eBay
 * push reads), then the legacy bag.
 */
function axisValuesOf(
  product: { categoryAttributes: unknown; variantAttributes: unknown },
  cells: Record<string, string> | undefined,
  axes: FamilyAxis[],
): { values: Record<string, string>; stores: Record<string, Record<string, string>> } {
  const category = (product.categoryAttributes ?? {}) as Record<string, unknown>
  const variations = cleanAxisBag(category.variations)
  const legacy = readAxisValues(product.variantAttributes)

  const values: Record<string, string> = {}
  const stores: Record<string, Record<string, string>> = {}
  for (const axis of axes) {
    const want = canonicalVariantAxis(axis.storedKey)
    const pick = (bag: Record<string, string>) => Object.entries(bag).find(([k]) => canonicalVariantAxis(k) === want)?.[1]
    const fromCell = cells?.[axis.key]
    const fromVariations = pick(variations)
    const fromLegacy = pick(legacy)
    const seen: Record<string, string> = {}
    if (fromCell) seen.cell = fromCell
    if (fromVariations) seen.variations = fromVariations
    if (fromLegacy) seen.legacy = fromLegacy
    const chosen = fromCell ?? fromVariations ?? fromLegacy
    if (chosen) values[axis.key] = chosen
    if (Object.keys(seen).length > 1 && new Set(Object.values(seen)).size > 1) stores[axis.key] = seen
  }
  return { values, stores }
}

/**
 * Axes whose shared value cannot be TRUSTED on this row.
 *
 * The signal is precise and measurable, not a heuristic: the row's `categoryAttributes.variations` bag is
 * non-empty in the database but cleans to EMPTY, which means a writer overwrote it with the corrupt
 * `variantAttributes: "[object Object]"` key and destroyed the real values. What is left is the legacy bag —
 * and on the two GALE-JACKET rows in this state the legacy bag says `Size: XS` on SKUs named `…-XXS`.
 *
 * The value is still reported. Deriving `XXS` from the SKU would be an inference, and a variant's axis value
 * must be rendered as it is stored or as absent, never guessed from its name. What this adds is the SAYING of
 * it, so no surface asserts a value the data cannot support.
 */
export function suspectAxisValues(
  product: { categoryAttributes: unknown; variantAttributes: unknown },
  axes: FamilyAxis[],
  resolved: Record<string, string>,
): Array<{ axisKey: string; reason: string }> {
  const category = (product.categoryAttributes ?? {}) as Record<string, unknown>
  const rawVariations = (category.variations ?? {}) as Record<string, unknown>
  const clobbered = Object.keys(rawVariations).length > 0 && Object.keys(cleanAxisBag(rawVariations)).length === 0
  if (!clobbered) return []
  return axes
    .filter((axis) => resolved[axis.key])
    .map((axis) => ({
      axisKey: axis.key,
      reason: `This variant's shared axis bag was overwritten and only a legacy value survives, so "${resolved[axis.key]}" may not be this variant's real ${axis.key}. Check it against the SKU before relying on it.`,
    }))
}

/**
 * Pair each DECLARED axis with the key values are actually stored under.
 *
 * Matching is by canonical identity (`Colore` is `Color`, `Taglia` is `Size`) and never by substring: on this
 * catalogue `'colore'.includes('color')` happens to be true and `'taglia'` vs `'size'` is not, which is luck
 * rather than a mapping. An axis with nothing stored keeps its own name and is reported `declared`.
 */
function buildFamilyAxes(
  declared: string[],
  members: Array<{ categoryAttributes: unknown; variantAttributes: unknown }>,
): FamilyAxis[] {
  const storedKeys = new Set<string>()
  for (const member of members) {
    const category = (member.categoryAttributes ?? {}) as Record<string, unknown>
    for (const k of Object.keys(cleanAxisBag(category.variations))) storedKeys.add(k)
    for (const k of Object.keys(readAxisValues(member.variantAttributes))) storedKeys.add(k)
  }
  return declared.map((key) => {
    const identity = canonicalVariantAxis(key)
    const storedKey = [...storedKeys].find((k) => canonicalVariantAxis(k) === identity) ?? key
    return {
      key,
      label: key,
      storedKey,
      source: storedKeys.has(storedKey) ? ('stored' as const) : ('declared' as const),
      values: [] as FamilyAxis['values'],
      valueOrder: { source: 'sku-alphabetical' as const, from: null, codes: [] as string[] },
    }
  })
}

/**
 * Row readiness and row completeness from ONE sheet row, with the substrate's own not-counted rule applied.
 *
 * 🔴 The predicate is `scope-readiness.service.ts:62`'s, minus one condition, and the omission is deliberate.
 * That function also treats `mappingUnavailable` as unavailable — but it reads a sheet built WITH mapping,
 * and these reads pass `includeMapping: false`, so `meta.mapping` is null BY CONSTRUCTION here. Copying the
 * condition wholesale would make every channel row's readiness null for a reason that is an artefact of how
 * this read is configured, not a fact about the data. A predicate has to target the branch it is about.
 *
 * The note is the substrate's sentence relayed verbatim. PES.2's sheet already renders operator-facing words
 * for this state (`MasterSheet.tsx:1783` — "Setup incomplete"); a second wording here would be a second
 * vocabulary for one fact.
 */
function readinessOfRow(
  row: { readiness?: { state?: string }; completeness?: { overall?: { pct?: number; filled?: number; total?: number }; required?: { filled?: number; total?: number } } } | undefined,
  schemaMissing: string[],
): { readiness: RowReadiness | null; completeness: RowCompleteness | null } {
  if (!row) return { readiness: null, completeness: null }
  const required = row.completeness?.required
  const overall = row.completeness?.overall
  const requiredTotal = required?.total ?? 0
  // Two conditions, both from the substrate, neither invented here.
  const unavailable = schemaMissing.length > 0 || requiredTotal === 0
  const note = schemaMissing.length > 0
    ? `Category metadata is incomplete: ${schemaMissing.join(', ')}`
    : requiredTotal === 0
      ? 'No required attributes are defined for this scope'
      : null
  return {
    readiness: {
      state: (row.readiness?.state ?? 'unlisted') as RowReadinessState,
      requiredPct: unavailable ? null : Math.round(100 * (required?.filled ?? 0) / requiredTotal),
      note,
    },
    completeness: {
      // A percentage over a schema that could not be read is a number nobody measured. Amazon·PL served
      // `2/2 = 100` off FOUR surviving columns and this read relayed it as a readiness pill.
      pct: unavailable ? null : overall?.pct ?? null,
      filled: overall?.filled ?? 0,
      total: overall?.total ?? 0,
    },
  }
}

/** The family root, resolved from a parent id OR any child id — the same rule every studio read uses. */
export async function resolveFamilyRoot(productId: string) {
  const self = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!self) throw new UnknownProductError(productId)
  const root = await prisma.product.findFirst({
    where: { id: self.parentId ?? self.id, deletedAt: null },
    select: {
      id: true, sku: true, name: true, version: true, isParent: true, parentId: true,
      variationAxes: true, variationTheme: true, productType: true, familyId: true, status: true,
    },
  })
  if (!root || root.parentId) throw new ProductRelationshipError('The family changed. Reload the product.')
  return root
}

const FAMILY_MEMBER_SELECT = {
  id: true, sku: true, name: true, status: true, version: true,
  categoryAttributes: true, variantAttributes: true, basePrice: true, totalStock: true, productType: true,
} as const

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, aliasKey: true, channelConnectionId: true,
  listingStatus: true, isPublished: true, externalListingId: true, version: true, overrideData: true,
  variationTheme: true, variationMapping: true, platformAttributes: true,
} as const

type FamilyListing = {
  id: string; productId: string; channel: string; marketplace: string; aliasKey: string
  channelConnectionId: string | null; listingStatus: string; isPublished: boolean
  externalListingId: string | null; version: number; overrideData: unknown
  variationTheme: string | null; variationMapping: unknown; platformAttributes: unknown
}

// ────────────────────────────────────────────────────────────────────
// `variationExcluded` — read and written through narrow raw SQL, on purpose
// ────────────────────────────────────────────────────────────────────

/**
 * 🔴 Why raw SQL rather than a Prisma field.
 *
 * The column is live on the databases (additive migration `20260911a_vp2_variation_excluded`) but is NOT yet
 * declared in `schema.prisma`. Declaring it there regenerates the client for every concurrent session in this
 * repository, and Prisma emits an EXPLICIT column list — so the moment the schema knows a column a database
 * does not have, every `channelListing` query without a `select` fails, everywhere. A database ahead of the
 * schema is inert; a schema ahead of a database is an outage. These two helpers are the whole cost of staying
 * on the safe side of that asymmetry, and they fold into typed client calls once the field is declared with
 * both databases migrated.
 */

/**
 * Set or clear the flag on rows that already exist.
 *
 * EXCLUDE also lowers `isPublished`, which every consumer of that flag reads as "do not send" — the write is
 * push-REDUCING in both of its effects. INCLUDE clears the flag and NOTHING else: raising `isPublished` could
 * make a row eligible for an outbound sweep, so a tick can never restore publishing. That asymmetry is
 * deliberate and is stated in the contract and in the cell's own reason sentence.
 */
async function setVariationExcluded(listingIds: string[], excluded: boolean, db: Pick<typeof prisma, '$executeRawUnsafe'> = prisma): Promise<number> {
  if (listingIds.length === 0) return 0
  const sql = excluded
    ? `UPDATE "ChannelListing"
          SET "variationExcluded" = true, "isPublished" = false, "version" = "version" + 1, "updatedAt" = now()
        WHERE "id" = ANY($1::text[]) AND "variationExcluded" = false`
    : `UPDATE "ChannelListing"
          SET "variationExcluded" = false, "version" = "version" + 1, "updatedAt" = now()
        WHERE "id" = ANY($1::text[]) AND "variationExcluded" = true`
  return db.$executeRawUnsafe(sql, listingIds)
}

// ────────────────────────────────────────────────────────────────────
// §2 — the family read
// ────────────────────────────────────────────────────────────────────

export async function getFamilyRead(productId: string, market: string, locale?: string): Promise<FamilyRead> {
  const t0 = Date.now()
  const phases: Record<string, number> = {}
  const mark = (name: string, from: number) => { phases[name] = Date.now() - from }

  const tRoot = Date.now()
  const root = await resolveFamilyRoot(productId)
  const [children, parentRow] = await Promise.all([
    prisma.product.findMany({ where: { parentId: root.id, deletedAt: null }, select: FAMILY_MEMBER_SELECT, orderBy: { sku: 'asc' } }),
    prisma.product.findUniqueOrThrow({ where: { id: root.id }, select: FAMILY_MEMBER_SELECT }),
  ])
  mark('family', tRoot)

  const declared = (root.variationAxes ?? []) as string[]
  const axes = buildFamilyAxes(declared, [parentRow, ...children])

  // The master sheet is read ONCE, in-process, for the things it is already the single definition of:
  // per-row readiness, completeness, the face image and the effective axis CELL values. Deriving readiness
  // here instead would be a second definition of "is this row ready", which is exactly the duplication the
  // programme's one-vocabulary rule exists to prevent.
  const tSheet = Date.now()
  let sheet: StudioSheet | null = null
  try {
    sheet = await getStudioSheet({ productId: root.id, scope: 'master', market, locale, includeMapping: false })
  } catch {
    // A missing schema for the product type must not take the whole page down: the grid can render identity,
    // axes and projections without readiness, and `readiness: null` says honestly that it was not computed.
    sheet = null
  }
  mark('sheet', tSheet)

  const sheetRows = new Map((sheet?.rows ?? []).map((row) => [row.id, row]))
  const cellAxisValues = (rowId: string): Record<string, string> => {
    const row = sheetRows.get(rowId)
    if (!row) return {}
    const out: Record<string, string> = {}
    for (const axis of axes) {
      const hit = Object.entries(row.values).find(([key]) => canonicalVariantAxis(key) === canonicalVariantAxis(axis.storedKey))
      const value = hit?.[1]?.value
      if (typeof value === 'string' && value.trim()) out[axis.key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') out[axis.key] = String(value)
    }
    return out
  }

  const tListings = Date.now()
  const memberIds = [root.id, ...children.map((c) => c.id)]
  const [listings, marketplaces, connections] = await Promise.all([
    prisma.channelListing.findMany({ where: { productId: { in: memberIds } }, select: LISTING_SELECT }) as Promise<FamilyListing[]>,
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, isActive: true } }),
    prisma.channelConnection.findMany({ where: { isActive: true }, select: { id: true, channelType: true } }),
  ])
  const excluded = await readExcludedListingIds(listings.map((l) => l.id))
  mark('listings', tListings)

  const coordinates = coordinatesFor(market, marketplaces)
  const accountByChannel = new Map<string, string[]>()
  for (const connection of connections) {
    const key = connection.channelType.toUpperCase()
    accountByChannel.set(key, [...(accountByChannel.get(key) ?? []), connection.id])
  }

  const byCoordinate = new Map<string, FamilyListing[]>()
  for (const listing of listings) {
    const key = `${listing.channel.toUpperCase()}:${listing.marketplace.toUpperCase()}`
    byCoordinate.set(key, [...(byCoordinate.get(key) ?? []), listing])
  }

  const conflicts: FamilyRead['coverage']['axisValueConflicts'] = []
  const valuesFor = (member: typeof parentRow, cells: Record<string, string> | undefined) => {
    const { values, stores } = axisValuesOf(member, cells, axes)
    for (const [axisKey, seen] of Object.entries(stores)) conflicts.push({ childId: member.id, sku: member.sku, axisKey, stores: seen })
    return values
  }
  const childValues = new Map(children.map((child) => [child.id, valuesFor(child, cellAxisValues(child.id))]))

  const storedOrderFor = (axis: FamilyAxis) => storedAxisOrder(axis, listings.filter(listing => listing.productId === root.id))

  // Axis VALUE lists, counted from what children actually carry — the coverage sentence's denominator.
  // The ORDER comes from the operator's stored list when there is one; the MEMBERSHIP never does, so a value
  // nobody carries cannot inflate a count.
  for (const axis of axes) {
    const counts = new Map<string, number>()
    for (const child of children) {
      const value = childValues.get(child.id)?.[axis.key]
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    const stored = storedOrderFor(axis)
    const codes = completeAxisValueOrder(axis.key, stored?.codes ?? [], [...counts.keys()])
    const rank = new Map(codes.map((code, index) => [code, index]))
    axis.values = [...counts.entries()]
      .map(([code, count]) => ({ code, label: code, count }))
      .sort((a, b) => (rank.get(a.code) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.code) ?? Number.MAX_SAFE_INTEGER))
    axis.valueOrder = stored
      ? { source: 'stored', from: stored.from, codes }
      : { source: 'sku-alphabetical', from: null, codes }
  }

  const masterSchemaMissing = sheet?.meta?.schemaMissing ?? []
  const readinessOf = (id: string) => readinessOfRow(sheetRows.get(id) as never, masterSchemaMissing)

  const projectionFor = (memberId: string, coordinateKey: string, connected: boolean): ProjectionCellState => {
    const rows = (byCoordinate.get(coordinateKey) ?? []).filter((l) => l.productId === memberId)
    const primary = rows.find((l) => l.aliasKey === '') ?? rows[0] ?? null
    if (!connected) {
      return {
        included: false, state: 'not_set_up', externalId: null, readiness: null, completeness: null,
        reason: 'No account is connected for this channel and market, so this family has no listing here.',
      }
    }
    if (!primary) {
      return {
        included: false, state: 'excluded', externalId: null, readiness: null, completeness: null,
        reason: excludedReason(false, null, null, coordinateKey),
      }
    }
    if (excluded.has(primary.id)) {
      return {
        included: false, state: 'excluded', externalId: primary.externalListingId, readiness: null, completeness: null,
        reason: excludedReason(true, primary.externalListingId,
          (byCoordinate.get(coordinateKey) ?? []).find(l => l.productId === root.id && l.aliasKey === primary.aliasKey)?.externalListingId,
          coordinates.find(c => `${c.channel}:${c.marketplace}` === coordinateKey)?.label ?? coordinateKey),
      }
    }
    const { readiness, completeness } = readinessOf(memberId)
    if (memberId !== root.id) {
      const values = childValues.get(memberId) ?? {}
      if (axes.length > 0 && axes.some((axis) => !values[axis.key])) {
        return {
          included: true, state: 'needs_value', externalId: primary.externalListingId, readiness, completeness,
          reason: 'This variant is missing a value for at least one axis, so it cannot be told apart from its siblings.',
        }
      }
    }
    if (primary.externalListingId) {
      return {
        included: true, state: 'listed', externalId: primary.externalListingId, readiness, completeness,
        reason: primary.isPublished
          ? 'Live on this channel.'
          : 'Live on this channel, with publishing turned off for this listing.',
      }
    }
    return { included: true, state: 'draft', externalId: null, readiness, completeness, reason: 'Included, and not published to this channel yet.' }
  }

  const channels = coordinates.map((coordinate) => {
    const accounts = accountByChannel.get(coordinate.channel) ?? []
    const connected = accounts.length > 0
    const accountId = familyAccountId(accounts, (byCoordinate.get(`${coordinate.channel}:${coordinate.marketplace}`) ?? []).map(listing => listing.channelConnectionId))
    return {
      key: `${coordinate.channel}:${coordinate.marketplace}`,
      channel: coordinate.channel,
      market: coordinate.marketplace,
      label: marketplaces.filter(m => m.channel?.toUpperCase() === coordinate.channel.toUpperCase()).length > 1 ? coordinate.label : coordinate.label.split(' · ')[0],
      connected,
      accountId,
      note: !connected
        ? 'Not set up — no connected account for this channel.'
        : !accountId
          ? `${accounts.length} connected accounts — pick one to open this projection.`
          : null,
    }
  })

  const projectionReads = new Map<string, ProjectionRead>()
  const failures = new Map<string, string>()
  await Promise.all(channels.filter(c => c.connected && c.accountId).map(async c => {
    try { projectionReads.set(c.key, await getProjectionRead({ productId: root.id, channel: c.channel, market: c.market, accountId: c.accountId!, locale, includeOrder: false })) }
    catch (err) { failures.set(c.key, err instanceof Error ? err.message : String(err)) }
  }))
  const cellFor = (id: string, coordinate: typeof channels[number]): ProjectionCellState => {
    const page = projectionReads.get(coordinate.key)
    const member = id === root.id ? page?.parent : page?.children.find(child => child.id === id)
    if (member) return { included: 'included' in member ? member.included : true,
      state: member.listing.state, externalId: member.listing.externalId, reason: member.listing.reason,
      readiness: member.readiness, completeness: member.completeness }
    if (coordinate.connected) return { included: false, state: 'not_set_up', externalId: null, readiness: null, completeness: null,
      reason: failures.get(coordinate.key) ?? coordinate.note ?? 'Choose an account to check this projection.' }
    return projectionFor(id, coordinate.key, false)
  }
  const projectionsFor = (memberId: string) => Object.fromEntries(channels.map(c => [c.key, cellFor(memberId, c)]))

  // ── Coverage ──────────────────────────────────────────────────────
  const axisCodes = axes.map((axis) => axis.values.map((v) => v.code))
  const combinations = axisCodes.length === 0 || axisCodes.some((codes) => codes.length === 0)
    ? 0
    : axisCodes.reduce((n, codes) => n * codes.length, 1)
  const tupleOf = (values: Record<string, string>) => axes.map((axis) => values[axis.key] ?? '')
  const tupleKey = (tuple: string[]) => JSON.stringify(tuple)

  const coverageState: 'ok' | 'no-axes' | 'no-values' = axes.length === 0
    ? 'no-axes'
    : axes.every((axis) => axis.values.length === 0) ? 'no-values' : 'ok'

  const bySkuTuple = new Map<string, string[]>()
  const childrenMissingAxisValues: string[] = []
  for (const child of children) {
    const tuple = tupleOf(childValues.get(child.id) ?? {})
    // A family with NO axes has nothing to be missing. Reporting all 15 of MISANO's children as "missing axis
    // values" printed a fault on a family where the concept does not apply; `axes: []` already says it once.
    if (axes.length === 0) continue
    if (tuple.some((v) => !v)) { childrenMissingAxisValues.push(child.id); continue }
    const key = tupleKey(tuple)
    bySkuTuple.set(key, [...(bySkuTuple.get(key) ?? []), child.sku])
  }

  const missing: string[][] = []
  if (combinations > 0) {
    const walk = (index: number, acc: string[]) => {
      if (index === axisCodes.length) {
        if (!bySkuTuple.has(tupleKey(acc))) missing.push([...acc])
        return
      }
      for (const code of axisCodes[index]) walk(index + 1, [...acc, code])
    }
    walk(0, [])
  }
  const duplicates = [...bySkuTuple.values()].filter((skus) => skus.length > 1)

  const parentListingCount = (coordinateKey: string) =>
    (byCoordinate.get(coordinateKey) ?? []).filter((l) => l.productId === root.id).length

  return {
    version: root.version,
    family: {
      parentId: root.id,
      parentSku: root.sku,
      role: children.length > 0 || root.isParent ? 'parent' : 'standalone',
    },
    axes,
    children: children.map((child) => ({
      id: child.id,
      sku: child.sku,
      name: child.name,
      image: sheetRows.get(child.id)?.imageUrl ?? null,
      imageInherited: sheetRows.get(child.id)?.imageInherited ?? false,
      status: child.status,
      version: child.version,
      axisValues: childValues.get(child.id) ?? {},
      axisValuesSuspect: suspectAxisValues(child, axes, childValues.get(child.id) ?? {}),
      ...readinessOf(child.id),
      projections: projectionsFor(child.id),
    })),
    parent: {
      id: root.id,
      sku: root.sku,
      name: root.name,
      image: sheetRows.get(root.id)?.imageUrl ?? null,
      imageInherited: sheetRows.get(root.id)?.imageInherited ?? false,
      status: parentRow.status,
      version: root.version,
      axisValuesSuspect: [],
      ...readinessOf(root.id),
      projections: Object.fromEntries(channels.map((c) => [
        c.key,
        { ...cellFor(root.id, c), listings: parentListingCount(c.key) },
      ])),
    },
    coverage: {
      // Counted only when every axis has at least one value; otherwise nothing was counted and it says so.
      combinations: coverageState === 'ok' ? combinations : null,
      existing: coverageState === 'ok' ? bySkuTuple.size : null,
      missing: coverageState === 'ok' ? missing : null,
      state: coverageState,
      duplicates,
      childrenMissingAxisValues,
      axisValueConflicts: conflicts,
    },
    channels: channels.map(({ key: _key, ...rest }) => rest),
    meta: { tookMs: Date.now() - t0, phases },
  }
}

// ────────────────────────────────────────────────────────────────────
// §4 — the projection read
// ────────────────────────────────────────────────────────────────────

export interface ProjectionInput {
  locale?: string
  includeOrder?: boolean
  productId: string
  channel: string
  market: string
  accountId?: string
  aliasKey?: string
}

export interface ProjectionMappingEntry {
  axisKey: string
  axisLabel: string
  target: string | null
  order: number
}

/**
 * How a pinned axis value is written — relayed from the CELL, never composed by the client (VP.4 A5).
 *
 * `commitChannelRow`'s own rule is that the write target comes from the cell and not from the request, so the
 * only honest way to offer a pin action is to hand the client the routing the sheet itself resolved. `null`
 * with a `writeBlockedReason` is a complete answer: it means this coordinate cannot write this axis, and the
 * control renders held with the reason rather than guessing a route.
 */
export interface AxisWriteRouting {
  field: string
  target: 'master' | 'channelListing'
  verb: 'master' | 'channel'
  /** The listing version to send as `expectedVersion` on a channel-targeted write. */
  version: number | null
}

/**
 * One axis cell on one coordinate.
 *
 * 🔴 `inheritedValue` and `value` answer DIFFERENT questions, and VP.4 found the cost of confusing them on
 * live data (2026-09-11): a reset built against the shared axis TUPLE would have emptied a `Colore` specific
 * on a live eBay item while telling the operator it was restoring "Nero".
 *
 *  - `value` — what this coordinate shows today.
 *  - `sharedAxisValues[axisKey]` (on the child) — the family's axis TUPLE, what tells this variant from its
 *    siblings. It is NOT an inheritable value and must never be offered as one.
 *  - `inheritedValue` — what the cascade would land on if this cell were RESET. `null` means "nothing: a reset
 *    empties this cell". The field is **absent** when the server could not compute it, which is a different
 *    fact and must be held differently in the UI.
 */
export interface ProjectionAxisCell {
  storedOverride: boolean
  value: string | null
  source: 'inherited' | 'pinned'
  write: AxisWriteRouting | null
  writeBlockedReason: string | null
  /** ABSENT = not computed. `null` = computed, and a reset lands on nothing. */
  inheritedValue?: string | null
  /** Set whenever `inheritedValue` is absent, saying why, so the control can hold with a real sentence. */
  inheritedValueUnknownReason?: string
  /**
   * The SHARED write for this axis, offered when the coordinate itself has no cell to pin.
   *
   * 🔴 Why this exists: when `write` is null the control is held, and the held REASON is the part an operator
   * acts on. Saying only "this coordinate has no column" sends them to create a column — which on master
   * already exists. Measured 2026-09-11: eBay·IT serves 51 columns including `color`/`size`; eBay·DE/FR/ES
   * serve 31 and neither axis column, because those markets have no listing set up for this family yet. The
   * shared record has the columns in every case (`attr_color` / `attr_size`, `writeTarget: master`).
   * So the honest offer is the shared one, with its blast radius attached.
   */
  sharedWrite?: AxisWriteRouting & { affectsAllMarkets: true }
}

export interface ProjectionChild {
  id: string
  sku: string
  name: string | null
  image: string | null
  imageInherited: boolean
  included: boolean
  /**
   * The SHARED axis values — the identity band's second line (VP.4 A2). The family's axis TUPLE.
   * 🔴 Not an inheritable value: see `ProjectionAxisCell.inheritedValue`.
   */
  sharedAxisValues: Record<string, string>
  projectedAxisValues?: Record<string, string>
  /**
   * Axes whose shared value cannot be trusted on THIS row, with the reason. Measured on GALE-JACKET: two
   * children have had their `categoryAttributes.variations` bag clobbered by a writer that left only
   * `variantAttributes: "[object Object]"`, so the only surviving value is the legacy bag's — which says
   * `Size: XS` on SKUs named `…-XXS`. The value is still reported, because inventing XXS from the SKU would be
   * a guess; it is reported as SUSPECT so no surface asserts it.
   */
  axisValuesSuspect: Array<{ axisKey: string; reason: string }>
  readiness: RowReadiness | null
  completeness: RowCompleteness | null
  values: Record<string, ProjectionAxisCell>
  listing: { state: ProjectionState; externalId: string | null; listingId: string | null; reason: string }
}

/**
 * VP.4 A6 — the parent row. Its channel identity is READ, never inferred from what the children carry.
 *
 * 🔴 `listing` is NESTED, exactly as `ProjectionChild.listing` is. It was flat for about two minutes on
 * 2026-09-11 and put VP.4's page into an error boundary: one vocabulary in two shapes is precisely what a
 * consumer reads past. The parent is not a child — it has no `included` and no axis cells — but where it
 * speaks the SAME vocabulary it uses the same shape.
 */
export interface ProjectionParent {
  id: string
  sku: string
  name: string | null
  image: string | null
  /** How many listing rows the parent holds here (the primary plus any alias). */
  listings: number
  readiness: RowReadiness | null
  completeness: RowCompleteness | null
  listing: { state: ProjectionState; externalId: string | null; listingId: string | null; reason: string }
}

export interface ProjectionRead {
  version: number
  coordinate: {
    channel: string
    market: string
    accountId: string | null
    aliasKey: string
    label: string
    /** VP.4 A3 — the dock's sub-line and the channel's own name in copy. */
    channelLabel: string
    accountLabel: string | null
    category?: string | null
  }
  vocabulary: ProjectionVocabulary
  limits: ProjectionLimits
  variation?: VariationThemeCell
  mapping: ProjectionMappingEntry[]
  axisColumns: Record<string, SheetColumn>
  /**
   * VP.4 A4 — the axes the family HAS, not only the mapped ones: the dock's value mini-tables and its
   * "+ Add a specific" both need the unmapped ones too. `count` is INCLUDED variants only.
   */
  axes: Array<{
    key: string
    label: string
    valueOrder: { codes: string[]; from: string | null }
    values: Array<{
      code: string
      label: string
      count: number
      /**
       * How many of `count` come from a row whose shared axis bag was clobbered — see
       * `ProjectionChild.axisValuesSuspect`. On GALE-JACKET, `XS` counts 4 of which **2 are suspect**: the
       * two `…-XXS` SKUs whose only surviving value says XS. A mini-table that prints 4 without saying so
       * states a number the data does not support.
       */
      suspectRows: number
    }>
    /** True when any value on this axis has a suspect row — the axis's whole value list is then unreliable. */
    hasSuspectRows: boolean
  }>
  targetOptions: TargetOption[]
  /**
   * 🔴 Why an empty `targetOptions` is not self-explanatory. It can mean three different things and they
   * serialised identically until 2026-09-11: the channel genuinely offers none, the channel takes free names
   * (Shopify), or **the schema could not be read** — measured on Etsy·GLOBAL, whose sheet comes back with
   * `schemaMissing: ["ETSY:*"]`. A dock rendering an empty Listbox as "none exist" when the truth is "we could
   * not look" is the could-not-measure / measured-empty confusion, one layer out from where VP.4's probe
   * caught it earlier the same day.
   */
  targetOptionsState: 'ok' | 'freeform' | 'unavailable' | 'no-theme'
  /**
   * R-VT-7 — why the list is empty, in the channel's own words, whenever it IS empty. `null` when it is not.
   * The dock renders this instead of an empty Listbox; a reader never has to infer which of the four states
   * an empty array meant.
   */
  targetOptionsReason: string | null
  /** The schemas the coordinate's column build could not read. Empty when everything resolved. */
  schemaMissing: string[]
  freeform: boolean
  /** Where a mapping SAVE lands, so the dock can say it before the operator commits. */
  affectsAllMarkets: boolean
  theme: { value: string | null; options: Array<{ code: string; label: string }> } | null
  /**
   * The presentation ORDER, relayed read-only so the dock paints in one round trip.
   *
   * 🔴 This projection's PATCH does not write it. Measured, and corroborating VP.4's finding:
   * `ebay-cockpit.routes.ts:596` already answers 409 for `pickedAxes` / `axisSortOrder` / `axisValueOrder`
   * and names `/api/ebay/cockpit/presentation-order` as the one editor, which guards those keys with a
   * version AND an input token inside a serializable transaction. A second writer would be a second owner of
   * the same bytes. `editorUrl` is where the dock's drag control sends its half.
   */
  order: {
    axes: string[]
    valueOrder: Record<string, string[]>
    editorUrl: string
    writableHere: boolean
    reason: string
    token?: string
    resolvedAxes?: Array<{ name: string; key: string; values: string[] }>
  }
  split: {
    mode: 'single' | 'per-axis'
    axisKey?: string
    listings: Array<{ aliasKey: string; label: string; count: number }>
    creatable: boolean
    heldReason?: string
  }
  /**
   * VT.1b — the SAME lock the cell reports (`VariationThemeCell.locked`), plus `lockedAxisKeys`: which axes this
   * coordinate has already published, which only eBay's `__lastPublishedAxes` can answer.
   */
  locked: null | {
    reason: string
    lockedAxisKeys: string[]
    setChangeIs: 'relist' | 'new-parent' | 'in-place'
    orderChangeAllowed: boolean
    externalId: string | null
  }
  /**
   * VT.4 — the collision report for the CURRENTLY STORED mapping (`docs/vt1-contracts.md` §3.5, which
   * says this report is served "on GET and on the 400"; before this it was only on the 400, so the
   * mapping dock had no way to show a collision until an operator had already tried to save one).
   *
   * `null` is NOT "no collisions": it is "there is nothing a collision could come from" — this
   * coordinate drops no axis, or the read carries no children. `groups: []` with `unresolved: 0` is
   * the measured zero. `collisionReportFor` is the ONE computation; this field and the PATCH's refusal
   * are the same call with the same arguments.
   */
  collisions: CollisionReport | null
  parent: ProjectionParent
  children: ProjectionChild[]
  /**
   * 🔴 Every count names its UNIT, because a chip that prints one unit and narrows the grid by another is the
   * count-and-result disagreement the chip rules exist to prevent (VP.4, 2026-09-11: `pinned` was 40 on a
   * 20-child family because it counts CELLS, and a chip narrowing to rows would have shown 20).
   */
  counts: {
    rows: number
    includedChildren: number
    pinnedCells: number
    /** Rows with at least one pinned axis cell — the number a row-narrowing chip prints. */
    pinnedRows: number
    mappingErrorRows: number
  }
  meta: { tookMs: number; phases: Record<string, number> }
}

const ALIAS_HELD_REASON =
  'Listing split is unavailable until listing aliases are enabled.'

/**
 * eBay's marketplace id — the key `__lastPublishedAxes` is written under.
 *
 * VT.1: the definition MOVED to `variation-theme-segments.ts` so the projection read and the variation resolver
 * address that store through one rule. Re-exported here because callers of this module import it from here.
 */
export { marketplaceIdFor }

/**
 * Which target options this coordinate offers, derived from the coordinate's OWN column set.
 *
 * eBay and Etsy publish per-axis specifics/properties, so the options are the columns the channel itself marks
 * `variantEligible` — measured on eBay·IT: Colore, Taglia, Scollatura. Amazon's axis names are the segments of
 * its product type's `variation_theme` enum, lowercased to the SP-API attribute the publish adapter sends.
 */
export function targetOptionsFrom(
  channel: string,
  columns: SheetColumn[],
  coordinateLabel: string,
  themeOptions: string[],
  /**
   * R-VT-7 — AMAZON only: the cached product type's `properties`, so a segment is bound to a REAL attribute
   * instead of being lowercased into one. Absent = no cached schema, which the caller turns into
   * `targetOptionsState: 'unavailable'` rather than into an empty list that reads as "none exist".
   */
  amazonProperties?: Record<string, unknown>,
): TargetOption[] {
  const upper = channel.toUpperCase()
  if (upper === 'AMAZON') {
    /**
     * 🔴 R-VT-7 (orchestrator, on VT.2c's measurement). This branch used to split `themeOptions` on `/` and
     * lowercase each segment. Both halves were wrong after VT.1:
     *
     *  1. `themeOptions` came from the coordinate's own `variation_theme` SHEET COLUMN's `options` — and VT.1
     *     RETIRED that raw column in favour of the engine-owned one, which carries no `options`. So the input
     *     was `[]` on every Amazon coordinate from the moment VT.1 landed, and the output was `[]` with
     *     `targetOptionsState: 'ok'` — "this channel offers no targets", stated confidently, on a channel that
     *     offers two. VT.2c measured it on three coordinates (GALE·IT v87, GALE·DE v13, VX-TEST-3AX v5) and
     *     could not run the dock reorder's 200 arm because of it.
     *  2. `segment.toLowerCase()` is the `${axis}_name` convention T15 proved false: `COLOR_NAME` lowercases
     *     to `color_name`, which is not an attribute of OUTERWEAR on any marketplace. The attribute comes from
     *     the schema's `properties` through `bindSegmentToAttribute`, the same function the cell resolver uses.
     *
     * The list is now the bound attributes of the segments of the themes this product type actually declares,
     * labelled with the attribute's own localized `title` (`Colore` / `Farbe`). A segment that binds to nothing
     * is NOT offered as a target — offering it would let an operator map an axis onto an attribute Amazon would
     * reject at publish time.
     */
    const properties = amazonProperties ?? {}
    const seen = new Map<string, TargetOption>()
    for (const theme of themeOptions) {
      for (const segment of themeSegments(theme)) {
        const bound = bindSegmentToAttribute(segment, properties)
        if (!bound) continue
        if (seen.has(bound.attribute)) continue
        seen.set(bound.attribute, {
          code: bound.attribute,
          label: attributeTitle(bound.attribute, properties) ?? bound.attribute,
          columnKey: null,
          taken: false,
        })
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
  }
  if (isFreeformTarget(upper)) return []
  const out: TargetOption[] = []
  for (const column of columns) {
    if (!column.variantEligible) continue
    const channelSpec = (column as unknown as {
      channels?: Record<string, { label?: string; store?: { path?: string[] } }>
    }).channels?.[coordinateLabel]
    const path = channelSpec?.store?.path ?? []
    // The eBay specific NAME is the leaf of the store path (`itemSpecifics` then `Colore`) — that is the `Name`
    // the Trading API's NameValueList carries, so it is what a mapping must store to mean anything at all.
    const code = path.length > 0 ? path[path.length - 1] : column.key
    out.push({ code, label: channelSpec?.label ?? column.label ?? code, columnKey: column.key, taken: false })
  }
  return out
}

/**
 * Why a coordinate's axis ORDER cannot be dragged here, in the channel's own terms. `''` = it can be.
 *
 * History, because the sentence this returns is the operator's only explanation: VT.F measured (2026-09-13,
 * `VX-TEST-3AX` AMAZON·IT v6 → v7) that an order-only PATCH answered 200 and stored NOTHING on every channel
 * but eBay, because `variationMapping` was a flat `{axisKey: target}` map. **R-VT-13 (VT.F2) made the column
 * ORDERED**, so the storage half of that is gone; what remains is per channel and is stated here — eBay has its
 * own guarded editor, Shopify's order is stored AND published, Amazon's is fixed by the theme, Etsy's is stored
 * with no publisher to send it.
 */
export function orderHeldReason(channel: string, coordinateLabel: string): string {
  const upper = String(channel ?? '').toUpperCase()
  if (upper === 'EBAY') return ''
  if (upper === 'AMAZON') {
    return `Amazon's variation theme fixes the order of its segments, so the order cannot be changed on ${coordinateLabel}. Choose a different theme to change it.`
  }
  /**
   * 🔴 R-VT-13 (VT.F2) — SHOPIFY is no longer held: the order is STORED (`{axes:[{…,order}]}`) and the publisher
   * CONSUMES it. `shopifyAxisOrder()` orders a fresh content document's `axes` by it, and
   * `content-publisher.ts` sends `optionValues` in that order, which is the order a buyer sees on the product
   * page. So this channel returns `''` and `orderWritableHere` reports true.
   */
  if (upper === 'SHOPIFY') return ''
  /**
   * ETSY stores the order too, and nothing publishes it: there is no Etsy variation publish path in this
   * codebase today (`marketplaces/etsy.service.ts` has no importer — measured, `/usr/bin/grep` for its module
   * name across `apps/api/src` finds none). Saying "stored here, not sent yet" is the honest sentence; saying
   * it is writable would promise a buyer-facing change nothing makes.
   */
  if (upper === 'ETSY') {
    return `${coordinateLabel} stores this order, but nothing publishes an Etsy property order yet, so a reorder here is recorded and not sent.`
  }
  return `${coordinateLabel} stores this mapping without an order, so a reorder here would not reach the channel.`
}

/**
 * Can an operator change the delivery ORDER on this coordinate, and is it the thing the channel delivers?
 * The ONE predicate `getProjectionRead` answers `order.writableHere` with — never a second rule at the caller.
 *
 * eBay has its own guarded editor (a presentation-order token), so it answers `true` only when that editor
 * answered. Shopify's order is stored by the mapping PATCH and consumed by its publisher, so it is writable
 * here. Amazon's is fixed by the theme, and Etsy's is stored but unpublished — both hold, each with its sentence.
 */
export function orderWritableHere(channel: string, hasPresentation: boolean): boolean {
  const upper = String(channel ?? '').toUpperCase()
  if (upper === 'EBAY') return hasPresentation
  return upper === 'SHOPIFY'
}

/**
 * The stored mapping, read from the store the channel's own publish path reads.
 *
 * 🔴 Measured 2026-09-11, recorded in `docs/vp2-contracts.md` §0 M16: the eBay variation push builds its axis
 * set from `parseThemeAxes(Product.variationTheme)`, falling back to the parent listing's
 * `platformAttributes._variationAxes`, and takes the eBay specific NAME from `_axisNameLabels`. It never reads
 * `ChannelListing.variationMapping`. Writing eBay's mapping there would display a mapping eBay never receives.
 */
export function readStoredMapping(
  channel: string,
  source: {
    product: { variationTheme: string | null }
    listing: { variationMapping?: unknown } | null
    platformAttributes: Record<string, unknown>
  },
  axes: FamilyAxis[],
): ProjectionMappingEntry[] {
  if (channel.toUpperCase() === 'EBAY') {
    // VT.1 (VX D1/M3) — the THIRD reader of the declared set, now on the same rule as the push and the family-axes
    // service: the coordinate's `_variationAxes` when non-empty, else `Product.variationTheme`. It used to prefer
    // the product theme, so a coordinate given its own set displayed the family's instead.
    const order = ebayDeclaredAxes(source.platformAttributes, source.product.variationTheme) ?? []
    const nameLabels = (source.platformAttributes._axisNameLabels ?? {}) as Record<string, string>
    return axes
      .map((axis) => {
        const index = order.findIndex((name) => canonicalVariantAxis(name) === canonicalVariantAxis(axis.key))
        const target = nameLabels[axis.key] ?? nameLabels[axis.storedKey] ?? (index >= 0 ? order[index] : null)
        return { axisKey: axis.key, axisLabel: axis.label, target: target ?? null, order: index >= 0 ? index : axes.length }
      })
      .sort((a, b) => a.order - b.order)
      .map((entry, index) => ({ ...entry, order: index }))
  }
  /**
   * 🔴 R-VT-13 (VT.F2) — `variationMapping` is now ORDERED (`{axes:[{axisKey,target,order}]}`) and the flat
   * `{axisKey: target}` map every existing row carries is still read, by the ONE parser in
   * `@nexus/shared/variation-mapping`. Before this, the order was re-derived from the FAMILY axis index here
   * while the writer dropped it there, so an order-only PATCH answered 200 and stored nothing (VT.F measured
   * v6 → v7 with the original order served back).
   *
   * Where the stored value carries an order, the axes come back in THAT order — the same rule the eBay branch
   * above already used for `_variationAxes`, not a second one. An axis the mapping does not carry keeps its
   * family position and trails the mapped block, exactly as eBay's `index >= 0 ? index : axes.length` does.
   */
  const stored = source.listing?.variationMapping ?? null
  const shape = parseVariationMapping(stored).shape
  const positioned = axes.map((axis, index) => {
    const target = variationMappingTarget(stored, axis.key, axis.storedKey)
    const storedOrder = shape === 'ordered' ? variationMappingOrder(stored, axis.key, axis.storedKey) : null
    return { axisKey: axis.key, axisLabel: axis.label, target, order: storedOrder ?? (shape === 'ordered' ? axes.length + index : index) }
  })
  if (shape !== 'ordered') return positioned
  return positioned
    .sort((a, b) => a.order - b.order)
    .map((entry, index) => ({ ...entry, order: index }))
}

function storedAxisOrder(axis: FamilyAxis, listings: readonly FamilyListing[]): { from: string; codes: string[] } | null {
  const dim = axisSynonymKey(axis.key)
  const parents = [...listings].filter(listing => !listing.aliasKey).sort((a, b) =>
    `${a.channel}:${a.marketplace}:${a.channelConnectionId}`.localeCompare(`${b.channel}:${b.marketplace}:${b.channelConnectionId}`))
  for (const listing of parents) {
    const bag = (listing.platformAttributes as Record<string, unknown> | null)?._axisValueOrder as Record<string, unknown> | undefined
    const codes = bag?.[dim] ?? bag?.[axis.key]
    if (Array.isArray(codes) && codes.length) return { from: `${listing.channel}:${listing.marketplace}`, codes: codes.filter((v): v is string => typeof v === 'string') }
  }
  return null
}

export async function getProjectionRead(input: ProjectionInput): Promise<ProjectionRead> {
  return readProjection(input)
}

export async function previewProjectionMapping(input: MappingWriteInput): Promise<ProjectionRead> {
  return readProjection(input, input)
}

async function readProjection(input: ProjectionInput, proposed?: MappingWriteInput): Promise<ProjectionRead> {
  const t0 = Date.now()
  const channel = input.channel.toUpperCase()
  const market = input.market.toUpperCase()
  const destination = await resolveWorkspaceDestination({ productId: input.productId, channel, marketplace: market, accountId: input.accountId ?? undefined, aliasKey: input.aliasKey ?? '' })
  input = { ...input, accountId: destination.accountId }
  const aliasKey = destination.aliasKey ?? ''

  const root = await resolveFamilyRoot(input.productId)
  const [children, parentRow] = await Promise.all([
    prisma.product.findMany({ where: { parentId: root.id, deletedAt: null }, select: FAMILY_MEMBER_SELECT, orderBy: { sku: 'asc' } }),
    prisma.product.findUniqueOrThrow({ where: { id: root.id }, select: FAMILY_MEMBER_SELECT }),
  ])

  const memberIds = [root.id, ...children.map((c) => c.id)]
  const [listings, connections] = await Promise.all([
    prisma.channelListing.findMany({
      where: {
        productId: { in: memberIds }, channel, marketplace: market,
        ...(input.accountId ? { channelConnectionId: input.accountId } : {}),
      },
      select: LISTING_SELECT,
    }) as Promise<FamilyListing[]>,
    prisma.channelConnection.findMany({ where: { channelType: channel }, select: { id: true, displayName: true } }),
  ])
  const connectionLabels = new Map(connections.map((c) => [c.id, c.displayName]))
  const excluded = await readExcludedListingIds(listings.map((l) => l.id))
  const parentListing = listings.find((l) => l.productId === root.id && l.aliasKey === aliasKey)
    ?? null

  const declared = (root.variationAxes ?? []) as string[]
  const axes = buildFamilyAxes(declared, [parentRow, ...children])

  // ── The CHANNEL sheet, read once, in-process ──────────────────────
  //
  // It is the source for five things at once: the coordinate's real column set, per-row channel readiness, the
  // face image, the effective axis CELL (inherited vs pinned, as the cascade resolved it) and that cell's own
  // WRITE ROUTING. VP.4 A5 asks for the routing to come from the cell rather than from the client, and
  // `commitChannelRow` says the same from the other side, so relaying the sheet's answer is the only version
  // that cannot drift.
  //
  // 🔴 It has to be the SHEET and not a direct `getSheetColumns` call. Measured 2026-09-11 on eBay·IT: the
  // direct build returns 29 columns and ZERO `variantEligible` ones, because the category aspects are resolved
  // per PRODUCT from the listing's own detected category — the sheet returns 51 columns and the three real
  // ones (Colore, Taglia, Scollatura). Building the target options from the cheaper call produced an empty
  // Listbox that looked like "this channel has no specifics" rather than like a missing input.
  //
  // The MASTER sheet is read beside it, for ONE field: `inheritedValue` — what a reset would land on. It has
  // to be the master read and not the shared axis tuple. VP.4 built a reset against `sharedAxisValues` and
  // caught it on live data: this read reports `Colore: "Nero"` on all 20 children while the master sheet, at
  // the same minute, reports `color: null` on the same children. The tuple is what tells a variant from its
  // siblings; it is not a value anything inherits. A reset labelled "restore Nero" would have emptied a live
  // item's Colore specific.
  const tSheet = Date.now()
  const [channelSheet, masterSheet] = await Promise.all([
      getStudioSheet({
        productId: root.id, scope: 'channel', channel, market, locale: input.locale,
        ...(input.accountId ? { accountId: input.accountId } : {}), includeMapping: true,
      }),
      getStudioSheet({ productId: root.id, scope: 'master', market, locale: input.locale, includeMapping: false }),
    ])
  const sheetMs = Date.now() - tSheet
  const masterRows = new Map((masterSheet?.rows ?? []).map((r) => [r.id, r]))
  const columns = channelSheet?.columns ?? []
  const coordinateLabel = channelSheet?.scope?.label ?? `${channel} · ${market}`

  /**
   * 🔴 R-VT-7 — the theme enum comes from the CACHED SCHEMA, not from a sheet column.
   *
   * Before this, both the picker and `targetOptions` read `columns.find(key === 'variation_theme').options`.
   * VT.1 retired that raw Amazon column and replaced it with the engine-owned structural one, which has no
   * `options` — so from that commit on, every Amazon coordinate answered `theme.options: []` and
   * `targetOptions: []`, and the empty picker and empty target Listbox both looked like facts about Amazon.
   * `loadAmazonThemeFacts` is the ONE reader of `CategorySchema` for this fact (the cell resolver's own), it
   * is cached per (marketplace × productType), it resolves the marketplace CODE through VT.1b's single
   * authority, and it makes NO live SP-API call (T13).
   */
  const category = await resolveVariationCategory(channel, market, root.id, parentListing ? { ...parentListing, platformAttributes: parentListing.platformAttributes as Record<string, unknown> | null } : null)
  const amazonThemeFacts = channel === 'AMAZON' ? await loadAmazonThemeFacts(market, category) : null
  const amazonProperties = amazonThemeFacts?.facts.properties ?? {}
  const themeOptions: string[] = channel === 'AMAZON'
    ? (amazonThemeFacts?.facts.themes ?? [])
    : []
  /* The picker's labels are the BOUND attributes' own `title`s joined with ` / ` (design §3.2: `Colore /
     Taglia` on IT, `Farbe / Größe` on DE) — never `enumNames`, which T17 measured as machine-cased. */
  const themeLabels: Record<string, string> = {}
  const themeDeprecated = new Set(amazonThemeFacts?.facts.deprecated ?? [])
  for (const code of themeOptions) {
    const labels = themeSegments(code).map((segment) => {
      const bound = bindSegmentToAttribute(segment, amazonProperties)
      return attributeTitle(bound?.attribute ?? null, amazonProperties) ?? bound?.attribute ?? segment
    })
    themeLabels[code] = labels.join(' / ') || code
  }
  /**
   * The grouping the editor renders on both hosts: which candidate covers every family axis, which drops one,
   * which adds one the family does not have. `classifyThemes` + `dropsForTheme`/`addsForTheme` are the cell
   * resolver's own functions — the dock does not get a second opinion about what a theme costs.
   */
  const amazonWantedKeys = axes.map((axis) => canonicalVariantAxis(axis.key)).filter(Boolean)
  const amazonThemeGrouping = new Map<string, { coversAll: boolean; drops: string[]; adds: string[] }>()
  if (amazonThemeFacts) {
    for (const t of classifyThemes(amazonThemeFacts.facts)) {
      const drops = dropsForTheme(t.keys, amazonWantedKeys)
      const adds = addsForTheme(t.keys, amazonWantedKeys)
      amazonThemeGrouping.set(t.code, { coversAll: drops.length === 0 && adds.length === 0 && amazonWantedKeys.length > 0, drops, adds })
    }
  }

  const vocabulary = vocabularyFor(channel)
  const limits = limitsFor(channel, themeOptions)
  const targetOptions = targetOptionsFrom(channel, columns, coordinateLabel, themeOptions, amazonProperties)
  /**
   * 🔴 The Amazon arm of R-VT-7's "an empty list carries its own state word". There are exactly three reasons
   * an Amazon coordinate can offer no target, and each of them is a DIFFERENT thing to tell an operator:
   * no cached schema (we could not look), a cached schema that declares no theme (nothing to look at), and a
   * schema whose theme segments bind to no attribute of this product type (T15's `_NAME` family — the list is
   * empty on purpose and naming a bogus `color_name` would be worse).
   */
  const amazonTargetState: { state: 'ok' | 'unavailable' | 'no-theme'; reason: string | null } | null =
    channel !== 'AMAZON'
      ? null
      : !amazonThemeFacts
        ? { state: 'unavailable', reason: `No cached schema for ${root.productType ?? 'this product type'} on ${market}, so its variation targets cannot be listed.` }
        : themeOptions.length === 0
          ? { state: 'no-theme', reason: `${root.productType ?? 'This product type'} declares no variation theme on ${market}, so it has no variation targets.` }
          : targetOptions.length === 0
            ? { state: 'unavailable', reason: `None of the ${themeOptions.length} themes on ${root.productType ?? 'this product type'} binds a segment to an attribute this product type declares.` }
            : { state: 'ok', reason: null }
  const platformAttributes = (parentListing?.platformAttributes ?? {}) as Record<string, unknown>

  const projectionInput = await loadVariationProjectionInput({
    coordinate: { channel, marketplace: market, label: coordinateLabel }, market, accountId: input.accountId ?? null, columns, categoriesByAlias: new Map([[aliasKey, category]]),
    family: { rootId: root.id, familyAxes: declared, productVersion: root.version, productTheme: root.variationTheme, productType: root.productType, childIds: children.map(c => c.id),
      variants: children.map(child => { const own = listings.find(l => l.productId === child.id && l.aliasKey === aliasKey); return { id: child.id, sku: child.sku, included: !!own && !excluded.has(own.id), axisValues: channelSheet.rows.find(r => r.id === child.id && (r.aliasId ?? '') === aliasKey)?.axisValues ?? {} } }) },
    parentListings: new Map([[aliasKey, parentListing ? { ...parentListing, platformAttributes } : null]]),
  }, aliasKey)
  if (proposed && projectionInput.listing) {
    const listing = projectionInput.listing
    if (proposed.reset) {
      listing.variationTheme = null; listing.variationMapping = null
      const bag = { ...listing.platformAttributes }; delete bag._variationAxes; delete bag._axisNameLabels; bag._variationAxesMode = 'inherit'; listing.platformAttributes = bag
    } else {
      if (proposed.theme !== undefined) listing.variationTheme = proposed.theme
      if (proposed.mapping !== undefined) {
        listing.variationMapping = orderedVariationMapping(proposed.mapping)
        if (channel === 'EBAY') listing.platformAttributes = { ...listing.platformAttributes, _variationAxesMode: 'override', _variationAxes: proposed.mapping.map(m => m.axisKey), _axisNameLabels: Object.fromEntries(proposed.mapping.map(m => [m.axisKey, m.target])) }
      }
    }
  }
  const variation = resolveVariationProjection(projectionInput)
  const mapping: ProjectionMappingEntry[] = variation.axes.map((a, order) => ({ axisKey: axes.find(axis => canonicalVariantAxis(axis.key) === a.axisKey)?.key ?? a.familyKey, axisLabel: a.label, target: a.included ? a.target : null, order }))
  let presentation: Awaited<ReturnType<typeof readPresentationOrder>> | null = null
  let orderReason = ''
  if (channel === 'EBAY' && parentListing && input.includeOrder !== false) {
    try {
      presentation = await readPresentationOrder({ productId: root.id, marketplace: market, accountId: parentListing.channelConnectionId ?? undefined, aliasKey })
      // Presentation order is reported separately; it does not rewrite the selected mapping.
    } catch (err) { orderReason = err instanceof Error ? err.message : String(err) }
  }
  const takenTargets = new Set(mapping.map((m) => m.target).filter((t): t is string => !!t))
  for (const option of targetOptions) option.taken = takenTargets.has(option.code)

  // The lock: what this coordinate has ALREADY published. Never fabricated from the DECLARED axes — those
  // equal the current set by construction, so deriving the lock from them would make every coordinate look
  // locked, which is the same false-negative the eBay preflight documents for `priorPublishedAxisNames`.
  /* VT.F item A5 — ONE function for both hosts. This block was inline here and absent from the sheet
     cell, so a per-axis lock existed in the dock and not in the cell; `lockedAxisKeys` is now on the cell
     contract and both producers call `lockedAxisKeysFrom`. */
  const lockedAxisKeys = lockedAxisKeysFrom(platformAttributes, channel, market)
  // VT.1b item 3 (VT.4) — ONE definition of "locked", shared with the cell (`variationLockFor`). This used to derive it
  // from `__lastPublishedAxes` ALONE, which only eBay's push writes — so GALE's live Amazon coordinates read UNLOCKED
  // here and LOCKED on the cell: two answers to "may I change the set here" for the same ASIN. The cell's rule is the
  // one `docs/vt1-contracts.md` §1 specifies (a published external id on a non-draft listing), so it decides both.
  // `lockedAxisKeys` stays beside it because it is the extra fact only that store can answer — WHICH axes are already
  // published — and this module's own write path reports it.
  const sharedLock = variationLockFor({
    coordinate: { channel, market },
    family: { childIds: children.map((c) => c.id) },
    listing: parentListing ? {
      version: parentListing.version ?? 0,
      variationTheme: parentListing.variationTheme ?? null,
      variationMapping: null,
      platformAttributes: (parentListing.platformAttributes ?? null) as Record<string, unknown> | null,
      externalListingId: parentListing.externalListingId ?? null,
      listingStatus: parentListing.listingStatus ?? null,
    } : null,
  })
  const locked = sharedLock
    ? {
        lockedAxisKeys,
        // eBay can say WHICH axes are published; every other channel can only say that the coordinate is live.
        reason: lockedAxisKeys.length > 0
          ? `Item ${parentListing!.externalListingId} is live with ${lockedAxisKeys.join(' and ')}. `
            + `Adding or removing a ${vocabulary.axisNoun} relists it; reordering and adding values do not.`
          : sharedLock.reason,
        setChangeIs: sharedLock.setChangeIs,
        orderChangeAllowed: sharedLock.orderChangeAllowed,
        externalId: sharedLock.externalId,
      }
    : null

  const aliases = await prisma.productListingAlias.findMany({
    where: { productId: root.id, channel, marketplace: market, status: 'ACTIVE' },
    select: { id: true, label: true, position: true },
    orderBy: { position: 'asc' },
  })
  const includedCount = (key: string) =>
    listings.filter((l) => l.aliasKey === key && l.productId !== root.id && !excluded.has(l.id)).length
  // MEASURED per read rather than assumed, so the day PES.5-ii drops the legacy indexes this flips with no
  // code change on either side of the wire.
  const creatable = !(await legacyAliasIndexesPresent())

  const sheetRows = new Map((channelSheet?.rows ?? []).filter((r) => (r.aliasId ?? '') === aliasKey).map((r) => [r.id, r]))
  const axisColumn = (axis: FamilyAxis) => {
    const target = mapping.find(entry => entry.axisKey === axis.key)?.target
    if (!target) return undefined
    const key = targetOptions.find(option => option.code === target)?.columnKey
    return key ? columns.find(column => column.key === key)
      : columns.find(column => canonicalVariantAxis(column.key) === canonicalVariantAxis(target))
  }
  const axisColumns = Object.fromEntries(axes.flatMap(axis => { const column = axisColumn(axis); return column ? [[axis.key, column]] : [] }))

  /**
   * What a reset of this axis cell would land on.
   *
   * Returns `{}` — the field ABSENT — plus a reason whenever it cannot be computed, because "we did not
   * answer" and "we answered: nothing" must not share a value. A mapped cell is deliberately left unanswered:
   * a mapping rule sits between master and the channel, so the master value is not what the cascade would
   * resolve to, and offering it would be a confident wrong answer.
   */
  const inheritedFor = (childId: string, columnKey: string | undefined, axis: FamilyAxis):
    { inheritedValue?: string | null; inheritedValueUnknownReason?: string } => {
    if (!masterSheet) return { inheritedValueUnknownReason: 'The shared record could not be read, so where a reset would land is unknown.' }
    // Worded to match the held-write sentence: "no column" reads as "go and create one", and the column it
    // would send an operator to create already exists on the shared record.
    if (!columnKey) return { inheritedValueUnknownReason: `There is no per-market ${axis.key} on this coordinate, so there is nothing here to reset.` }
    const masterRow = masterRows.get(childId)
    if (!masterRow) return { inheritedValueUnknownReason: 'This variant has no row on the shared record.' }
    const masterCell = masterRow.values?.[columnKey]
      ?? Object.entries(masterRow.values ?? {}).find(([key]) => canonicalVariantAxis(key) === canonicalVariantAxis(axis.storedKey))?.[1]
    if (!masterCell) return { inheritedValueUnknownReason: `The shared record has no ${axis.key} column, so a reset has no value to fall back to.` }
    if (masterCell.mapped?.status === 'mapped') {
      return { inheritedValueUnknownReason: 'A mapping rule sits between the shared value and this channel, so where a reset would land is not the shared value.' }
    }
    const raw = masterCell.value
    if (typeof raw === 'string' && raw.trim()) return { inheritedValue: raw }
    if (typeof raw === 'number' || typeof raw === 'boolean') return { inheritedValue: String(raw) }
    return { inheritedValue: null }
  }

  /**
   * The sentence on a HELD axis cell. It has to be true and it has to be actionable, because the reason is
   * the part an operator acts on — a held control with a wrong reason is worse than a held control.
   */
  const heldReason = (
    column: SheetColumn | undefined,
    cell: { writeBlockedReason?: string | null } | undefined,
    axis: FamilyAxis,
  ): string => {
    if (cell?.writeBlockedReason) return cell.writeBlockedReason
    if (column) return `${coordinateLabel} does not accept a per-listing value for ${axis.key} on this family.`
    const shared = masterRows.size > 0
    return `${coordinateLabel} offers no ${vocabulary.axisNounPlural} for this family yet, so there is no `
      + `per-market ${axis.key} to pin here.`
      + (shared ? ` This market uses the shared ${axis.key}, and changing that changes every market.` : '')
  }

  /** The master route for an axis, relayed from the master sheet's own cell. */
  const sharedWriteFor = (child: { id: string; version: number }, axis: FamilyAxis):
    { sharedWrite?: AxisWriteRouting & { affectsAllMarkets: true } } => {
    const masterRow = masterRows.get(child.id)
    if (!masterRow) return {}
    const entry = Object.entries(masterRow.values ?? {})
      .find(([key]) => canonicalVariantAxis(key) === canonicalVariantAxis(axis.storedKey))
    const masterCell = entry?.[1]
    if (!masterCell?.writable || !masterCell.writeField) return {}
    return {
      sharedWrite: {
        field: masterCell.writeField,
        target: masterCell.writeTarget as AxisWriteRouting['target'],
        verb: masterCell.writeVerb as AxisWriteRouting['verb'],
        version: child.version,
        affectsAllMarkets: true,
      },
    }
  }

  const mappedAxisKeys = mapping.filter((m) => m.target).map((m) => m.axisKey)
  const childState: ProjectionChild[] = children.map((child) => {
    const row = listings.find((l) => l.productId === child.id && l.aliasKey === aliasKey) ?? null
    const sheetRow = sheetRows.get(child.id)
    const isExcluded = !row || excluded.has(row.id)
    const { values } = axisValuesOf(child, undefined, axes)
    const suspect = suspectAxisValues(child, axes, values)
    const missingMapped = mappedAxisKeys.some((key) => !values[key]) || sheetRow?.readiness.state === 'errors' || sheetRow?.readiness.state === 'missing'
    const state: ProjectionState = isExcluded
      ? 'excluded'
      : missingMapped ? 'needs_value'
        : row?.externalListingId ? 'listed' : 'draft'
    const reason = isExcluded
      ? excludedReason(!!row, row?.externalListingId, parentListing?.externalListingId, coordinateLabel)
      : missingMapped ? sheetRow?.readiness.issues.map(issue => issue.message).join(' ') || `Missing a value for a mapped ${vocabulary.axisNoun}.`
        : row?.externalListingId
          ? (row.isPublished ? 'Live on this channel.' : 'Live on this channel, with publishing turned off for this listing.')
          : 'Included, not published yet.'
    return {
      id: child.id,
      sku: child.sku,
      name: child.name,
      image: sheetRow?.imageUrl ?? null,
      imageInherited: sheetRow?.imageInherited ?? false,
      included: !isExcluded,
      sharedAxisValues: values,
      projectedAxisValues: sheetRow?.axisValues ?? {},
      ...readinessOfRow(sheetRow as never, channelSheet?.meta?.schemaMissing ?? []),
      axisValuesSuspect: suspect,
      values: Object.fromEntries(axes.map((axis) => {
        const column = axisColumn(axis)
        const cell = column ? sheetRow?.values?.[column.key] : undefined
        const resolvedValue = cell && cell.value !== undefined
          ? (cell.value === null ? null : String(cell.value))
          : null
        const write: AxisWriteRouting | null = cell?.writable && cell.writeField
          ? {
              field: cell.writeField,
              target: cell.writeTarget as AxisWriteRouting['target'],
              verb: cell.writeVerb as AxisWriteRouting['verb'],
              version: cell.writeTarget === 'channelListing' ? row?.version ?? null : child.version,
            }
          : null
        // VP.4 A7 — what a RESET lands on. The master sheet's cell for the SAME column, because clearing a
        // channel override leaves the master layer (`studio-sheet.service.ts:1202-1213` writes the
        // `channelExplicit` layer OVER a master-derived base; removing it uncovers that base).
        const inherited = inheritedFor(child.id, column?.key, axis)
        return [axis.key, {
          value: resolvedValue,
          storedOverride: cell?.mapped?.provenance === 'override' || !!cell && !cell.mapped && (cell.layer === 'channel' || cell.layer === 'alias') && cell.pinned,
          source: inherited.inheritedValue !== undefined && resolvedValue !== inherited.inheritedValue ? ('pinned' as const) : ('inherited' as const),
          write,
          writeBlockedReason: write ? null : heldReason(column, cell, axis),
          ...(write ? {} : sharedWriteFor(child, axis)),
          ...inherited,
        }]
      })),
      listing: { state, externalId: row?.externalListingId ?? null, listingId: row?.id ?? null, reason },
    }
  })

  // VP.4 A4 — every axis the family HAS, with INCLUDED-variant counts per value.
  const includedChildIds = new Set(childState.filter((c) => c.included).map((c) => c.id))
  const orderListings = await prisma.channelListing.findMany({ where: { productId: root.id }, select: LISTING_SELECT }) as FamilyListing[]
  const axesOut = axes.map((axis) => {
    const counts = new Map<string, number>()
    const suspectCounts = new Map<string, number>()
    for (const child of childState) {
      if (!includedChildIds.has(child.id)) continue
      const value = child.sharedAxisValues[axis.key]
      if (!value) continue
      counts.set(value, (counts.get(value) ?? 0) + 1)
      if (child.axisValuesSuspect.some((entry) => entry.axisKey === axis.key)) {
        suspectCounts.set(value, (suspectCounts.get(value) ?? 0) + 1)
      }
    }
    const values = [...counts.entries()].map(([code, count]) => ({
      code, label: code, count, suspectRows: suspectCounts.get(code) ?? 0,
    }))
    const stored = storedAxisOrder(axis, orderListings)
    const codes = completeAxisValueOrder(axis.key, stored?.codes ?? [], childState.map(child => child.sharedAxisValues[axis.key]).filter(Boolean))
    values.sort((a, b) => codes.indexOf(a.code) - codes.indexOf(b.code))
    return { key: axis.key, label: axis.label, values, valueOrder: { codes, from: stored?.from ?? null }, hasSuspectRows: values.some((v) => v.suspectRows > 0) }
  })

  const storedOrderAxes = Array.isArray(platformAttributes._variationAxes)
    ? (platformAttributes._variationAxes as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  const storedValueOrder = (platformAttributes._axisValueOrder ?? {}) as Record<string, string[]>

  const accountLabel = parentListing?.channelConnectionId
    ? (connectionLabels.get(parentListing.channelConnectionId) ?? null)
    : null

  const read: ProjectionRead = {
    version: parentListing?.version ?? 0,
    coordinate: {
      channel, market,
      accountId: parentListing?.channelConnectionId ?? input.accountId ?? null,
      aliasKey, label: coordinateLabel,
      channelLabel: coordinateLabel.split(' · ')[0] ?? channel,
      accountLabel, category,
    },
    axes: axesOut,
    order: {
      axes: storedOrderAxes,
      valueOrder: storedValueOrder,
      editorUrl: '/api/ebay/cockpit/presentation-order',
      // R-VT-13: the real capability per channel, one predicate (eBay's editor · Shopify's stored+published order).
      writableHere: orderWritableHere(channel, !!presentation),
      /**
       * 🔴 VT.F measured, on `VX-TEST-3AX` AMAZON·IT, that a reorder PATCH answered **200, bumped the version
       * 6 → 7 and served the ORIGINAL order back** at 8 s: `writeProjectionMapping` stored a FLAT
       * `{axisKey: target}` map and dropped `entry.order`, while `readStoredMapping` re-derived the order from
       * the FAMILY axis index (`reference_api_accepts_a_flag_it_ignores`). VT.F stated the refusal per channel
       * on the wire, because a held control must be rendered and say why (design §3.5).
       *
       * 🔴 **R-VT-13 (VT.F2) replaced that held reason with the real CAPABILITY.** `variationMapping` is now
       * ORDERED, so the order is stored on every channel that has it, and `orderWritableHere` answers per
       * coordinate: eBay through its own editor, **Shopify writable — its stored order is what the publisher
       * sends as the buyer-facing option order** — Amazon still held (its theme fixes the segment order) and
       * Etsy still held (stored, and nothing publishes an Etsy property order yet). An empty reason now means
       * "you may drag it", which is what the web has always read it as.
       */
      reason: orderReason || orderHeldReason(channel, coordinateLabel),
      ...(presentation ? { token: presentation.token, resolvedAxes: presentation.axes } : {}),
    },
    vocabulary,
    axisColumns,
    limits,
    mapping,
    variation,
    targetOptions: channel === 'ETSY' || channel === 'EBAY' ? (variation.candidates?.items ?? []).map(item => ({ code: item.code, label: item.label, columnKey: targetOptions.find(option => option.code === item.code)?.columnKey ?? item.code, taken: mapping.some(m => m.target === item.code) })) : targetOptions,
    /**
     * 🔴 R-VT-7 — an EMPTY list carries its own state word, and `'ok'` is never one of them. Four different
     * facts used to serialise as `[]` + `'ok'`: the channel offers none, the channel takes free names, the
     * schema could not be read, and (after VT.1) "the code was reading a column that no longer exists".
     */
    targetOptionsState: variation.candidates?.state ?? amazonTargetState?.state ?? (isFreeformTarget(channel)
      ? 'freeform'
      : (channelSheet?.meta?.schemaMissing?.length ?? 0) > 0 || !channelSheet
        ? 'unavailable'
        : targetOptions.length === 0 ? 'unavailable' : 'ok'),
    targetOptionsReason: variation.candidates?.unavailableReason ?? amazonTargetState?.reason ?? (isFreeformTarget(channel)
      ? 'This channel takes any option name, so there is no list to choose from.'
      : targetOptions.length === 0
        ? ((channelSheet?.meta?.schemaMissing?.length ?? 0) > 0 || !channelSheet
          ? `The column set for this coordinate could not be read (${(channelSheet?.meta?.schemaMissing ?? []).join(', ') || 'no sheet'}), so its variation targets cannot be listed.`
          : 'This coordinate declares no variation-eligible specifics.')
        : null),
    schemaMissing: channelSheet?.meta?.schemaMissing ?? [],
    freeform: isFreeformTarget(channel),
    // eBay's axis SET lives on `Product.variationTheme`, which is ONE record for every eBay market. Saying so
    // is the difference between an operator changing one market and changing all of them without knowing.
    affectsAllMarkets: false,
    /**
     * R-VT-9 — the dock's Amazon section carries the theme picker, so this block must be POPULATED and not an
     * empty options array. `coversAll` / `drops` / `deprecated` come from `classifyThemes` + the family's own
     * wanted keys, the same grouping the sheet cell's editor renders (`Covers every axis` · `Drops an axis` ·
     * `Deprecated`), so the two hosts group the list identically.
     */
    theme: channel === 'AMAZON'
      ? {
          value: variation.theme?.code ?? null,
          options: themeOptions.map((code) => ({
            code,
            label: themeLabels[code] ?? code,
            deprecated: themeDeprecated.has(code),
            ...(amazonThemeGrouping.get(code) ?? { coversAll: false, drops: [] as string[], adds: [] as string[] }),
          })),
        }
      : null,
    split: {
      mode: aliases.length > 0 ? 'per-axis' : 'single',
      listings: [
        { aliasKey: '', label: 'Primary listing', count: includedCount('') },
        ...aliases.map((alias) => ({ aliasKey: alias.id, label: alias.label, count: includedCount(alias.id) })),
      ],
      creatable,
      ...(creatable ? {} : { heldReason: ALIAS_HELD_REASON }),
    },
    locked,
    // VP.4 A6 — the parent row, READ rather than inferred. "Every child carries the same ItemID, therefore
    // that is the family's" is an inference, and the parent row is exactly where one would be read as a fact.
    // This is the PARENT listing's own external id, or null when its row carries none.
    parent: {
      id: root.id,
      sku: root.sku,
      name: root.name,
      image: sheetRows.get(root.id)?.imageUrl ?? masterRows.get(root.id)?.imageUrl ?? null,
      listings: listings.filter((l) => l.productId === root.id).length,
      ...readinessOfRow(sheetRows.get(root.id) as never, channelSheet?.meta?.schemaMissing ?? []),
      listing: {
        state: !parentListing ? 'not_set_up' : parentListing.externalListingId ? 'listed' : 'draft',
        externalId: parentListing?.externalListingId ?? null,
        listingId: parentListing?.id ?? null,
        reason: !parentListing
          ? 'This family has no parent listing record on this coordinate.'
          : parentListing.externalListingId
            ? `The family's listing on this channel is ${parentListing.externalListingId}.`
            : 'The family has a listing record here that has not been published yet.',
      },
    },
    children: childState,
    counts: {
      rows: childState.length + 1,
      includedChildren: childState.filter((c) => c.included).length,
      pinnedCells: childState.reduce((n, c) => n + Object.values(c.values).filter((v) => v.source === 'pinned').length, 0),
      pinnedRows: childState.filter((c) => Object.values(c.values).some((v) => v.source === 'pinned')).length,
      mappingErrorRows: childState.filter((c) => c.listing.state === 'needs_value').length,
    },
    meta: { tookMs: Date.now() - t0, phases: { sheet: sheetMs } },
    // Filled below: `collisionReportFor` takes the finished read, so it cannot be an initialiser here.
    collisions: null,
  }
  // VT.4 — the SAME function the PATCH refuses with, over the SAME stored mapping. One computation,
  // two consumers: a number the dock shows and a number the refusal quotes cannot disagree.
  read.collisions = collisionReportFor(read, mapping.filter((m) => m.target).map((m) => m.axisKey))
  return read
}

export { axisValuesOf, buildFamilyAxes, setVariationExcluded, FAMILY_MEMBER_SELECT, LISTING_SELECT }

// ────────────────────────────────────────────────────────────────────
// §4.2 — the mapping write
// ────────────────────────────────────────────────────────────────────

export class ProjectionConflictError extends Error {
  readonly code: string
  readonly statusCode = 409
  constructor(code: string, message: string, readonly detail?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.name = 'ProjectionConflictError'
  }
}

export class ProjectionRequestError extends Error {
  readonly code = 'bad_projection_request'
  readonly statusCode = 400
  constructor(message: string, readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = 'ProjectionRequestError'
  }
}

/**
 * VX §6 / VT.1 — a mapping whose INCLUDED variants do not have distinct keys on the surviving axes.
 *
 * 400, not 409: the request is well formed and the world did not move; the mapping itself cannot be published,
 * because two variants would arrive at the channel indistinguishable. Refusing it here is the difference between a
 * named refusal and a listing whose variants silently collapse. `collisions` rides on the error so the editor can
 * render the groups without a second round trip (the route's mapper forwards it verbatim).
 */
export class ProjectionCollisionError extends Error {
  readonly code = 'collision_unresolved'
  readonly statusCode = 400
  constructor(message: string, readonly collisions: CollisionReport) {
    super(message)
    this.name = 'ProjectionCollisionError'
  }
}

/** `docs/vt1-contracts.md` §3.5. */
export interface CollisionReport {
  groups: Array<{ key: string[]; members: Array<{ id: string; sku: string; droppedValues: Record<string, string> }> }>
  unresolved: number
  summary: string
  resolvers: Array<{
    kind: 'split' | 'fold' | 'exclude'
    available: boolean
    reason: string | null
    /** `fold` only: the surviving axis whose cell the fold would write. Null when it cannot run. */
    foldInto?: string | null
  }>
}

export interface MappingWriteInput extends ProjectionInput {
  expectedVersion: number
  /** The WHOLE list. An axis absent from it is unmapped — a partial patch cannot express a removal. */
  mapping?: Array<{ axisKey: string; target: string; order?: number }>
  /** AMAZON only: the variation theme enum value. */
  theme?: string | null
  /**
   * VT.1 — clear THIS coordinate's override and fall back to the rule or the derivation (`docs/vt1-contracts.md`
   * §3.3). Sent on its own: combining it with `theme`/`mapping` would be two intents in one request, and the
   * result would depend on an order the caller never stated.
   */
  reset?: boolean
  presentationOrder?: { expectedToken: string; change: PresentationOrderChange }
  userId?: string | null
}

/** Compare the delivered bindings, including their order and the Amazon theme code. */
export function projectionSignature(read: ProjectionRead): string {
  return JSON.stringify([read.theme?.value ?? null, read.mapping.filter(m => m.target).map(m => [canonicalVariantAxis(m.axisKey), m.target])])
}

export function validateProjectionChange(current: ProjectionRead, proposed: ProjectionRead, requested: MappingWriteInput['mapping']): void {
  if (current.version !== proposed.version) throw new ProjectionConflictError('version_conflict', 'This listing changed during review. Reload it.')
  const signature = projectionSignature(current)
  const changed = signature !== projectionSignature(proposed)
  if (current.locked && changed) {
    const bindings = (read: ProjectionRead) => JSON.stringify(read.mapping.filter(m => m.target).map(m => [canonicalVariantAxis(m.axisKey), m.target]).sort((a, b) => a[0]!.localeCompare(b[0]!)))
    const onlyOrder = current.theme?.value === proposed.theme?.value && bindings(current) === bindings(proposed)
    if (!onlyOrder || !current.locked.orderChangeAllowed) throw new ProjectionConflictError('axes_locked', current.locked.reason, { locked: current.locked, current })
  }
  if (proposed.targetOptionsState === 'unavailable' && (requested?.length || proposed.mapping.some(m => m.target))) throw new ProjectionRequestError(proposed.targetOptionsReason ?? 'Load the category schema before changing variations.')
  if (proposed.theme?.value && !proposed.theme.options.some(t => t.code === proposed.theme!.value && !proposed.variation?.theme?.deprecated)) throw new ProjectionRequestError('Choose a current variation theme from this category schema.')
  const unbound = proposed.variation?.axes.find(a => a.included && a.unbound)
  if (unbound) throw new ProjectionRequestError(unbound.unbound!.reason)
  if (requested && proposed.coordinate.channel === 'AMAZON') {
    const delivered = proposed.mapping.filter(m => m.target)
    if (requested.length !== delivered.length || requested.some(r => !delivered.some(m => canonicalVariantAxis(m.axisKey) === canonicalVariantAxis(r.axisKey) && m.target === r.target))) throw new ProjectionRequestError('Map exactly the attributes required by the selected Amazon theme.')
  }
  if (proposed.variation?.collisions === null) throw new ProjectionRequestError('Variant inclusion or values could not be evaluated. Reload before saving variations.')
  if (proposed.collisions && proposed.collisions.unresolved > 0) throw new ProjectionCollisionError(proposed.collisions.summary, proposed.collisions)
}

export async function writeProjectionMapping(input: MappingWriteInput): Promise<ProjectionRead> {
  const channel = input.channel.toUpperCase(), market = input.market.toUpperCase()
  const current = await getProjectionRead(input)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new ProjectionRequestError('An observed listing version is required.')
  if (current.version !== input.expectedVersion) throw new ProjectionConflictError('version_conflict', 'This listing changed after you opened the mapping. Reload it.', { current })
  if (input.reset && (input.theme !== undefined || input.mapping !== undefined || input.presentationOrder !== undefined)) throw new ProjectionRequestError('Send reset on its own.')
  if (input.presentationOrder && (channel !== 'EBAY' || typeof input.presentationOrder.expectedToken !== 'string' || !input.presentationOrder.expectedToken || !input.presentationOrder.change)) throw new ProjectionRequestError('Reload the eBay presentation order before saving.')
  let requested = input.reset ? undefined : input.mapping ?? current.mapping.filter(m => m.target).map((m, order) => ({ axisKey: m.axisKey, target: m.target!, order }))
  if (requested) {
    if (!Array.isArray(requested) || requested.some(e => !e || typeof e.axisKey !== 'string' || typeof e.target !== 'string' || !e.target.trim() || e.target !== e.target.trim() || (e.order !== undefined && (!Number.isSafeInteger(e.order) || e.order < 0)))) throw new ProjectionRequestError('Map each shared axis once to a nonempty channel name with a valid order.')
    requested = requested.slice().sort((a, b) => (a.order ?? requested!.indexOf(a)) - (b.order ?? requested!.indexOf(b)))
    const known = new Set(current.axes.map(a => canonicalVariantAxis(a.key)))
    if (new Set(requested.map(e => canonicalVariantAxis(e.axisKey))).size !== requested.length || requested.some(e => !known.has(canonicalVariantAxis(e.axisKey)))) throw new ProjectionRequestError('Map each existing family axis at most once.')
    if (current.limits.axes !== null && requested.length > current.limits.axes) throw new ProjectionRequestError(`This channel takes at most ${current.limits.axes} variation axes.`)
    if (new Set(requested.map(e => e.target.toLocaleLowerCase())).size !== requested.length) throw new ProjectionRequestError('Each channel name can carry only one axis.')
    if (channel === 'SHOPIFY' && requested.some(e => e.target.length > 255)) throw new ProjectionRequestError('Shopify option names must be 255 characters or fewer.')
    if (!current.freeform && requested.some(e => !current.targetOptions.some(o => o.code === e.target))) throw new ProjectionRequestError(current.targetOptionsReason ?? 'Choose a variation target from the category schema.')
  }
  const proposed = await readProjection(input, { ...input, mapping: requested })
  validateProjectionChange(current, proposed, requested)
  if (!input.presentationOrder && projectionSignature(current) === projectionSignature(proposed) && (input.reset ? current.variation?.source.kind !== 'override' : current.variation?.source.kind === 'override')) return current
  const root = await resolveFamilyRoot(input.productId)
  const listing = await prisma.channelListing.findFirst({ where: { productId: root.id, channel, marketplace: market, aliasKey: input.aliasKey ?? '', channelConnectionId: current.coordinate.accountId }, select: { id: true, version: true, platformAttributes: true } })
  if (!listing) throw new ProjectionConflictError('no_listing_here', 'Create a listing on this coordinate before mapping variations.')
  const orderInput = input.presentationOrder ? { productId: root.id, marketplace: market, accountId: current.coordinate.accountId ?? undefined, aliasKey: current.coordinate.aliasKey, expectedVersion: input.expectedVersion, expectedToken: input.presentationOrder.expectedToken, change: input.presentationOrder.change } : null
  const orderView = orderInput ? await preparePresentationOrder(orderInput) : null
  const names = Object.fromEntries((requested ?? []).map(e => [e.axisKey, e.target]))
  const bag = { ...((listing.platformAttributes ?? {}) as Record<string, unknown>) }
  if (input.reset) { delete bag._variationAxes; delete bag._axisNameLabels; bag._variationAxesMode = 'inherit' }
  else { bag._variationAxes = requested!.map(e => e.axisKey); bag._axisNameLabels = names; bag._variationAxesMode = 'override' }
  try {
    await prisma.$transaction(async tx => {
      if (orderInput && orderView) {
        await writePresentationOrderInTransaction(tx, orderInput, orderView, input.userId ?? null, names, requested!.map(e => e.axisKey))
      } else {
        const saved = await tx.channelListing.updateMany({ where: { id: listing.id, version: input.expectedVersion }, data: {
          ...(channel === 'EBAY' ? { platformAttributes: bag as never } : { variationMapping: input.reset ? null as never : orderedVariationMapping(requested!) as never, variationTheme: input.reset ? null : proposed.theme?.value ?? null }),
          version: { increment: 1 },
        } })
        if (saved.count !== 1) throw new ProjectionConflictError('version_conflict', 'Another edit won this listing. Reload before saving.')
      }
    }, { isolationLevel: 'Serializable', timeout: 30_000 })
  } catch (error) {
    if (['P2034', 'P2025'].includes(String((error as { code?: string })?.code))) throw new ProjectionConflictError('version_conflict', 'Another edit won this listing. Reload before saving.')
    throw error
  }
  return getProjectionRead(input)
}

/**
 * VT.1 / VX §6 — do the INCLUDED variants still have distinct keys under `mappedAxisKeys`?
 *
 * Built from the projection READ, so the number the refusal quotes is the number the cell and the Variants page
 * already show — one computation, three consumers. `null` when the coordinate drops nothing (there is nothing a
 * collision could come from) or when the read carries no children.
 */
export function collisionReportFor(current: ProjectionRead, mappedAxisKeys: string[]): CollisionReport | null {
  const familyKeys = current.axes.map((a) => a.key)
  const surviving = familyKeys.filter((key) => mappedAxisKeys.some((k) => canonicalVariantAxis(k) === canonicalVariantAxis(key)))
  const dropped = familyKeys.filter((key) => !surviving.includes(key))
  const variants = current.children.map(child => ({ ...child, axisValues: child.projectedAxisValues ?? child.sharedAxisValues }))
  const colliding = variationCollisionGroups(surviving, variants)
  const unresolved = colliding.reduce((n, group) => n + group.members.length, 0)
  const droppedLabels = dropped.map(key => current.axes.find(a => a.key === key)?.label ?? key)
  return {
    groups: colliding.map(group => ({ key: group.key, members: group.members.map(child => ({ id: child.id, sku: child.sku, droppedValues: Object.fromEntries(dropped.map(key => [key, variationAxisValue(child.axisValues, key)])) })) })),
    unresolved,
    summary: variationCollisionSummary(unresolved, current.coordinate.label, droppedLabels),
    resolvers: [
      { kind: 'split', available: current.split.creatable, reason: current.split.creatable ? null : (current.split.heldReason ?? ALIAS_HELD_REASON) },
      // `fold` needs a surviving axis to fold INTO; with nothing left there is nowhere to put the dropped label.
      // VT.1b item 2 (VT.4) — fold needs a WRITABLE target cell, not merely a surviving axis.
      { kind: 'fold', ...foldAvailability(current, surviving) },
      { kind: 'exclude', available: true, reason: null },
    ],
  }
}

// ────────────────────────────────────────────────────────────────────
// §4.3 — include / exclude
// ────────────────────────────────────────────────────────────────────

export interface InclusionWriteInput extends ProjectionInput {
  expectedVersion: number
  changes: Array<{ id: string; included: boolean }>
}

export interface InclusionResult {
  version: number
  results: Array<{ id: string; included: boolean; state: ProjectionState; listingId: string | null }>
  projection: ProjectionRead
}

/**
 * 🔴 A LOCAL-RECORD write, and nothing else.
 *
 * It calls no marketplace, enqueues no `SyncQueue` row and touches no publish path. The two directions are
 * deliberately asymmetric:
 *
 *  - EXCLUDE sets `variationExcluded = true` and lowers `isPublished`. Every consumer of `isPublished` reads
 *    `false` as "do not send", so both effects can only REDUCE pushing.
 *  - INCLUDE clears `variationExcluded` and nothing else. Raising `isPublished` could make a row eligible for
 *    an outbound sweep, so a tick can never restore publishing — that stays the explicit Publish action.
 *
 * A row that does not exist yet is CREATED as a local draft. It is born `syncPaused: true` because
 * `cascadeQuantityToListings` selects every listing of a product with no status filter at all, and Amazon's
 * dispatch PATCHes by SKU rather than by external id — so without the pause a new row would join the next
 * stock movement's quantity push. `syncPaused` is checked at BOTH the enqueue and the dispatch layer, and is
 * read by no publish path, so it blocks the automatic sweep without gating an operator's explicit publish.
 */
export async function writeProjectionInclusion(input: InclusionWriteInput): Promise<InclusionResult> {
  const channel = input.channel.toUpperCase()
  const market = input.market.toUpperCase()
  const aliasKey = input.aliasKey ?? ''
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new ProjectionRequestError('Send at least one change.')
  }
  if (input.changes.length > 500) {
    throw new ProjectionRequestError('Send at most 500 changes in one request.')
  }
  const seen = new Set<string>()
  for (const change of input.changes) {
    if (!change || typeof change.id !== 'string' || !change.id || typeof change.included !== 'boolean') {
      throw new ProjectionRequestError('Every change needs a product id and an included flag.')
    }
    if (seen.has(change.id)) throw new ProjectionRequestError(`"${change.id}" appears twice. Send one change per variant.`)
    seen.add(change.id)
  }

  const before = await getProjectionRead(input)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new ProjectionRequestError('An observed listing version is required.')
  }
  if (before.version !== input.expectedVersion) {
    throw new ProjectionConflictError('version_conflict', 'This listing changed after you opened it. Reload it and review the change again.', { current: before })
  }

  const root = await resolveFamilyRoot(input.productId)
  const members = new Map(before.children.map((child) => [child.id, child]))
  for (const change of input.changes) {
    if (!members.has(change.id)) {
      throw new ProjectionRequestError(`"${change.id}" is not a variant of ${root.sku}.`)
    }
  }

  const template = await prisma.channelListing.findFirst({
    where: { productId: root.id, channel, marketplace: market, channelConnectionId: before.coordinate.accountId, aliasKey },
    select: { channelConnectionId: true, channelMarket: true, region: true, aliasId: true },
  })

  const toExclude: string[] = []
  const toInclude: string[] = []
  const toCreate: string[] = []
  for (const change of input.changes) {
    const child = members.get(change.id)!
    const listingId = child.listing.listingId
    if (change.included) {
      if (listingId) toInclude.push(listingId)
      else toCreate.push(change.id)
    } else if (listingId) {
      toExclude.push(listingId)
    }
    // Excluding a child that has no row is already true: absence IS exclusion. Nothing is written, and the
    // response reports the state rather than a no-op the client would have to interpret.
  }

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.channelListing.findFirst({
      where: { productId: root.id, channel, marketplace: market, channelConnectionId: before.coordinate.accountId, aliasKey },
      select: { id: true, version: true },
    })
    if ((fresh?.version ?? 0) !== input.expectedVersion) {
      throw new ProjectionConflictError('version_conflict', 'This listing changed while the change was being saved. Reload it and review it again.')
    }
    if (fresh) {
      const guarded = await tx.channelListing.updateMany({ where: { id: fresh.id, version: input.expectedVersion }, data: { version: { increment: 1 } } })
      if (guarded.count !== 1) throw new ProjectionConflictError('version_conflict', 'Another change won this listing. Reload and review it again.')
    } else {
      await tx.channelListing.create({ data: { productId: root.id, channel, marketplace: market, channelConnectionId: before.coordinate.accountId,
        region: market, channelMarket: `${channel}_${market}`, aliasKey, aliasId: aliasKey || null, listingStatus: 'DRAFT', isPublished: false, syncPaused: true } })
    }
    if (toCreate.length > 0) {
      await tx.channelListing.createMany({
        data: toCreate.map((productId) => ({
          productId,
          channel,
          marketplace: market,
          region: template?.region ?? market,
          channelMarket: template?.channelMarket ?? `${channel}_${market}`,
          channelConnectionId: before.coordinate.accountId,
          aliasKey,
          aliasId: aliasKey ? aliasKey : null,
          listingStatus: 'DRAFT',
          isPublished: false,
          syncPaused: true,
        })),
        skipDuplicates: true,
      })
    }
    await setVariationExcluded(toExclude, true, tx)
    await setVariationExcluded(toInclude, false, tx)
  }, { isolationLevel: 'Serializable' })

  const after = await getProjectionRead(input)
  const afterById = new Map(after.children.map((child) => [child.id, child]))
  return {
    version: after.version,
    results: input.changes.map((change) => {
      const child = afterById.get(change.id)
      return {
        id: change.id,
        included: child?.included ?? false,
        state: child?.listing.state ?? 'excluded',
        listingId: child?.listing.listingId ?? null,
      }
    }),
    projection: after,
  }
}
