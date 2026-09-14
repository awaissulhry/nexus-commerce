import { offerActiveHonoured } from '@nexus/shared/listing-capabilities'
import { contentField, translationMissing } from './content-resolver.js'
import { contentWireValue } from './content-read.js'
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
import { buildCoordinateValidators, evaluateRow, type CoordinateValidators, type FlatRow } from './readiness.service.js'
import { projectCellValue, isBlankValue } from './sheet-values.js'

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
  /**
   * LX.F P2-14 — the FACT, so no reader has to match the sentence. The catalogue
   * filter and the `fallback@<lang>` projection both read this key; the wording
   * of `message` stays free to change without silently falsifying either.
   *
   * VT.1b widened it with the three variation kinds for the same reason: the catalogue's
   * `variation-mapping:unset|collides` filter narrows on `missing[].kind`, never on the sentence.
   */
  kind?: 'language-fallback' | 'theme-unset' | 'collision' | 'attribute-unbound'
}

export interface SheetReadiness {
  state: ReadinessState
  issues: ReadinessIssue[]
  /** The channel's own id once it exists — an ASIN, an eBay item id. */
  ref?: string
}

export interface SheetListing {
  offerClosedAt?: string | null
  offerClosedBy?: string | null
  offerCloseReason?: string | null
  syncPaused?: boolean | null
  /** Raw provider detail is distinct from the local listing status. */
  channelFactDetail?: { shopifyStatus?: string; [key: string]: unknown } | null
  /** Whether this adapter honours the local offer mark. Absent is unknown. */
  offerActiveHonoured?: boolean
  id: string
  /**
   * When a sync last RAN for this listing — #327(8), for the Listings pane,
   * which had no time reference at all.
   *
   * ⚠ This is NOT "last checked against the channel". Nothing polls the channel
   * to confirm the remote still matches; this is only the last time our own sync
   * executed. A renderer that labels it "last checked" would be displaying a
   * freshness guarantee that does not exist. `null` = never synced.
   *
   * OPTIONAL because two other constructors build this type
   * (`sheet-rows.service.ts:416` and the test factory); a required field would
   * break them for a value only the studio read supplies.
   */
  lastSyncedAt?: string | null
  /**
   * The LISTING's own optimistic-concurrency token — NOT the product's.
   *
   * A channel-scoped write CASes on this (products.routes.ts), so a client that
   * sends `Product.version` instead conflicts against the wrong number.
   * Measured 2026-09-01: **868 of 977 listings (89%) carry a version differing
   * from their product's**, gaps up to 88. Without this field the read contract
   * simply could not supply what the write contract checks, and every channel
   * write would 409 on a conflict that never happened — which trains an
   * operator to dismiss the one message that must always mean something.
   */
  version: number
  listingStatus: string
  isPublished: boolean
  /**
   * MA.1 operator offer control, distinct from `isPublished`: false means the
   * OFFER is paused for this coordinate (listing data preserved, buy box
   * suppressed) rather than the listing being unpublished. It exists on
   * ChannelListing and was never exposed, so a drawer could not render the
   * offer state honestly — it had to infer it from isPublished, which is a
   * different thing.
   */
  offerActive: boolean
  price: number | null
  quantity: number | null
  externalListingId: string | null
  /** Only the six fields that actually have a follow flag; attributes have none. */
  follows: Record<string, boolean>
}

/**
 * LX.F R-LX-15 — ONE content wire, two surfaces, and the difference is DECLARED.
 *
 * The §3 fields (`tier`, `language`, `requested`, `provenance`, `translation`) are the
 * contract; the four `*Locale`/`translationState`/`needsTranslation` fields are LEGACY
 * and are DERIVED from them by the single producer (`content-read.ts`
 * `contentAttribute`), never computed a second time. `StudioCellValue` omits the legacy
 * four (`studio-sheet.service.ts:133`) while this catalogue wire still carries them,
 * because these consumers read them today — measured, not assumed
 * (`/usr/bin/grep -rln`, excluding tests):
 *   API  `routes/product-translations.routes.ts` · `shopify/channel-sheet-projection.ts`
 *        · `pim/mapping/resolve-batch.service.ts` · `pim/mapping/cell-formula.service.ts`
 *        · `pim/resolve-channel-field.ts`
 *   web  `products/[id]/edit/tabs/MappingTab.tsx`
 *        · `_shared/cockpit-shell/CatalogCascadeDrawer.tsx`
 *        · `_studio/sheet/channel/cellDetailsSource.ts`
 * Deleting them is a follow-up claim per consumer (each must read the §3 field instead);
 * `content-wire-parity.vitest.test.ts` fails if the two mirrors stop agreeing on the §3
 * set, or if the legacy set grows.
 */
