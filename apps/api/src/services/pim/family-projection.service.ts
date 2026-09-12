import { familyAccountId } from './family-account.js'
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
import { canonicalVariantAxis } from './variant-attribute-keys.js'
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
export async function readExcludedListingIds(listingIds: string[]): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set()
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT "id" FROM "ChannelListing" WHERE "variationExcluded" = true AND "id" = ANY($1::text[])',
    listingIds,
  )
  return new Set(rows.map((r) => r.id))
}

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
        reason: 'This variant has no listing record on this channel and market. Tick it to create one as a draft.',
      }
    }
    if (excluded.has(primary.id)) {
      return {
        included: false, state: 'excluded', externalId: primary.externalListingId, readiness: null, completeness: null,
        reason: primary.externalListingId
          ? `Excluded from this listing. The record is kept, so ${primary.externalListingId} is not lost.`
          : 'Excluded from this listing.',
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
  }
  vocabulary: ProjectionVocabulary
  limits: ProjectionLimits
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
  targetOptionsState: 'ok' | 'freeform' | 'unavailable'
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
  locked: null | { reason: string; lockedAxisKeys: string[] }
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

/** eBay's marketplace id — the key `__lastPublishedAxes` is written under. */
const marketplaceIdFor = (channel: string, market: string) =>
  channel.toUpperCase() === 'EBAY' ? `EBAY_${market.toUpperCase()}` : market.toUpperCase()

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
): TargetOption[] {
  const upper = channel.toUpperCase()
  if (upper === 'AMAZON') {
    const segments = new Set<string>()
    for (const option of themeOptions) for (const segment of option.split('/')) if (segment.trim()) segments.add(segment.trim())
    return [...segments].sort().map((segment) => ({ code: segment.toLowerCase(), label: segment, columnKey: null, taken: false }))
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
    const declaredTheme = parseThemeAxes(source.product.variationTheme)
    const storedOrder = Array.isArray(source.platformAttributes._variationAxes)
      ? (source.platformAttributes._variationAxes as unknown[]).filter((v): v is string => typeof v === 'string')
      : []
    const order = declaredTheme.length > 0 ? declaredTheme : storedOrder
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
  const flat = (source.listing?.variationMapping ?? {}) as Record<string, unknown>
  return axes.map((axis, index) => {
    const raw = flat[axis.key] ?? flat[axis.storedKey]
    return { axisKey: axis.key, axisLabel: axis.label, target: typeof raw === 'string' && raw.trim() ? raw : null, order: index }
  })
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

  const themeColumn = columns.find((c) => c.key === 'variation_theme')
  const themeOptions = (themeColumn?.options ?? []) as string[]
  const themeLabels = (themeColumn as unknown as { optionLabels?: Record<string, string> } | undefined)?.optionLabels ?? {}

  const vocabulary = vocabularyFor(channel)
  const limits = limitsFor(channel, themeOptions)
  const targetOptions = targetOptionsFrom(channel, columns, coordinateLabel, themeOptions)
  const platformAttributes = (parentListing?.platformAttributes ?? {}) as Record<string, unknown>

  const mapping = readStoredMapping(channel, { product: root, listing: parentListing, platformAttributes }, axes)
  let presentation: Awaited<ReturnType<typeof readPresentationOrder>> | null = null
  let orderReason = ''
  if (channel === 'EBAY' && parentListing && input.includeOrder !== false) {
    try {
      presentation = await readPresentationOrder({ productId: root.id, marketplace: market, accountId: parentListing.channelConnectionId ?? undefined, aliasKey })
      const order = presentation.axes.map(axis => axis.key)
      mapping.sort((a, b) => order.indexOf(axisSynonymKey(a.axisKey)) - order.indexOf(axisSynonymKey(b.axisKey)))
      mapping.forEach((entry, index) => { entry.order = index })
    } catch (err) { orderReason = err instanceof Error ? err.message : String(err) }
  }
  const takenTargets = new Set(mapping.map((m) => m.target).filter((t): t is string => !!t))
  for (const option of targetOptions) option.taken = takenTargets.has(option.code)

  // The lock: what this coordinate has ALREADY published. Never fabricated from the DECLARED axes — those
  // equal the current set by construction, so deriving the lock from them would make every coordinate look
  // locked, which is the same false-negative the eBay preflight documents for `priorPublishedAxisNames`.
  const lastPublished = ((platformAttributes.__lastPublishedAxes ?? {}) as Record<string, unknown>)[marketplaceIdFor(channel, market)]
  const lockedAxisKeys = Array.isArray(lastPublished)
    ? (lastPublished as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  const locked = lockedAxisKeys.length > 0 && parentListing?.externalListingId
    ? {
        lockedAxisKeys,
        reason: `Item ${parentListing.externalListingId} is live with ${lockedAxisKeys.join(' and ')}. `
          + `Adding or removing a ${vocabulary.axisNoun} relists it; reordering and adding values do not.`,
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
      ? (row ? 'Excluded from this listing. The record is kept.' : 'No listing record on this coordinate.')
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

  return {
    version: parentListing?.version ?? 0,
    coordinate: {
      channel, market,
      accountId: parentListing?.channelConnectionId ?? input.accountId ?? null,
      aliasKey, label: coordinateLabel,
      channelLabel: coordinateLabel.split(' · ')[0] ?? channel,
      accountLabel,
    },
    axes: axesOut,
    order: {
      axes: storedOrderAxes,
      valueOrder: storedValueOrder,
      editorUrl: '/api/ebay/cockpit/presentation-order',
      writableHere: !!presentation,
      reason: orderReason,
      ...(presentation ? { token: presentation.token, resolvedAxes: presentation.axes } : {}),
    },
    vocabulary,
    axisColumns,
    limits,
    mapping,
    targetOptions,
    targetOptionsState: isFreeformTarget(channel)
      ? 'freeform'
      : (channelSheet?.meta?.schemaMissing?.length ?? 0) > 0 || !channelSheet ? 'unavailable' : 'ok',
    schemaMissing: channelSheet?.meta?.schemaMissing ?? [],
    freeform: isFreeformTarget(channel),
    // eBay's axis SET lives on `Product.variationTheme`, which is ONE record for every eBay market. Saying so
    // is the difference between an operator changing one market and changing all of them without knowing.
    affectsAllMarkets: channel === 'EBAY',
    theme: channel === 'AMAZON'
      ? { value: parentListing?.variationTheme ?? null, options: themeOptions.map((code) => ({ code, label: themeLabels[code] ?? code })) }
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
  }
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

export interface MappingWriteInput extends ProjectionInput {
  expectedVersion: number
  /** The WHOLE list. An axis absent from it is unmapped — a partial patch cannot express a removal. */
  mapping?: Array<{ axisKey: string; target: string; order?: number }>
  /** AMAZON only: the variation theme enum value. */
  theme?: string | null
  presentationOrder?: { expectedToken: string; change: PresentationOrderChange }
  userId?: string | null
}

export async function writeProjectionMapping(input: MappingWriteInput): Promise<ProjectionRead> {
  const channel = input.channel.toUpperCase()
  const market = input.market.toUpperCase()
  const current = await getProjectionRead(input)
  if (input.presentationOrder && (typeof input.presentationOrder.expectedToken !== 'string' || !input.presentationOrder.expectedToken || !input.presentationOrder.change)) throw new ProjectionRequestError('Reload the presentation order before saving.')
  if (input.presentationOrder && channel !== 'EBAY') throw new ProjectionRequestError('Presentation order is supported on eBay.')

  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new ProjectionRequestError('An observed listing version is required.')
  }
  if (current.version !== input.expectedVersion) {
    throw new ProjectionConflictError('version_conflict', 'This listing changed after you opened the mapping. Reload it and review the change again.', { current })
  }

  const requested = input.mapping ?? current.mapping.filter((m) => m.target).map((m, i) => ({ axisKey: m.axisKey, target: m.target as string, order: i }))
  if (!Array.isArray(requested) || requested.some(entry => !entry || typeof entry.axisKey !== 'string' || typeof entry.target !== 'string' || !entry.target.trim()) || new Set(requested.map(entry => entry.axisKey)).size !== requested.length) throw new ProjectionRequestError('Map each shared axis once to a nonempty channel specific.')

  // ── Refusals, each by name. A silently truncated mapping is a mapping the operator did not choose. ──
  const known = new Set(current.mapping.map((m) => m.axisKey))
  for (const entry of requested) {
    if (!known.has(entry.axisKey)) {
      throw new ProjectionRequestError(`"${entry.axisKey}" is not one of this family's axes. Add it on the shared product first.`, { axes: [...known] })
    }
  }
  if (current.limits.axes !== null && requested.length > current.limits.axes) {
    throw new ProjectionRequestError(
      `${current.coordinate.channelLabel} takes at most ${current.limits.axes} ${current.vocabulary.axisNounPlural} per listing, and this mapping has ${requested.length}.`,
      { limit: current.limits.axes, source: current.limits.source.axes },
    )
  }
  const targets = requested.map((entry) => entry.target)
  const duplicateTarget = targets.find((target, index) => targets.indexOf(target) !== index)
  if (duplicateTarget) {
    throw new ProjectionRequestError(`Two axes are mapped onto "${duplicateTarget}". Each ${current.vocabulary.axisNoun} can carry one axis.`)
  }
  if (!current.freeform && current.targetOptions.length > 0) {
    const allowed = new Set(current.targetOptions.map((option) => option.code))
    const unknownTarget = targets.find((target) => !allowed.has(target))
    if (unknownTarget) {
      throw new ProjectionRequestError(
        `"${unknownTarget}" is not a ${current.vocabulary.axisNoun} this coordinate offers.`,
        { targetOptions: [...allowed] },
      )
    }
  }

  // ── The lock: adding or removing an axis relists; reordering and renaming do not (spec §4.4.4). ──
  if (current.locked) {
    const before = new Set(current.mapping.filter((m) => m.target).map((m) => canonicalVariantAxis(m.axisKey)))
    const after = new Set(requested.map((entry) => canonicalVariantAxis(entry.axisKey)))
    const changed = before.size !== after.size || [...after].some((key) => !before.has(key))
    if (changed) {
      throw new ProjectionConflictError('axes_locked', current.locked.reason, { locked: current.locked, current })
    }
  }

  const root = await resolveFamilyRoot(input.productId)
  const listing = await prisma.channelListing.findFirst({
    where: {
      productId: root.id, channel, marketplace: market, aliasKey: input.aliasKey ?? '',
      channelConnectionId: current.coordinate.accountId,
    },
    select: { id: true, version: true, platformAttributes: true },
  })
  if (!listing) {
    throw new ProjectionConflictError('no_listing_here', `This family has no ${current.coordinate.channelLabel} listing on ${market}, so there is nothing to map yet.`)
  }

  if (channel === 'EBAY') {
    const orderInput = input.presentationOrder ? {
      productId: root.id, marketplace: market, accountId: current.coordinate.accountId ?? undefined, aliasKey: current.coordinate.aliasKey,
      expectedVersion: input.expectedVersion, expectedToken: input.presentationOrder.expectedToken, change: input.presentationOrder.change,
    } : null
    const orderView = orderInput ? await preparePresentationOrder(orderInput) : null
    // The axis SET is `Product.variationTheme` — the store `ebay-variation-push.service.ts` reads as
    // authoritative. The axis NAME per axis is `_axisNameLabels`, which the cockpit's own reader uses as
    // `nameLabels[a] || a`. The ORDER keys are NOT written here: they have a guarded editor of their own.
    const names: Record<string, string> = { ...((listing.platformAttributes ?? {}) as Record<string, unknown>)._axisNameLabels as Record<string, string> ?? {} }
    for (const entry of requested) names[entry.axisKey] = entry.target
    for (const key of Object.keys(names)) if (!requested.some((entry) => entry.axisKey === key)) delete names[key]

    // The SET keeps the order it already has wherever it can, so a mapping save cannot silently reorder a
    // live listing's specifics behind the order editor's back.
    const existingOrder = parseThemeAxes(root.variationTheme)
    const ordered = [
      ...existingOrder.filter((name) => requested.some((entry) => canonicalVariantAxis(entry.axisKey) === canonicalVariantAxis(name))),
      ...requested.map((entry) => entry.axisKey).filter((key) => !existingOrder.some((name) => canonicalVariantAxis(name) === canonicalVariantAxis(key))),
    ]

    await prisma.$transaction(async (tx) => {
      if (orderInput && orderView) {
        await writePresentationOrderInTransaction(tx, orderInput, orderView, input.userId ?? null, names)
      } else {
      const fresh = await tx.channelListing.findUnique({ where: { id: listing.id }, select: { version: true, platformAttributes: true } })
      if (!fresh || fresh.version !== input.expectedVersion) {
        throw new ProjectionConflictError('version_conflict', 'This listing changed while the mapping was being saved. Reload it and review the change again.')
      }
      await tx.channelListing.update({
        where: { id: listing.id, version: input.expectedVersion },
        data: {
          platformAttributes: { ...((fresh.platformAttributes ?? {}) as Record<string, unknown>), _axisNameLabels: names } as never,
          version: { increment: 1 },
        },
      })
      }
      if (root.variationTheme !== ordered.join(',')) await tx.product.update({ where: { id: root.id, version: root.version }, data: { variationTheme: ordered.join(','), version: { increment: 1 } } })
    }, { isolationLevel: 'Serializable', timeout: 30_000 })
  } else {
    // Amazon / Shopify / Etsy: the coordinate's own `variationTheme` column plus the FLAT `variationMapping`
    // that `amazon-publish.adapter.ts:427` reads (`variationMapping?.[axis] ?? variationMapping?.[axis.toLowerCase()]`).
    const flat: Record<string, string> = {}
    for (const entry of requested) flat[entry.axisKey] = entry.target
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.channelListing.findUnique({ where: { id: listing.id }, select: { version: true } })
      if (!fresh || fresh.version !== input.expectedVersion) {
        throw new ProjectionConflictError('version_conflict', 'This listing changed while the mapping was being saved. Reload it and review the change again.')
      }
      await tx.channelListing.update({
        where: { id: listing.id },
        data: {
          variationMapping: flat as never,
          ...(input.theme !== undefined ? { variationTheme: input.theme } : {}),
          version: { increment: 1 },
        },
      })
    })
  }

  return getProjectionRead(input)
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
