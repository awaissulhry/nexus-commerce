/**
 * MS.1 — the MASTER SHEET's columns for one market.
 *
 * `docs/2026-08-29-master-sheet-design.md`. The sheet edits the master cell by cell for one market;
 * its columns are the master attributes that market's channels actually read, carrying the metadata
 * a cell needs to warn honestly: the tightest length cap, the enum and whether it is closed, which
 * channel requires the field, and whether the field belongs to a parent or to each variation.
 *
 * Why this exists rather than `getMasterAttributeSchema(productId)`:
 *   - that one is PER PRODUCT — for a 50-row page it fires N `getAvailableFields` calls plus a rules
 *     resolve per coordinate plus enum-label calls, i.e. hundreds of round-trips;
 *   - it UNIONS the product's Amazon markets, so an IT sheet would carry DE-only attributes;
 *   - and `schema-to-fields.ts` DROPS `maxLength`, so a counter cell would have no cap at all.
 * The caps live in the cached Amazon product-type definitions and in `ChannelSchema` for eBay
 * aspects. So this service merges three sources ONCE per (market × productTypes), not once per row:
 *
 *   field registry  → which fields exist at all (the master key set)
 *   CategorySchema  → maxLength / byte cap / closed enums / required, per product type (CACHE ONLY)
 *   ChannelSchema   → eBay aspect caps and required-ness for the same market
 *
 * `buildSheetColumns` is PURE and unit-tested; `getSheetColumns` is the DB-backed wrapper.
 */
import type { FieldDefinition } from './field-registry.service.js'
import type { MergedCaps, SchemaCap } from './schema-caps.js'

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export type SheetChannel = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'

/**
 * One channel × marketplace pair the sheet reports on. A MARKET IS A COORDINATE LIST, not a filter:
 * there is no `Market` entity, `"IT"` is a string on `Marketplace.code` and on
 * `ChannelListing.marketplace`, and the webstore channels are seeded at `marketplace = 'GLOBAL'`.
 * So market IT = [{AMAZON,IT}, {EBAY,IT}, {SHOPIFY,GLOBAL}].
 */
export interface SheetCoordinate {
  channel: SheetChannel
  marketplace: string
  /** How the column header and readiness pill name it, e.g. `Amazon · IT`. */
  label: string
  /** False when the coordinate's marketplace is not the sheet's market (the webstore is GLOBAL). */
  inMarket: boolean
}

export type SheetColumnKind = 'text' | 'longtext' | 'number' | 'select' | 'boolean' | 'date'

/** Where the cell's value actually lives — decides how a write is addressed. */
export type SheetStorage = 'column' | 'categoryAttributes' | 'localizedContent'

export interface SheetColumn {
  /** The master key. For `categoryAttributes` this is the bare attribute name (no `attr_` prefix). */
  key: string
  /** What `PATCH /api/products/bulk` expects in `changes[].field` (`attr_*` keeps its prefix). */
  writeField: string
  label: string
  group: string
  kind: SheetColumnKind
  storage: SheetStorage
  /**
   * `global` lives on the parent and every variation inherits it (edit a variation's cell to pin it);
   * `per_variant` belongs to each variation and is LOCKED on the parent row.
   */
  scope: 'global' | 'per_variant'
  options?: string[]
  optionLabels?: Record<string, string>
  /** `strict` = the channel accepts only the list (an off-list value WARNS, never blocks). */
  mode?: 'strict' | 'open'
  /** Which coordinates require this field. Empty = required by none. */
  requiredBy: string[]
  /** The TIGHTEST character cap across the coordinates, and who set it. */
  maxLength?: number
  maxBytes?: number
  capFrom?: string
  /** Product types that define this column (union manifests only); undefined = all. */
  applicableProductTypes?: string[]
  /** Types that require it — a row of another type shows the cell as optional. */
  requiredForProductTypes?: string[]
  editable: boolean
  width?: number
  helpText?: string
  /**
   * Whether the sheet shows this column before the operator opens Customise. The full set is always
   * RETURNED — 174 columns came back for four real product types, and a 174-column sheet is
   * unreadable — but a sheet opens on the master's own shape plus whatever a channel requires.
   */
  defaultVisible: boolean
  /** Enum values the channel still offers but marks deprecated — warn, never block. */
  deprecatedOptions?: string[]
}

