/**
 * MS.2 — the MASTER SHEET's rows for one market.
 *
 * `docs/2026-08-29-master-sheet-design.md`. One page of the sheet is a page of FAMILIES: a parent
 * followed by its variations, never split across a page boundary — an operator filling a colour ×
 * size grid must see the whole family or the fill handle lies.
 *
 * The read is deliberately three queries and then pure work in process, because the two things a
 * sheet needs most — resolution and preflight — are already pure:
 *
 *   1. products (families for this page)      ← one findMany
 *   2. channel listings for those products    ← one findMany
 *   3. per row: `resolveAttributes()` (pure)  ← no DB
 *      per row × coordinate: readiness (pure) ← no DB
 *
 * The alternative — `validatePublish` per product (3–4 queries each) or `getMasterAttributeSchema`
 * per product (hundreds) — is what makes the existing per-product surfaces unusable at sheet scale.
 *
 * Every value carries its PROVENANCE (`source`, `inheritedFrom`), because the sheet's whole point is
 * that an operator can see whether a cell is the parent's, this variation's own, or a channel's.
 */
import { resolveAttributes, type ProductLike, type ChannelListingLike, type ResolvedAttributes } from './attribute-resolver.js'
import { computeMasterCompleteness, type MasterCompleteness } from './master-completeness.service.js'
import type { MasterAttribute } from './master-schema.service.js'
import { columnApplies as applies, columnRequiredHere as requiredHere } from '@nexus/shared/master-sheet'
import { coordinatesFor, getSheetColumns, type SheetColumn, type SheetCoordinate, type SheetColumnSet } from './sheet-columns.service.js'

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export type ReadinessState = 'ready' | 'missing' | 'errors' | 'live' | 'unlisted'

export interface ReadinessIssue {
  key: string
  label: string
  message: string
  /** `error` = the channel WILL refuse; `warn` = accepted but it may reject. */
  severity: 'error' | 'warn'
}

export interface SheetReadiness {
  state: ReadinessState
  issues: ReadinessIssue[]
  /** The channel's own id once it exists — an ASIN, an eBay item id. */
  ref?: string
}

export interface SheetListing {
  id: string
  listingStatus: string
  isPublished: boolean
  price: number | null
  quantity: number | null
  externalListingId: string | null
  /** Only the six fields that actually have a follow flag; attributes have none. */
  follows: Record<string, boolean>
}

export interface SheetCellValue {
  value: unknown
  source: string
  inheritedFrom: string | null
  /** True when the value comes from the parent and this row has none of its own. */
  inherited: boolean
}

export interface SheetRow {
  id: string
  sku: string
  name: string | null
  parentId: string | null
  isParent: boolean
  status: string
  productType: string | null
  version: number
  basePrice: number | null
  childCount: number
  /** Resolved value + provenance, by master key. Keys with no value anywhere are absent. */
  values: Record<string, SheetCellValue>
  listings: Record<string, SheetListing>
  readiness: Record<string, SheetReadiness>
  completeness: MasterCompleteness
}

export interface SheetPage {
  market: string
  locale: string
  coordinates: SheetCoordinate[]
  columns: SheetColumn[]
  rows: SheetRow[]
  /** Number of FAMILIES (top-level products), not rows. */
  total: number
  page: number
  limit: number
  droppedKeys: string[]
  /** Types with no cached Amazon schema — their columns carry no caps. */
  schemaMissing: string[]
  /** When each type's cap data was fetched. */
  schemaAge: Array<{ productType: string; fetchedAt: string }>
  /** Markets that actually carry listings — the switcher's options. */
  availableMarkets: string[]
}

export interface GetSheetRowsInput {
  market: string
  page?: number
  /** Families per page. */
  limit?: number
  search?: string
  status?: string
  productTypes?: string[]
  /** Restrict to these families (the sheet's "selection only" view). */
  parentIds?: string[]
}

export const coordKey = (c: { channel: string; marketplace: string }) => `${c.channel}:${c.marketplace}`

// ────────────────────────────────────────────────────────────────────
// Value helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Prisma `Decimal` is neither a number nor a string — a naive `typeof v === 'number'` check turns a
 * real price into a silent zero. Decimals carry `toNumber()`; everything else goes through Number().
 */