export interface SheetCellValue {
  mapped?: { requiredByRule?: boolean } | null
  /** LEGACY (see above): derived from the §3 fields by the one producer. */
  requestedLocale?: string
  /** LEGACY: `language` says the same thing. */
  effectiveLocale?: string
  /** LEGACY: derivable from `translation` + `language` vs `requested`. */
  translationState?: import('./attribute-resolver.js').ResolvedValue['translationState']
  /** LEGACY: `translationMissing({ language }, requested)`. */
  needsTranslation?: boolean
  // §3 `ResolvedContent`, the contract both wires carry.
  tier?: import('./content-resolver.js').ResolvedContent['tier']
  language?: import('./content-resolver.js').ResolvedContent['language']
  requested?: import('./content-resolver.js').ResolvedContent['requested']
  provenance?: import('./content-resolver.js').ResolvedContent['provenance']
  translation?: import('./content-resolver.js').ResolvedContent['translation']
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
  /**
   * Load EXACTLY these product rows, ignoring family paging — what a publish preview needs, where
   * the operator has ticked a specific set and a family expansion would judge rows nobody selected.
   * Parents are still fetched (never returned) because a variation's global values resolve through
   * them.
   */
  ids?: string[]
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
  row: { isParent: boolean; productType: string | null; familyId?: string | null }
  coordinate: SheetCoordinate
  listing?: SheetListing | null
  /**
   * PES.5 — pre-built validator inputs for this (coordinate, productType,
   * isParent). Deriving them is per-COORDINATE work, not per-row, so the batched
   * reader builds them once and hands them in. Omitted (every existing caller
   * and every test), they are built here and behaviour is identical.
   */
  validators?: CoordinateValidators
}): SheetReadiness {
  const { columns, values, row, coordinate, listing } = input
  const validators = input.validators ?? buildCoordinateValidators(columns, coordinate, row)

  // PES.5 — validation is no longer implemented here. `readiness.service.ts`
  // delegates to the SAME pure validators the publish path uses, so the pill and
  // the preview can no longer disagree about one product. See that file's header
  // for what the inline version was silently missing (GPSR, GTIN mod-10) and for
  // the one thing deliberately NOT delegated (closed-list severity).
  const flat: FlatRow = {}
  for (const [key, cell] of Object.entries(values)) flat[key] = cell?.value

  if (Object.values(values).some(cell => cell?.effectiveLocale) && !coordinate.languages?.length) throw new Error('Content readiness requires hydrated Marketplace.languages.')
  const labelByKey = new Map(columns.map((c) => [c.key, c.label]))
  const issues: ReadinessIssue[] = evaluateRow(flat, validators, coordinate.languages?.length ? { requested: coordinate.languages[0], fields: Object.fromEntries(Object.entries(values).filter(([, cell]) => cell.effectiveLocale).map(([key, cell]) => [key, { language: cell.effectiveLocale }])) } : undefined).map((i) => ({
    key: i.field,
    label: labelByKey.get(i.field) ?? i.field,
    message: i.message,
    // PreflightIssue says 'warning'; the sheet's wire contract has always said
    // 'warn'. Mapped at the boundary rather than renaming a shipped API field.
    severity: i.severity === 'error' ? 'error' : 'warn',
  }))

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

export function completenessFor(columns: SheetColumn[], row: { isParent: boolean; productType: string | null; familyId?: string | null }, values: Record<string, SheetCellValue>): MasterCompleteness {
  const applicable = columns.filter((c) => applies(c, row))
  const asMaster: MasterAttribute[] = applicable.map((c) => ({
    key: c.key,
    label: c.label,
    type: (c.kind === 'longtext' ? 'text' : c.kind === 'date' ? 'text' : c.kind) as MasterAttribute['type'],
    required: values[c.key]?.mapped?.requiredByRule === true || requiredHere(c, 'Master', row.productType, row.familyId, values) || c.requiredBy.some(label => requiredHere(c, label, row.productType, row.familyId, values)),
    group: c.group,
    source: 'schema',
  }))
  const flat: Record<string, unknown> = {}
  for (const c of applicable) flat[c.key] = values[c.key]?.requestedLocale && translationMissing({ language: values[c.key].effectiveLocale }, values[c.key].requestedLocale!) ? null : values[c.key]?.value
  return computeMasterCompleteness(asMaster, flat)
}

// ────────────────────────────────────────────────────────────────────
// The DB-backed read
// ────────────────────────────────────────────────────────────────────

const FOLLOW_FLAGS = ['followMasterTitle', 'followMasterDescription', 'followMasterPrice', 'followMasterQuantity', 'followMasterImages', 'followMasterBulletPoints'] as const

const PRODUCT_SELECT = {
  workspaceId: true, translations: true,
  familyId: true, weightValue: true, weightUnit: true, dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
  costPrice: true, minMargin: true, minPrice: true, maxPrice: true, lowStockThreshold: true,
  hsCode: true, countryOfOrigin: true, ppeCategory: true, garmentClass: true,
  hazmatClass: true, hazmatUnNumber: true, notifiedBodyNumber: true, notifiedBodyName: true,
  declarationOfConformityUrl: true, impactProtectors: true,
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

  const flat: Array<Record<string, unknown>> = []
  const parentById = new Map<string, ProductLike>()
  let total: number

  if (input.ids?.length) {
    // Exact rows, no family expansion. Their parents are loaded for resolution only.
    const picked = await prisma.product.findMany({ where: { id: { in: input.ids }, deletedAt: null }, select: PRODUCT_SELECT })
    const parentIds = [...new Set(picked.map((r) => r.parentId).filter((v): v is string => !!v))]
    const parents = parentIds.length
      ? await prisma.product.findMany({ where: { id: { in: parentIds } }, select: PRODUCT_SELECT })
      : []
    for (const p of parents) parentById.set(p.id, p as unknown as ProductLike)
    for (const p of picked) {
      // A picked row that is itself a parent resolves against itself for its own global values.
      if (!p.parentId) parentById.set(p.id, p as unknown as ProductLike)
      flat.push({ ...p, __childCount: 0 })
    }
    total = picked.length
  } else {
    const [count, families] = await Promise.all([
      prisma.product.count({ where: familyWhere }),
      prisma.product.findMany({
        where: familyWhere,
        select: { ...PRODUCT_SELECT, children: { where: { deletedAt: null }, select: PRODUCT_SELECT, orderBy: { sku: 'asc' } } },
        orderBy: { sku: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ])
    total = count
    for (const f of families as Array<Record<string, unknown>>) {
      const { children, ...parent } = f as { children?: Array<Record<string, unknown>> } & Record<string, unknown>
      parentById.set(parent.id as string, parent as unknown as ProductLike)
      flat.push({ ...parent, __childCount: children?.length ?? 0 })
      for (const c of children ?? []) flat.push({ ...c, __childCount: 0 })
    }
  }

  // ── 2. the columns for this market (once, not per row) ────────────
  const productTypes = [...new Set(flat.map((r) => r.productType).filter(Boolean) as string[])]
  // What these families actually vary by decides which columns belong to a variation rather than to
  // the parent — the catalogue's own answer, not a hardcoded guess.
  const variationAxes = [...new Set(flat.flatMap((r) => (Array.isArray(r.variationAxes) ? (r.variationAxes as string[]) : [])))]
  // AM.1 — the eBay leaf categories these products are listed under decide the eBay aspects.
  const ebayCategoryRows = flat.length === 0 ? [] : await prisma.channelListing.findMany({
    where: { productId: { in: flat.map((r) => r.id as string) }, channel: 'EBAY', marketplace: market },
    select: { translations: true, platformAttributes: true },
  })
  const ebayCategoryIds = [...new Set(ebayCategoryRows.map((r) => (r.platformAttributes as { categoryId?: unknown } | null)?.categoryId).filter((c): c is string => typeof c === 'string' && c.length > 0))].sort()
  const columnSet: SheetColumnSet = await getSheetColumns({ market, productTypes, variationAxes, ebayCategoryIds })
  const { columns, coordinates, locale, droppedKeys, schemaMissing, schemaAge, availableMarkets } = columnSet

  // ── 3. the listings for these products on this market's coordinates ─
  const productIds = flat.map((r) => r.id as string)
  const listingRows = productIds.length === 0 || coordinates.length === 0 ? [] : await prisma.channelListing.findMany({
    where: {
      productId: { in: productIds },
      OR: coordinates.map((c) => ({ channel: c.channel, marketplace: c.marketplace })),
    },
    select: { translations: true,
      id: true, productId: true, channel: true, marketplace: true, listingStatus: true, isPublished: true,
      version: true,
      price: true, quantity: true, externalListingId: true, overrideData: true,
      titleOverride: true, descriptionOverride: true, priceOverride: true, quantityOverride: true, bulletPointsOverride: true,
      followMasterTitle: true, followMasterDescription: true, followMasterPrice: true,
      followMasterQuantity: true, followMasterImages: true, followMasterBulletPoints: true,
      offerActive: true, offerClosedAt: true, offerClosedBy: true, offerCloseReason: true, syncPaused: true,
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
    const resolved: ResolvedAttributes = resolveAttributes({ product, parent, locale, localizableKeys: columns.filter(c => c.storage === 'localizedContent').map(c => c.slot?.of ?? c.key) })

    const values: Record<string, SheetCellValue> = {}
    for (const col of columns) {
      // A `column`-stored key (sku, name, status, basePrice…) is NOT in the resolver's output — the
      // resolver walks the JSONB bags. Reading only from it left every identity and pricing cell
      // empty on real data while the values sat right there on the row.
      // AM.1 — a slot reads its LIST's store (`bulletPoints` for `bulletPoints_3`) and shows one
      // item; a list/measure column normalises the stored shape. Same projection as the studio.
      const baseKey = contentField(col.slot?.of ?? col.key)
      const contentHit = resolved[baseKey]?.language ? resolved[baseKey] : null
      if (contentHit) {
        values[col.key] = { value: contentWireValue(projectCellValue(col, contentHit.value), col.slot ? undefined : col.shape, col.slot?.of ?? col.key),
          source: contentHit.source, inheritedFrom: contentHit.inheritedFrom, inherited: contentHit.contentProvenance?.member === 'inherited',
          // R-LX-15 — the §3 fields travel on this wire too, from the same resolved row,
          // so a consumer can migrate off the legacy four without a second read.
          tier: contentHit.tier, language: contentHit.language, requested: contentHit.requested,
          provenance: contentHit.contentProvenance, translation: contentHit.content?.translation,
          requestedLocale: locale, effectiveLocale: contentHit.language, translationState: contentHit.translationState,
          needsTranslation: translationMissing(contentHit, locale) }
        continue
      }
      if (col.storage === 'column') {
        const raw = projectCellValue(col, normaliseColumnValue((product as unknown as Record<string, unknown>)[baseKey], col.kind))
        if (isBlankValue(raw)) continue
        values[col.key] = { value: raw, source: 'masterColumn', inheritedFrom: null, inherited: false }
        continue
      }

      let hit = resolved[baseKey]
      // A key the resolver returns with a null value is ABSENT, not "inherited nothing" — reporting
      // it as inherited paints a tint on an empty cell and tells the operator a parent supplied it.
      if (!hit || isBlankValue(hit.value)) continue
      const projected = projectCellValue(col, hit.value)
      if (isBlankValue(projected)) continue
      const own = ownValue(product, { ...col, key: baseKey }, locale)
      values[col.key] = {
        value: projected,
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
            version: l.version,
            listingStatus: l.listingStatus,
            isPublished: l.isPublished,
            price: decimalToNumber(l.priceOverride ?? l.price),
            quantity: l.quantityOverride ?? l.quantity ?? null,
            externalListingId: l.externalListingId,
            offerActive: l.offerActive !== false,
            offerActiveHonoured: offerActiveHonoured(c.channel),
            offerClosedAt: l.offerClosedAt?.toISOString() ?? null,
            offerClosedBy: l.offerClosedBy ?? null,
            offerCloseReason: l.offerCloseReason ?? null,
            syncPaused: l.syncPaused ?? null,
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