export interface SheetColumnSet {
  market: string
  locale: string
  coordinates: SheetCoordinate[]
  productTypes: string[]
  columns: SheetColumn[]
  /** Fields the registry offered that no coordinate reads — reported, never rendered. */
  droppedKeys: string[]
  /**
   * Product types with NO cached Amazon schema at all, so their columns carry no caps and no closed
   * enums. Named rather than hidden: a counter with no cap must not look like a cap of none.
   */
  schemaMissing: string[]
  /** When each type's cap data was fetched — the sheet says "caps as of …" rather than implying now. */
  schemaAge: Array<{ productType: string; fetchedAt: string }>
  /**
   * The markets that actually carry listings, for the sheet's market switcher. Derived from the
   * presence query this service already runs, so the client needs no second round trip and cannot
   * offer a market with nothing in it.
   */
  availableMarkets: string[]
}

export interface BuildSheetColumnsInput {
  fields: FieldDefinition[]
  /** Caps read from the CACHED Amazon product-type definitions (never a live SP-API call). */
  amazon?: MergedCaps
  /** eBay aspects cached for this market (`ChannelSchema` rows). */
  ebayAspects?: EbayAspect[]
  coordinates: SheetCoordinate[]
  /** The variation axes these families actually vary by (`Product.variationAxes`), e.g. Color, Size. */
  variationAxes?: string[]
}

export interface EbayAspect {
  fieldKey: string
  label: string
  maxLength: number | null
  required: boolean
  allowedValues: unknown
}

// ────────────────────────────────────────────────────────────────────
// Grouping + shape
// ────────────────────────────────────────────────────────────────────

/** Field-registry category → the sheet's column group. Order here is the column order. */
const GROUP_BY_CATEGORY: Record<string, string> = {
  universal: 'Identity',
  content: 'Content',
  category: 'Attributes',
  identifiers: 'Identifiers',
  pricing: 'Pricing',
  inventory: 'Inventory',
  physical: 'Physical',
  amazon: 'Amazon',
  ebay: 'eBay',
}
export const SHEET_GROUP_ORDER = ['Identity', 'Content', 'Attributes', 'Identifiers', 'Pricing', 'Inventory', 'Physical', 'Amazon', 'eBay']

/** Groups a sheet opens with; everything else is one Customise click away. */
const DEFAULT_VISIBLE_GROUPS = new Set(['Identity', 'Content', 'Identifiers', 'Pricing'])

/** Master keys that live in `localizedContent[locale]` rather than a column or the attribute bag. */
const LOCALIZED_KEYS = new Set(['title', 'description', 'bulletPoints', 'keywords'])

/** Identifiers that are inherently per-variation, whatever the schema says about parentage. */
const PER_VARIANT_KEYS = new Set(['sku', 'gtin', 'ean', 'upc', 'asin', 'barcode'])

/**
 * A cell that reads as PROSE gets the popup editor and a counter. Cap size is NOT the signal —
 * Amazon gives `color` a 1000-character cap and `product_tax_code` 949, and neither is prose. The
 * key is. (Measured on the real IT schema 2026-08-29: a cap-based rule made 12 one-word attributes
 * open a textarea.)
 */
const LONGTEXT_KEYS = new Set([
  'title', 'item_name', 'description', 'product_description', 'keywords', 'generic_keyword',
  'search_terms', 'bulletPoints', 'bullet_point', 'care_instructions', 'special_feature',
  'fabric_type', 'legal_disclaimer_description', 'safety_warning',
])