export function decimalToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const maybe = v as { toNumber?: () => number; toString?: () => string }
  if (typeof maybe.toNumber === 'function') {
    const n = maybe.toNumber()
    return Number.isFinite(n) ? n : null
  }
  if (typeof maybe.toString === 'function') {
    const n = Number(maybe.toString())
    return Number.isFinite(n) ? n : null
  }
  return null
}

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/** The row's OWN storage for a key — what decides "inherited" vs "pinned". */
function ownValue(row: ProductLike, col: SheetColumn, locale: string): unknown {
  if (col.storage === 'categoryAttributes') return row.categoryAttributes?.[col.key]
  if (col.storage === 'localizedContent') return row.localizedContent?.[locale]?.[col.key]
  return (row as unknown as Record<string, unknown>)[col.key]
}

/**
 * Product columns are Decimals, Dates and arrays. A Prisma `Decimal` serialises to a STRING over
 * JSON, so a price cell that is really a number arrives as `"39.95"` and every numeric comparison
 * in the grid silently fails — coerce by the column's declared kind, not by guessing at runtime.
 */
function normaliseColumnValue(v: unknown, kind: SheetColumn['kind']): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (kind === 'number') return decimalToNumber(v)
  if (typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') return decimalToNumber(v)
  return v
}

// ────────────────────────────────────────────────────────────────────
// Readiness — pure, per row × coordinate
// ────────────────────────────────────────────────────────────────────

/**
 * The applicability rules live in `@nexus/shared/master-sheet` because the SHEET needs the same
 * answer to decide editable / locked / required. Re-exported here so this service's callers and its
 * tests keep one import surface.
 */
export { columnApplies, columnRequiredHere } from '@nexus/shared/master-sheet'

export function computeReadiness(input: {
  columns: SheetColumn[]
  values: Record<string, SheetCellValue>
  row: { isParent: boolean; productType: string | null }
  coordinate: SheetCoordinate
  listing?: SheetListing | null
}): SheetReadiness {
  const { columns, values, row, coordinate, listing } = input
  const issues: ReadinessIssue[] = []

  for (const col of columns) {
    if (!applies(col, row)) continue
    const v = values[col.key]?.value
    const required = requiredHere(col, coordinate.label, row.productType)

    if (isBlank(v)) {
      if (required) issues.push({ key: col.key, label: col.label, message: `${col.label} is required by ${coordinate.label}`, severity: 'error' })
      continue
    }

    const s = typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : String(v)
    // Amazon enforces BYTES; an accented Italian character is 2+ bytes, so a title inside the
    // character cap can still be refused at submit.
    if (col.maxBytes && Buffer.byteLength(s, 'utf8') > col.maxBytes) {
      issues.push({ key: col.key, label: col.label, message: `${col.label} is ${Buffer.byteLength(s, 'utf8')} bytes, over ${col.capFrom ?? coordinate.label}'s ${col.maxBytes}`, severity: 'error' })
    } else if (col.maxLength && s.length > col.maxLength) {
      issues.push({ key: col.key, label: col.label, message: `${col.label} is ${s.length} characters, over ${col.capFrom ?? coordinate.label}'s ${col.maxLength}`, severity: 'error' })
    }

    // An off-list value on a closed list is a WARNING, never a block — the operator may know
    // something the cached schema does not, and Amazon is the one that decides.
    if (col.mode === 'strict' && col.options && col.options.length > 0) {
      const hit = col.options.some((o) => o.toLowerCase() === s.trim().toLowerCase())
      if (!hit) issues.push({ key: col.key, label: col.label, message: `"${s}" is not in ${coordinate.label}'s list for ${col.label}`, severity: 'warn' })
    }
    if (col.deprecatedOptions?.some((o) => o.toLowerCase() === s.trim().toLowerCase())) {
      issues.push({ key: col.key, label: col.label, message: `${coordinate.label} has deprecated "${s}" for ${col.label}`, severity: 'warn' })
    }
  }

  const ref = listing?.externalListingId ?? undefined
  const hasErrors = issues.some((i) => i.severity === 'error')

  if (hasErrors) return { state: 'errors', issues, ref }
  // A live listing stays live even with warnings — it is already on the channel.
  if (listing && listing.externalListingId && listing.isPublished) return { state: 'live', issues, ref }
  if (!listing) return { state: 'unlisted', issues, ref }
  if (issues.length > 0) return { state: 'missing', issues, ref }
  return { state: 'ready', issues, ref }
}

// ────────────────────────────────────────────────────────────────────
// Completeness — reuses the MA.4 pure function so there is ONE definition
// ────────────────────────────────────────────────────────────────────

export function completenessFor(columns: SheetColumn[], row: { isParent: boolean; productType: string | null }, values: Record<string, SheetCellValue>): MasterCompleteness {
  const applicable = columns.filter((c) => applies(c, row))
  const asMaster: MasterAttribute[] = applicable.map((c) => ({
    key: c.key,
    label: c.label,
    type: (c.kind === 'longtext' ? 'text' : c.kind === 'date' ? 'text' : c.kind) as MasterAttribute['type'],
    required: c.requiredBy.length > 0,
    group: c.group,
    source: 'schema',
  }))
  const flat: Record<string, unknown> = {}
  for (const c of applicable) flat[c.key] = values[c.key]?.value
  return computeMasterCompleteness(asMaster, flat)
}

// ────────────────────────────────────────────────────────────────────
// The DB-backed read
// ────────────────────────────────────────────────────────────────────

const FOLLOW_FLAGS = ['followMasterTitle', 'followMasterDescription', 'followMasterPrice', 'followMasterQuantity', 'followMasterImages', 'followMasterBulletPoints'] as const

const PRODUCT_SELECT = {
  id: true, sku: true, name: true, parentId: true, isParent: true, status: true, productType: true,
  version: true, basePrice: true, categoryAttributes: true, localizedContent: true, variantAttributes: true,
  description: true, bulletPoints: true, keywords: true, brand: true, manufacturer: true,
  gtin: true, ean: true, upc: true, totalStock: true, variationAxes: true,
} as const