/** Normalised join key: Amazon `outer_material` and eBay `Outer Material` become the same token. */
export function normaliseKey(raw: string): string {
  return String(raw)
    .replace(/^attr_/, '')
    .replace(/^aspect_/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function kindFor(field: FieldDefinition): SheetColumnKind {
  if (field.type === 'boolean') return 'boolean'
  if (field.type === 'number') return 'number'
  if (field.type === 'date') return 'date'
  if (field.type === 'select') return 'select'
  const key = field.id.replace(/^attr_/, '')
  if (LONGTEXT_KEYS.has(key) || /_description$/.test(key)) return 'longtext'
  return 'text'
}

function storageFor(field: FieldDefinition): SheetStorage {
  if (field.id.startsWith('attr_')) return 'categoryAttributes'
  if (LOCALIZED_KEYS.has(field.id)) return 'localizedContent'
  return 'column'
}

/**
 * A column is per-variation when the schema says it applies to variation CHILDREN but not to a
 * variation PARENT, or when it is an identifier that cannot be shared. Everything else is global and
 * inherits down — which is what `resolveAttributes` already does at read time.
 */
/**
 * The catalogue's own answer beats the schema's: if a family varies BY colour, colour is
 * per-variation for these rows whatever a hardcoded fallback field list thinks.
 *
 * The axes are stored as the operator's LABELS, not schema keys — the real IT catalogue carries
 * `variationAxes: ["Colore","Taglia"]` while the attributes are `color` and `size`. So an axis is
 * matched against the key AND the column's localised label; matching only the key silently marked
 * every variation axis `global` and offered a parent row a size for the whole family.
 */
function scopeFor(key: string, label: string | undefined, variationAxes?: Set<string>): 'global' | 'per_variant' {
  const norm = normaliseKey(key)
  if (PER_VARIANT_KEYS.has(key) || PER_VARIANT_KEYS.has(norm)) return 'per_variant'
  if (variationAxes?.has(norm)) return 'per_variant'
  if (label && variationAxes?.has(normaliseKey(label))) return 'per_variant'
  return 'global'
}

/** The tightest cap wins, and we remember which coordinate set it so the UI can say why. */
function tightest(
  current: { maxLength?: number; capFrom?: string },
  candidate: number | null | undefined,
  from: string,
): { maxLength?: number; capFrom?: string } {
  if (candidate == null || !Number.isFinite(candidate) || candidate <= 0) return current
  if (current.maxLength === undefined || candidate < current.maxLength) return { maxLength: candidate, capFrom: from }
  return current
}

// ────────────────────────────────────────────────────────────────────
// The pure merge
// ────────────────────────────────────────────────────────────────────

export function buildSheetColumns(input: BuildSheetColumnsInput): { columns: SheetColumn[]; droppedKeys: string[] } {
  const { fields, amazon, ebayAspects = [], coordinates, variationAxes = [] } = input
  const axes = new Set(variationAxes.map(normaliseKey).filter(Boolean))

  const amazonCoord = coordinates.find((c) => c.channel === 'AMAZON')
  const ebayCoord = coordinates.find((c) => c.channel === 'EBAY')

  // The cached Amazon definitions, indexed by the normalised attribute name.
  const amazonByKey = new Map<string, { cap: SchemaCap; definedBy: string[]; requiredBy: string[] }>()
  for (const [name, cap] of Object.entries(amazon?.caps ?? {})) {
    amazonByKey.set(normaliseKey(name), {
      cap,
      definedBy: amazon?.definedBy[name] ?? [],
      requiredBy: amazon?.requiredBy[name] ?? [],
    })
  }

  const ebayByKey = new Map<string, EbayAspect>()
  for (const a of ebayAspects) {
    const k = normaliseKey(a.fieldKey)
    if (!ebayByKey.has(k)) ebayByKey.set(k, a)
  }

  const columns: SheetColumn[] = []
  const droppedKeys: string[] = []
  const seen = new Set<string>()

  for (const field of fields) {
    const storage = storageFor(field)
    const key = storage === 'categoryAttributes' ? field.id.replace(/^attr_/, '') : field.id
    const norm = normaliseKey(key)
    if (seen.has(norm)) continue
    seen.add(norm)

    const az = amazonByKey.get(norm)
    const ebay = ebayByKey.get(norm)

    // A master attribute no coordinate in this market reads is noise on the sheet. Non-attribute
    // fields (columns, content, price) are always kept — they are the master's own shape.
    if (storage === 'categoryAttributes' && !az && !ebay) {
      droppedKeys.push(key)
      continue
    }

    let cap: { maxLength?: number; capFrom?: string } = {}
    if (az && amazonCoord) cap = tightest(cap, az.cap.maxLength, amazonCoord.label)
    if (ebay && ebayCoord) cap = tightest(cap, ebay.maxLength, ebayCoord.label)

    const requiredBy: string[] = []
    if (amazonCoord && az?.cap.required) requiredBy.push(amazonCoord.label)
    if (ebayCoord && ebay?.required) requiredBy.push(ebayCoord.label)

    const label = az?.cap.label || field.label
    const options = az?.cap.options ?? field.options ?? (Array.isArray(ebay?.allowedValues) ? (ebay!.allowedValues as unknown[]).map(String) : undefined)
    const kind = kindFor(field)

    columns.push({
      key,
      writeField: field.id,
      label,
      group: GROUP_BY_CATEGORY[field.category] ?? 'Attributes',
      kind: options && options.length > 0 && kind === 'text' ? 'select' : kind,
      storage,
      scope: scopeFor(key, label, axes),
      options: options && options.length > 0 ? options : undefined,
      optionLabels: az?.cap.optionLabels,
      mode: options && options.length > 0 ? (az?.cap.selectionOnly ? 'strict' : 'open') : undefined,
      requiredBy,
      maxLength: cap.maxLength,
      maxBytes: az?.cap.maxBytes,
      capFrom: cap.capFrom,
      applicableProductTypes: az && az.definedBy.length > 0 ? az.definedBy : undefined,
      requiredForProductTypes: az && az.requiredBy.length > 0 ? az.requiredBy : undefined,
      // Amazon's `editable: false` means "cannot be changed on an EXISTING listing" — the sheet
      // still lets you author it on a draft, so it stays editable here and preflight warns.
      editable: field.editable !== false,
      width: field.width,
      helpText: field.helpText ?? az?.cap.helpText,
      defaultVisible: requiredBy.length > 0 || DEFAULT_VISIBLE_GROUPS.has(GROUP_BY_CATEGORY[field.category] ?? 'Attributes'),
      deprecatedOptions: az?.cap.deprecatedOptions,
    })
  }

  const groupRank = (g: string) => {
    const i = SHEET_GROUP_ORDER.indexOf(g)
    return i === -1 ? SHEET_GROUP_ORDER.length : i
  }
  columns.sort((a, b) => {
    const g = groupRank(a.group) - groupRank(b.group)
    if (g !== 0) return g
    // Required-first inside a group, then alphabetical — the MA.2 editor's rule.
    const r = (b.requiredBy.length > 0 ? 1 : 0) - (a.requiredBy.length > 0 ? 1 : 0)
    if (r !== 0) return r
    return a.label.localeCompare(b.label)
  })

  return { columns, droppedKeys }
}

// ────────────────────────────────────────────────────────────────────
// Market → coordinates
// ────────────────────────────────────────────────────────────────────

/** Channels whose marketplaces are seeded `GLOBAL` — the webstore is not in any country market. */
const GLOBAL_CHANNELS: SheetChannel[] = ['SHOPIFY', 'WOOCOMMERCE', 'ETSY']

/** Channel display names. `Ebay`/`Woocommerce` are not how anyone writes these brands. */
const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', WOOCOMMERCE: 'WooCommerce', ETSY: 'Etsy',
}

export interface CoordinatesForOptions {
  /**
   * Coordinates that actually carry a listing, as `CHANNEL:MARKETPLACE`. When given, a channel with
   * no presence in this market is left OUT rather than shown as a column of "Unlisted" — three dead
   * columns teach the operator to stop reading the readiness strip. Pass `channels` to force one in
   * before its first listing exists.
   */
  present?: Set<string>
  /** Force these channels in whatever their presence (a channel being launched). */
  channels?: string[]
}

export function coordinatesFor(
  market: string,
  marketplaces: Array<{ channel: string; code: string; name?: string | null; isActive?: boolean }>,
  options: CoordinatesForOptions = {},
): SheetCoordinate[] {
  const code = String(market).toUpperCase()
  const out: SheetCoordinate[] = []
  for (const m of marketplaces) {
    if (m.isActive === false) continue
    const ch = String(m.channel).toUpperCase() as SheetChannel
    const isGlobalChannel = GLOBAL_CHANNELS.includes(ch)
    const matches = isGlobalChannel ? String(m.code).toUpperCase() === 'GLOBAL' : String(m.code).toUpperCase() === code
    if (!matches) continue
    const mp = String(m.code).toUpperCase()
    const forced = (options.channels ?? []).map((c) => c.toUpperCase()).includes(ch)
    if (options.present && !forced && !options.present.has(`${ch}:${mp}`)) continue
    const name = CHANNEL_LABEL[ch] ?? titleCase(ch)
    out.push({
      channel: ch,
      marketplace: mp,
      // The webstore is honestly labelled GLOBAL — it is the same catalogue, not an Italian listing.
      label: isGlobalChannel ? `${name} · GLOBAL` : `${name} · ${code}`,
      inMarket: !isGlobalChannel,
    })
  }
  const rank = (c: SheetCoordinate) => ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'].indexOf(c.channel)
  return out.sort((a, b) => rank(a) - rank(b))
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase()
}

// ────────────────────────────────────────────────────────────────────
// DB-backed wrapper
// ────────────────────────────────────────────────────────────────────

export interface GetSheetColumnsInput {
  market: string
  productTypes: string[]
  /** The variation axes present in the rows being shown. */
  variationAxes?: string[]
  /** Force these channels into the coordinate list before their first listing exists. */
  channels?: string[]
  /** Skip the presence check and report every active channel in the market. */
  includeEmptyChannels?: boolean
}

/**
 * Column sets are derived from a 24 h-cached schema plus a rarely-changing aspect table, and both
 * the columns route AND every row read need one. Caching here rather than in the route means a page
 * of rows does not pay the 50–500 KB schema read and the derivation on every keystroke of a search.
 */
const columnSetCache = new Map<string, { at: number; value: SheetColumnSet }>()
const COLUMN_SET_TTL_MS = 5 * 60_000

export async function getSheetColumns(input: GetSheetColumnsInput): Promise<SheetColumnSet> {
  const market = String(input.market).toUpperCase()
  const productTypes = [...new Set((input.productTypes ?? []).map((t) => String(t).toUpperCase()).filter(Boolean))]
  const axes = [...new Set((input.variationAxes ?? []).map((a) => String(a)))].sort()

  const cacheKey = JSON.stringify([market, productTypes.slice().sort(), axes, (input.channels ?? []).slice().sort(), !!input.includeEmptyChannels])
  const cached = columnSetCache.get(cacheKey)
  if (cached && Date.now() - cached.at < COLUMN_SET_TTL_MS) return cached.value

  const { default: prisma } = await import('../../db.js')
  const { getAvailableFields } = await import('./field-registry.service.js')

  const [marketplaceRows, presentRows] = await Promise.all([
    prisma.marketplace.findMany({
      where: { isActive: true },
      select: { channel: true, code: true, name: true, isActive: true, language: true },
    }),
    input.includeEmptyChannels
      ? Promise.resolve([] as Array<{ channel: string; marketplace: string }>)
      : prisma.channelListing.groupBy({ by: ['channel', 'marketplace'], _count: { _all: true } }),
  ])
  const present = input.includeEmptyChannels
    ? undefined
    : new Set(presentRows.map((r) => `${String(r.channel).toUpperCase()}:${String(r.marketplace).toUpperCase()}`))
  // A market is offered only when something is listed there; GLOBAL is the webstore's placeholder,
  // not a market an operator can pick.
  const availableMarkets = [...new Set(presentRows.map((r) => String(r.marketplace).toUpperCase()).filter((m) => m && m !== 'GLOBAL' && m !== 'DEFAULT'))].sort()
  const coordinates = coordinatesFor(market, marketplaceRows, { present, channels: input.channels })
  const locale = (marketplaceRows.find((m) => String(m.code).toUpperCase() === market)?.language ?? 'en').toLowerCase()

  const channels = [...new Set(coordinates.map((c) => c.channel))]
  // NOTE the missing `marketplace`: passing it makes `getAvailableFields` do its own dynamic schema
  // lookup, re-reading the same 50–500 KB definitions this service reads below — measured 7.8 s on
  // top of a 4.1 s read of the identical rows. Without it we get the static field sets plus the
  // hardcoded per-type fallback, and the schema-derived `attr_*` fields are derived once, here.
  const fields = await getAvailableFields({ productTypes, channels })

  // Amazon caps + enums, once for the whole sheet. A missing/stale schema cache is not fatal — the
  // sheet still renders, it just cannot show a cap, and `capFrom` says so by being absent.
  // CACHE ONLY, whatever the TTL. Going through the flat-file manifest would call
  // `CategorySchemaService.getSchema`, which refreshes from SP-API on an expired row — seconds of
  // latency on a path hit by every page load, and a hard throw when the refresh token is revoked.
  // Measured 2026-08-29 on the real IT catalogue: every cached IT schema was structurally complete
  // but a month past its 24 h TTL, so that path yielded zero caps for all four product types. A
  // month-old cap beats no cap; the age is REPORTED and refreshing is the schema-sync cron's job.
  let amazon: MergedCaps | undefined
  const schemaMissing: string[] = []
  const schemaAge: Array<{ productType: string; fetchedAt: string }> = []
  const dynamicFields: FieldDefinition[] = []
  if (coordinates.some((c) => c.channel === 'AMAZON') && productTypes.length > 0) {
    try {
      const { extractSchemaCaps, mergeSchemaCaps } = await import('./schema-caps.js')
      const { schemaToFieldDefinitions } = await import('./schema-to-fields.js')
      const rows = await prisma.categorySchema.findMany({
        where: { channel: 'AMAZON', marketplace: market, productType: { in: productTypes }, isActive: true },
        select: { productType: true, schemaDefinition: true, fetchedAt: true },
        orderBy: { fetchedAt: 'desc' },
        distinct: ['productType'],
      })
      const perType = rows.map((r) => ({ productType: r.productType, caps: extractSchemaCaps(r.schemaDefinition) }))
      amazon = mergeSchemaCaps(perType)
      // One read, two derivations: the caps above and the field set here.
      for (const r of rows) {
        dynamicFields.push(...schemaToFieldDefinitions({ productType: r.productType, schemaDefinition: r.schemaDefinition }))
        schemaAge.push({ productType: r.productType, fetchedAt: r.fetchedAt.toISOString() })
      }
      const have = new Set(rows.map((r) => r.productType))
      for (const t of productTypes) if (!have.has(t)) schemaMissing.push(t)
    } catch (err) {
      console.error('[sheet-columns] cached Amazon schema unreadable:', err instanceof Error ? err.message : err)
      schemaMissing.push(...productTypes)
    }
  }

  let ebayAspects: EbayAspect[] = []
  if (coordinates.some((c) => c.channel === 'EBAY')) {
    try {
      const rows = await prisma.channelSchema.findMany({
        where: { channel: 'EBAY', marketplace: market },
        select: { fieldKey: true, label: true, maxLength: true, required: true, allowedValues: true },
      })
      ebayAspects = rows as EbayAspect[]
    } catch (err) {
      console.error('[sheet-columns] eBay aspects unavailable:', err instanceof Error ? err.message : err)
    }
  }

  const { columns, droppedKeys } = buildSheetColumns({ fields: [...fields, ...dynamicFields], amazon, ebayAspects, coordinates, variationAxes: input.variationAxes })
  const value: SheetColumnSet = { market, locale, coordinates, productTypes, columns, droppedKeys, schemaMissing, schemaAge, availableMarkets }
  columnSetCache.set(cacheKey, { at: Date.now(), value })
  return value
}