export async function getSheetRows(input: GetSheetRowsInput): Promise<SheetPage> {
  const market = String(input.market).toUpperCase()
  const page = Math.max(1, Number(input.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(input.limit) || 25))

  const { default: prisma } = await import('../../db.js')

  // ── 1. the families on this page ──────────────────────────────────
  const familyWhere: Record<string, unknown> = { deletedAt: null, parentId: null }
  if (input.status) familyWhere.status = input.status
  if (input.productTypes?.length) familyWhere.productType = { in: input.productTypes }
  if (input.parentIds?.length) familyWhere.id = { in: input.parentIds }
  if (input.search) {
    const q = input.search.trim()
    if (q) familyWhere.OR = [{ sku: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }]
  }

  const [total, families] = await Promise.all([
    prisma.product.count({ where: familyWhere }),
    prisma.product.findMany({
      where: familyWhere,
      select: { ...PRODUCT_SELECT, children: { where: { deletedAt: null }, select: PRODUCT_SELECT, orderBy: { sku: 'asc' } } },
      orderBy: { sku: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ])

  const flat: Array<Record<string, unknown>> = []
  const parentById = new Map<string, ProductLike>()
  for (const f of families as Array<Record<string, unknown>>) {
    const { children, ...parent } = f as { children?: Array<Record<string, unknown>> } & Record<string, unknown>
    parentById.set(parent.id as string, parent as unknown as ProductLike)
    flat.push({ ...parent, __childCount: children?.length ?? 0 })
    for (const c of children ?? []) flat.push({ ...c, __childCount: 0 })
  }

  // ── 2. the columns for this market (once, not per row) ────────────
  const productTypes = [...new Set(flat.map((r) => r.productType).filter(Boolean) as string[])]
  // What these families actually vary by decides which columns belong to a variation rather than to
  // the parent — the catalogue's own answer, not a hardcoded guess.
  const variationAxes = [...new Set(flat.flatMap((r) => (Array.isArray(r.variationAxes) ? (r.variationAxes as string[]) : [])))]
  const columnSet: SheetColumnSet = await getSheetColumns({ market, productTypes, variationAxes })
  const { columns, coordinates, locale, droppedKeys, schemaMissing, schemaAge, availableMarkets } = columnSet

  // ── 3. the listings for these products on this market's coordinates ─
  const productIds = flat.map((r) => r.id as string)
  const listingRows = productIds.length === 0 || coordinates.length === 0 ? [] : await prisma.channelListing.findMany({
    where: {
      productId: { in: productIds },
      OR: coordinates.map((c) => ({ channel: c.channel, marketplace: c.marketplace })),
    },
    select: {
      id: true, productId: true, channel: true, marketplace: true, listingStatus: true, isPublished: true,
      price: true, quantity: true, externalListingId: true, overrideData: true,
      titleOverride: true, descriptionOverride: true, priceOverride: true, quantityOverride: true, bulletPointsOverride: true,
      followMasterTitle: true, followMasterDescription: true, followMasterPrice: true,
      followMasterQuantity: true, followMasterImages: true, followMasterBulletPoints: true,
    },
  })

  const listingsByProduct = new Map<string, Map<string, (typeof listingRows)[number]>>()
  for (const l of listingRows) {
    const key = coordKey({ channel: l.channel, marketplace: l.marketplace })
    if (!listingsByProduct.has(l.productId)) listingsByProduct.set(l.productId, new Map())
    listingsByProduct.get(l.productId)!.set(key, l)
  }

  // ── 4. pure per-row work ──────────────────────────────────────────
  const rows: SheetRow[] = flat.map((raw) => {
    const product = raw as unknown as ProductLike & Record<string, unknown>
    const parent = product.parentId ? parentById.get(product.parentId) ?? null : null
    const isParent = !product.parentId

    // The sheet is a MASTER surface: values are resolved WITHOUT a channel listing, so a cell shows
    // the master truth. Channel divergence is shown by the readiness columns, not by the cell.
    const resolved: ResolvedAttributes = resolveAttributes({ product, parent, locale })

    const values: Record<string, SheetCellValue> = {}
    for (const col of columns) {
      // A `column`-stored key (sku, name, status, basePrice…) is NOT in the resolver's output — the
      // resolver walks the JSONB bags. Reading only from it left every identity and pricing cell
      // empty on real data while the values sat right there on the row.
      if (col.storage === 'column') {
        const raw = normaliseColumnValue((product as unknown as Record<string, unknown>)[col.key], col.kind)
        if (isBlank(raw)) continue
        values[col.key] = { value: raw, source: 'masterColumn', inheritedFrom: null, inherited: false }
        continue
      }

      const hit = resolved[col.key]
      // A key the resolver returns with a null value is ABSENT, not "inherited nothing" — reporting
      // it as inherited paints a tint on an empty cell and tells the operator a parent supplied it.
      if (!hit || isBlank(hit.value)) continue
      const own = ownValue(product, col, locale)
      values[col.key] = {
        value: hit.value,
        source: hit.source,
        inheritedFrom: hit.inheritedFrom,
        inherited: !isParent && col.scope === 'global' && isBlank(own) && hit.inheritedFrom !== null,
      }
    }

    const listings: Record<string, SheetListing> = {}
    const readiness: Record<string, SheetReadiness> = {}
    const mine = listingsByProduct.get(product.id)
    for (const c of coordinates) {
      const key = coordKey(c)
      const l = mine?.get(key)
      const listing: SheetListing | null = l
        ? {
            id: l.id,
            listingStatus: l.listingStatus,
            isPublished: l.isPublished,
            price: decimalToNumber(l.priceOverride ?? l.price),
            quantity: l.quantityOverride ?? l.quantity ?? null,
            externalListingId: l.externalListingId,
            follows: Object.fromEntries(FOLLOW_FLAGS.map((f) => [f, (l as unknown as Record<string, boolean>)[f] !== false])),
          }
        : null
      if (listing) listings[key] = listing
      readiness[key] = computeReadiness({ columns, values, row: { isParent, productType: product.productType as string | null }, coordinate: c, listing })
    }

    return {
      id: product.id,
      sku: raw.sku as string,
      name: (raw.name as string) ?? null,
      parentId: product.parentId,
      isParent,
      status: (raw.status as string) ?? 'ACTIVE',
      productType: (raw.productType as string) ?? null,
      version: (raw.version as number) ?? 1,
      basePrice: decimalToNumber(raw.basePrice),
      childCount: (raw.__childCount as number) ?? 0,
      values,
      listings,
      readiness,
      completeness: completenessFor(columns, { isParent, productType: (raw.productType as string) ?? null }, values),
    }
  })

  return { market, locale, coordinates, columns, rows, total, page, limit, droppedKeys, schemaMissing, schemaAge, availableMarkets }
}

export { coordinatesFor }
