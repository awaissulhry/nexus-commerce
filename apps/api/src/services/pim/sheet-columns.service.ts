import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { marketLanguages } from './market-languages.js'
import { assertInformationLocale } from './information-locale.js'
import { WorkspaceCache } from '../../lib/workspace-cache.js'
/**
 * MS.1 / AM.1 — the SHEET's columns for one market and one scope.
 *
 * `docs/2026-08-29-master-sheet-design.md` (the master sheet) and
 * `docs/2026-09-04-channel-attribute-model-design.md` (AM.1, approved 2026-09-05). The sheet edits
 * cell by cell for one market; its columns are the master's own fields plus EVERY field the
 * market's channels declare for the family's categories, in the shape the channel gives them.
 *
 * What changed with AM.1, and why (measured on GALE-JACKET, 2026-09-04):
 *   - Columns used to come from the MASTER registry, with the channel schemas only DECORATING master
 *     keys (caps, required, options). A channel field with no master twin could not become a column:
 *     Amazon·IT carried 63 of its 109 schema properties, eBay·IT 0 of its 20 aspects. Now the
 *     channel SPECS (`channel-specs/`) are a SOURCE of columns and the master fields are the JOIN.
 *   - The contract had no vocabulary for shape. `bullet_point` (10 × 700 on every cached Amazon
 *     schema) was one cell; `item_weight` (value + unit) and every compound attribute were skipped.
 *     Columns now carry `shape`, `cardinality`, `unitOptions`; a bounded list becomes numbered SLOT
 *     columns (`bulletPoints_1 … _10`), an unbounded one a single chip-list column.
 *   - One concept, one column (Owner, 2026-09-05: "no duplications at all"). `item_name` and `name`
 *     both wrote the same cell as two columns; a channel field that IS a master field now links to it
 *     (`masterKey`) and the master column carries the channel's label, cap and requirement. The five
 *     dead `amazon_*` / `ebay_*` registry placeholders ("no backing column yet") are gone.
 *   - Per-coordinate facts stay per coordinate: `channels[coordinateLabel]` holds each channel's own
 *     key, label, cardinality, caps, store and requirement — a union sheet takes the tightest and
 *     names who set it (`reference_contract_field_varies_by_market`).
 *
 * `buildSheetColumns` is PURE and unit-tested; `getSheetColumns` is the DB-backed wrapper.
 */
import type { FieldDefinition } from './field-registry.service.js'
import {
  humanizeKey, isProseKey, normaliseKey, slotKey, SLOT_COLUMNS_MAX,
  type Cardinality, type ChannelFieldSpec, type ChannelSpec, type ChannelStore, type FieldShape, type Requirement,
} from './channel-specs/types.js'

export { normaliseKey, SLOT_COLUMNS_MAX }
import { canonicalVariantAxis } from './variant-attribute-keys.js'

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
  languages?: string[]
  channel: SheetChannel
  marketplace: string
  /** How the column header and readiness pill name it, e.g. `Amazon · IT`. */
  label: string
  /** False when the coordinate's marketplace is not the sheet's market (the webstore is GLOBAL). */
  inMarket: boolean
}

export type SheetColumnKind = 'text' | 'longtext' | 'number' | 'select' | 'boolean' | 'date'

/**
 * Where the cell's value actually lives — decides how a write is addressed.
 * `listing` (AM.1) = a store that exists ONLY on the ChannelListing (a listing column such as
 * `variationTheme`, or a `platformAttributes` path such as eBay's `itemSpecifics.Marca`); such a
 * column has no master value and appears on channel scopes only.
 */
export type SheetStorage = 'column' | 'categoryAttributes' | 'localizedContent' | 'listing'

/** AM.1 — one channel's own facts about a column, keyed by coordinate label on `SheetColumn.channels`. */
export interface SheetColumnChannelFacts {
  /** Exact category constraints. The coordinate summary is for headers only. */
  byCategory?: Record<string, SheetColumnChannelFacts>
  /** The channel's own key for this leaf (`item_name`, `aspect_Brand`, `closure`). */
  key: string
  /** The channel's top-level attribute (`closure` for `closure__type`; `aspect_Brand`). */
  attribute: string
  /** Sub-property path inside the attribute, for the outbound writer to rebuild the nesting. */
  path: string[]
  /** The channel's label in the marketplace language (`Punto elenco`, `Marca`). */
  label: string
  requirement: Requirement
  cardinality: Cardinality
  maxLength?: number
  maxBytes?: number
  options?: string[]
  mode?: 'strict' | 'open'
  store?: ChannelStore
  selectors?: string[]
  /** The channel hides it in its own UI. */
  hidden: boolean
  /** Amazon's `editable: false` — cannot change on an EXISTING listing; still authorable on a draft. */
  editableOnExisting: boolean
  /** The channel categories (Amazon product types / eBay category ids) that declared it. */
  categories: string[]
}

export interface SheetColumn {
  managedBy?: 'productMedia'
  shopifyField?: import('@nexus/shared/shopify-information').InformationField
  familyRules?: FieldDefinition['familyRules']
  validation?: Record<string, unknown>
  /**
   * The column key. For `categoryAttributes` this is the bare attribute name (no `attr_` prefix);
   * for a slot of a list it is `<base>_<n>`; for a compound leaf `<attribute>__<leaf>`.
   */
  key: string
  /** What `PATCH /api/products/bulk` expects in `changes[].field` (`attr_*` keeps its prefix). */
  writeField: string
  /** English (D10). */
  label: string
  group: string
  /** Stable presentation group identity; never part of the value or mapping address. */
  groupKey?: string
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
  /**
   * The marketplace's OWN term for this field, in that market's language — `label` is always
   * English (D10). The first coordinate's; every coordinate's rides in `channels[].label`.
   */
  channelLabel?: string
  /** Product types that define this column (Amazon-only columns); undefined = all. */
  applicableProductTypes?: string[]
  /** Types that require it — a row of another type shows the cell as optional. */
  requiredForProductTypes?: string[]
  editable: boolean
  width?: number
  helpText?: string
  /**
   * Whether the sheet shows this column before the operator opens Customise. Since the views design
   * (2026-09-04) the sheet LANDS FULL; this is the "Essentials" preset's hint, nothing more.
   */
  defaultVisible: boolean
  /** Enum values the channel still offers but marks deprecated — warn, never block. */
  deprecatedOptions?: string[]
  /** P11 — TRUE when this column IS one of the family's variation axes (set by `/studio/sheet`). */
  axis?: boolean
  /** #756 — would the FORMULA writer accept this column on this scope (set by `/studio/sheet`). */
  formulaWritable?: boolean
  // ── AM.1 shape vocabulary ─────────────────────────────────────────
  /** Default `scalar`. A `list` column's value is an array; a `measure` column's is `{ value, unit }`. */
  shape?: FieldShape
  /** list only. `max: null` = unbounded. A bounded list ≤ SLOT_COLUMNS_MAX is served as slot columns instead. */
  cardinality?: Cardinality
  /** measure only. */
  unitOptions?: string[]
  /**
   * This column is slot `index` (1-based) of the list `of`, whose full cardinality is `max`. The list
   * itself is NOT served as a column; readiness evaluates the list through its slots, the write
   * path addresses `of[index]`, import/export use the slot keys (`bulletPoints_3`).
   */
  slot?: { of: string; index: number; max: number; label: string }
  /** eBay: the aspect may vary per variation. Informational; `scope` still decides locking. */
  variantEligible?: boolean
  /** Every declaring channel hides it in its own UI. Still a column. */
  hidden?: boolean
  /** AM.1 — each coordinate's own facts, by coordinate label. Absent on master-only columns. */
  channels?: Record<string, SheetColumnChannelFacts>
}

export interface SheetGroup {
  key: string
  label: string
  /** The channel's localised title where the group is a channel's (`Offerta`). */
  channelLabel: string | null
  order: number
}

/** AM.1 — what each channel spec contributed: the conformance witness the client can show. */
export interface SheetSpecCoverage {
  coordinate: string
  channel: SheetChannel
  category: string
  /** Top-level properties / aspects the channel declares. */
  declared: number
  /** Columns they became (slots expanded). */
  columns: number
  fetchedAt: string | null
  unrecognised: string[]
}

export interface SheetColumnSet {
  market: string
  locale: string
  coordinates: SheetCoordinate[]
  productTypes: string[]
  columns: SheetColumn[]
  /** The groups in display order, with the channel's own title where there is one. */
  groups: SheetGroup[]
  /** Fields the registry offered that no coordinate reads — reported, never rendered. */
  droppedKeys: string[]
  /**
   * Product types with NO cached Amazon schema at all, so their columns carry no caps and no closed
   * enums. Named rather than hidden: a counter with no cap must not look like a cap of none.
   */
  schemaMissing: string[]
  /** When each type's cap data was fetched — the sheet says "caps as of …" rather than implying now. */
  schemaAge: Array<{ productType: string; fetchedAt: string }>
  /** AM.1 — per channel spec: declared vs served, so "every attribute the channel supports" is checkable. */
  coverage: SheetSpecCoverage[]
  /**
   * The markets that actually carry listings, for the sheet's market switcher. Derived from the
   * presence query this service already runs, so the client needs no second round trip and cannot
   * offer a market with nothing in it.
   */
  availableMarkets: string[]
}

export interface BuildSheetColumnsInput {
  /** A configured family owns Master. Marketplace schemas remain channel-only. */
  familySchema?: boolean
  /** The master registry fields (universal / content / pricing / inventory / identifiers / physical + hardcoded fallbacks). */
  fields: FieldDefinition[]
  /** One channel spec per (coordinate × category) — the SOURCE of channel columns. */
  specs?: Array<{ coordinate: SheetCoordinate; spec: ChannelSpec }>
  /**
   * normalised key → English label. D10: operator UI chrome is English, and the channel specs are
   * derived from the MARKET's schema, so their own labels are German/Italian/etc.
   */
  englishLabels?: Map<string, string>
  coordinates: SheetCoordinate[]
  /** The variation axes these families actually vary by (`Product.variationAxes`), e.g. Color, Size. */
  variationAxes?: string[]
  /**
   * `master` (default): only columns with a MASTER store — the shared record's own fields plus the
   * channel attributes that live in its bag. `channel`: everything the channel declares, including
   * fields that exist only on the listing (eBay's condition, Amazon's variation theme).
   */
  scopeKind?: 'master' | 'channel'
}

// ────────────────────────────────────────────────────────────────────
// Grouping + shape
// ────────────────────────────────────────────────────────────────────

const MASTER_GROUPS = {
  identity: { key: 'master:identity', label: 'Identity' },
  classification: { key: 'master:classification', label: 'Classification' },
  content: { key: 'master:content', label: 'Content' },
  identifiers: { key: 'master:identifiers', label: 'Identifiers' },
  pricing: { key: 'master:pricing', label: 'Pricing' },
  inventory: { key: 'master:inventory', label: 'Inventory' },
  physical: { key: 'master:physical', label: 'Dimensions and weight' },
  compliance: { key: 'master:compliance', label: 'Compliance and traceability' },
  attributes: { key: 'master:attributes', label: 'Specifications' },
}

/** Field-registry category → canonical group. IDs never depend on display labels. */
const GROUP_BY_CATEGORY: Record<string, { key: string; label: string }> = {
  universal: MASTER_GROUPS.identity,
  content: MASTER_GROUPS.content,
  category: MASTER_GROUPS.attributes,
  identifiers: MASTER_GROUPS.identifiers,
  pricing: MASTER_GROUPS.pricing,
  inventory: MASTER_GROUPS.inventory,
  physical: MASTER_GROUPS.physical,
}

/** Master keys whose registry category says Identity but whose meaning is Content. */
const GROUP_OVERRIDES: Record<string, { key: string; label: string }> = {
  description: MASTER_GROUPS.content,
  productType: MASTER_GROUPS.classification,
}

/** Presentation order is a workflow, independent of the order in a downloaded schema. */
export const SHEET_GROUP_ORDER = Object.values(MASTER_GROUPS).map((g) => g.label)
const GROUP_WORKFLOW_ORDER = [
  'master:identity', 'master:classification', 'AMAZON:classification', 'EBAY:classification', 'AMAZON:product_identity',
  'master:content', 'EBAY:content',
  'AMAZON:product_details', 'EBAY:aspects', 'master:attributes',
  'AMAZON:variations', 'EBAY:variations', 'master:identifiers', 'master:physical',
  'AMAZON:images', 'EBAY:images', 'AMAZON:safety_and_compliance', 'master:compliance',
  'master:pricing', 'AMAZON:offer', 'EBAY:offer', 'master:inventory',
  'AMAZON:shipping', 'EBAY:shipping', 'EBAY:policies', 'EBAY:listing',
]
const CONTENT_FIELD_ORDER = ['name', 'title', 'description', 'bulletPoints', 'keywords']
const FIELD_ORDER_BY_GROUP: Record<string, string[]> = {
  'master:identity': ['name', 'brand', 'manufacturer', 'sku', 'status'],
  'master:attributes': ['model_number', 'material', 'fabric_type', 'color', 'size', 'target_gender', 'age_range_description', 'fit_type', 'care_instructions', 'water_resistance_level'],
  'master:identifiers': ['gtin', 'ean', 'upc'],
  'master:physical': ['weightValue', 'weightUnit', 'dimLength', 'dimWidth', 'dimHeight', 'dimUnit'],
  'master:compliance': ['countryOfOrigin', 'hsCode', 'ppeCategory', 'garmentClass', 'glove_standard', 'glove_protection_level', 'knuckle_impact_protection', 'impactProtectors', 'notifiedBodyName', 'notifiedBodyNumber', 'declarationOfConformityUrl', 'hazmatClass', 'hazmatUnNumber'],
  'master:pricing': ['costPrice', 'basePrice', 'minPrice', 'maxPrice', 'minMargin'],
  'master:inventory': ['totalStock', 'lowStockThreshold'],
  'AMAZON:product_identity': ['externally_assigned_product_identifier', 'supplier_declared_has_product_identifier_exemption', 'merchant_suggested_asin', 'brand', 'manufacturer', 'model_name', 'model_number', 'part_number', 'recommended_browse_nodes'],
  'AMAZON:product_details': [...CONTENT_FIELD_ORDER, 'brand', 'manufacturer', 'material', 'fabric_type', 'color', 'size', 'target_gender', 'age_range_description', 'fit_type', 'care_instructions', 'water_resistance_level'],
  'EBAY:content': ['name', 'title', 'subtitle', 'description', 'descriptionThemeId'],
  'EBAY:aspects': ['brand', 'type', 'model', 'material', 'color', 'size', 'department'],
  'EBAY:offer': ['conditionId', 'price', 'quantity', 'listingFormat', 'listingDuration', 'vatRate', 'bestOffer', 'bestOfferFloor', 'bestOfferCeiling'],
  'EBAY:shipping': ['handlingTime', 'packageType', 'packageWeight', 'packageLength', 'packageWidth', 'packageHeight', 'dimensionUnit'],
  'EBAY:policies': ['fulfillmentPolicyId', 'returnPolicyId', 'paymentPolicyId'],
}

/** Groups a sheet's Essentials preset opens with; everything else is one Customise click away. */
const DEFAULT_VISIBLE_GROUPS = new Set(['Identity', 'Content', 'Identifiers', 'Pricing'])

/** Master keys that live in `localizedContent[locale]` rather than a column or the attribute bag. */
const LOCALIZED_KEYS = new Set(['name', 'title', 'description', 'bulletPoints', 'keywords'])

/**
 * Master fields whose store is an ARRAY (`Product.bulletPoints String[]`, `Product.keywords
 * String[]`, and the same keys inside `localizedContent`). Their shape is the master's, whatever a
 * channel's cardinality says: Amazon takes ONE `generic_keyword` string of 500 chars while the master
 * holds keyword tags — the outbound writer joins; the column stays a list.
 */
const MASTER_LIST_FIELDS: Record<string, Cardinality> = {
  // Ten is Amazon's own bullet maximum (10 × 700 on all 49 cached schemas, 2026-09-04); no other
  // channel declares bullets, so the master list is bounded by the one channel that reads it.
  bulletPoints: { min: 1, max: 10 },
  keywords: { min: 1, max: null },
}

/** Identifiers that are inherently per-variation, whatever the schema says about parentage. */
const PER_VARIANT_KEYS = new Set(['sku', 'gtin', 'ean', 'upc', 'asin', 'barcode'])

function kindFor(field: FieldDefinition): SheetColumnKind {
  if (field.longText) return 'longtext'
  if (field.type === 'boolean') return 'boolean'
  if (field.type === 'number') return 'number'
  if (field.type === 'date') return 'date'
  if (field.type === 'select') return 'select'
  const key = field.id.replace(/^attr_/, '')
  if (isProseKey(key)) return 'longtext'
  return 'text'
}

function storageFor(field: FieldDefinition): SheetStorage {
  if (field.localizable) return 'localizedContent'
  if (field.id.startsWith('attr_')) return 'categoryAttributes'
  if (LOCALIZED_KEYS.has(field.id)) return 'localizedContent'
  return 'column'
}

/**
 * A column is per-variation when it is an identifier that cannot be shared, or when the family
 * varies BY it. The axes are stored as the operator's LABELS, not schema keys — the real IT
 * catalogue carries `variationAxes: ["Colore","Taglia"]` while the attributes are `color` and
 * `size` — so an axis is matched against the key AND every channel's localised label; matching only
 * the key silently marked every variation axis `global` and offered a parent row a size for the
 * whole family.
 */
function scopeFor(key: string, labels: Array<string | undefined>, variationAxes: Set<string>): 'global' | 'per_variant' {
  const norm = normaliseKey(key)
  if (PER_VARIANT_KEYS.has(key) || PER_VARIANT_KEYS.has(norm)) return 'per_variant'
  if (variationAxes.has(canonicalVariantAxis(key))) return 'per_variant'
  for (const l of labels) {
    if (l && variationAxes.has(canonicalVariantAxis(l))) return 'per_variant'
  }
  return 'global'
}

function defaultWidth(kind: SheetColumnKind, shape: FieldShape): number {
  if (shape === 'measure') return 120
  if (shape === 'list') return 160
  switch (kind) {
    case 'number': return 100
    case 'select': return 130
    case 'boolean': return 90
    case 'date': return 120
    case 'longtext': return 110
    default: return 160
  }
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

function tighterOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

/** `fulfillment_availability` + `quantity` → "Fulfillment availability · Quantity". */
export function englishLeafLabel(f: ChannelFieldSpec, englishLabels?: Map<string, string>): string {
  if (f.englishLabel) return f.englishLabel
  const exact = englishLabels?.get(normaliseKey(f.key))
  if (exact) return exact
  if (f.path.length > 0 && f.key !== f.attribute) {
    const parent = englishLabels?.get(normaliseKey(f.attribute)) ?? humanizeKey(f.attribute)
    return `${parent} · ${humanizeKey(f.path[f.path.length - 1])}`
  }
  return humanizeKey(f.key)
}

// ────────────────────────────────────────────────────────────────────
// The pure merge
// ────────────────────────────────────────────────────────────────────

interface Draft {
  managedBy?: 'productMedia'
  shopifyField?: import('@nexus/shared/shopify-information').InformationField
  formulaWritable?: boolean
  familyRules?: FieldDefinition['familyRules']
  validation?: Record<string, unknown>
  declaredScope?: 'global' | 'per_variant'
  key: string
  writeField: string
  label: string
  group: string
  groupKey: string
  kind: SheetColumnKind
  storage: SheetStorage
  options?: string[]
  optionLabels?: Record<string, string>
  /** `true` while every contributor with options closes the list. */
  allStrict: boolean
  hasOptions: boolean
  requiredBy: string[]
  requiredForProductTypes: string[]
  /** Amazon categories that define it; `anyType` once a non-typed channel (eBay) contributes. */
  applicableProductTypes: string[]
  anyType: boolean
  cap: { maxLength?: number; capFrom?: string }
  maxBytes?: number
  channelLabel?: string
  editable: boolean
  width?: number
  helpText?: string
  deprecatedOptions: string[]
  shape: FieldShape
  cardinality: Cardinality
  unitOptions?: string[]
  variantEligible: boolean
  hidden: boolean | null
  channels: Record<string, SheetColumnChannelFacts>
  /** Came from the master registry (its shape and kind win). */
  isMaster: boolean
  contributors: number
}

export function buildSheetColumns(input: BuildSheetColumnsInput): { columns: SheetColumn[]; droppedKeys: string[]; groups: SheetGroup[] } {
  const { fields, specs = [], coordinates, variationAxes = [], englishLabels, scopeKind = 'master' } = input
  const axes = new Set(variationAxes.map(canonicalVariantAxis).filter(Boolean))
  const coordinateLabels = new Set(coordinates.map((c) => c.label))

  const drafts = new Map<string, Draft>()
  const normIndex = new Map<string, string>()
  const channelGroups: SheetGroup[] = []
  const seenGroup = new Set<string>()

  // ── 1. the master's own fields ────────────────────────────────────
  for (const field of fields) {
    // The static `amazon_*` / `ebay_*` registry lists are superseded by the channel specs: three of
    // them were dead placeholders ("no backing column yet") and the live ones duplicated a linked
    // master column (`amazon_title` beside `name` and `item_name`, three columns for one cell).
    if (field.category === 'amazon' || field.category === 'ebay') continue
    const storage = storageFor(field)
    const key = field.id.replace(/^attr_/, '')
    const norm = normaliseKey(key)
    if (normIndex.has(norm)) continue
    const listCard = input.familySchema && key === 'bulletPoints' ? { min: 0, max: null } : MASTER_LIST_FIELDS[key]
    const group = field.group ?? GROUP_OVERRIDES[key] ?? GROUP_BY_CATEGORY[field.category] ?? MASTER_GROUPS.attributes
    const d: Draft = {
      key,
      writeField: field.id,
      label: key === 'productType' ? 'Amazon product type (default)' : field.label,
      group: group.label,
      groupKey: group.key,
      kind: kindFor(field),
      storage,
      options: field.options && field.options.length > 0 ? field.options : undefined,
      optionLabels: field.optionLabels,
      declaredScope: field.scope,
      familyRules: field.familyRules,
      validation: field.validation,
      allStrict: field.type === 'select' && !!field.options?.length,
      hasOptions: !!(field.options && field.options.length > 0),
      requiredBy: input.familySchema && field.required ? ['Master'] : [],
      requiredForProductTypes: [],
      applicableProductTypes: [...(field.productTypes ?? [])],
      anyType: !field.productTypes?.length,
      cap: { maxLength: field.maxLength },
      editable: field.editable !== false,
      width: field.width,
      helpText: field.helpText,
      deprecatedOptions: [],
      unitOptions: field.unitOptions,
      shape: field.shape ?? (listCard ? 'list' : 'scalar'),
      cardinality: field.cardinality ?? listCard ?? { min: 1, max: 1 },
      variantEligible: false,
      hidden: null,
      channels: {},
      isMaster: true,
      contributors: 0,
    }
    drafts.set(key, d)
    normIndex.set(norm, key)
  }

  // ── 2. the channel specs — the SOURCE of channel columns ──────────
  for (const { coordinate, spec } of specs) {
    if (scopeKind === 'master' && input.familySchema) continue
    if (!coordinateLabels.has(coordinate.label)) continue
    for (const g of spec.groups) {
      const gk = `${spec.channel}:${g.key}`
      if (seenGroup.has(gk)) continue
      seenGroup.add(gk)
      channelGroups.push({ key: gk, label: g.label, channelLabel: g.channelLabel, order: g.order })
    }
    for (const f of spec.fields) {
      const listingOnly = !!f.channelStore && !f.masterKey
      if (scopeKind === 'master' && listingOnly) continue

      let key: string
      if (f.masterKey) key = f.masterKey
      else key = f.shopifyField?.definition ? f.key : normIndex.get(normaliseKey(f.key)) ?? f.key

      let d = drafts.get(key)
      if (!d) {
        d = {
          key,
          writeField: `attr_${key}`,
          label: englishLeafLabel(f, englishLabels),
          group: f.group ? f.group.label : channelDisplayName(coordinate.channel),
          groupKey: f.group ? `${spec.channel}:${f.group.key}` : spec.channel,
          kind: f.kind,
          storage: listingOnly ? 'listing' : 'categoryAttributes',
          options: undefined,
          allStrict: true,
          hasOptions: false,
          requiredBy: [],
          requiredForProductTypes: [],
          applicableProductTypes: [],
          anyType: false,
          cap: {},
          // Every listing store has a write route: a listing COLUMN through its prefixed field
          // (`amazon_variationTheme`), a `platformAttributes` PATH through the bulk PATCH's
          // `attr_<key>` + `target: 'channel'`, which reads the store from this very contract.
          editable: true,
          width: undefined,
          helpText: f.helpText,
          deprecatedOptions: [],
          shape: f.shape,
          cardinality: { ...f.cardinality },
          unitOptions: f.unitOptions,
          variantEligible: false,
          hidden: null,
          channels: {},
          isMaster: false,
          contributors: 0,
        }
        if (!listingOnly && f.masterKey) {
          // A linked master field the caller did not pass (the content trio when a caller builds
          // without `SHEET_CONTENT_FIELDS`): give it the master's store rather than the bag.
          d.storage = LOCALIZED_KEYS.has(key) ? 'localizedContent' : 'column'
          d.writeField = key
          d.isMaster = true
          const listCard = MASTER_LIST_FIELDS[key]
          d.shape = listCard ? 'list' : 'scalar'
          d.cardinality = listCard ?? { min: 1, max: 1 }
        }
        drafts.set(key, d)
        normIndex.set(normaliseKey(key), key)
      }
      mergeSpecField(d, f, coordinate, spec, englishLabels, scopeKind)
    }
  }

  // ── 3. scope owns the field set ──────────────────────────────────
  // Master attributes remain useful even when no marketplace declares them (armor/certification
  // are product facts). A channel shows only its declared fields, plus the SKU row identifier.
  // Otherwise eBay exposes Amazon bullets, ASINs, FBA and shared pricing controls as eBay fields.
  const droppedKeys: string[] = []
  for (const [key, d] of drafts) {
    if (scopeKind === 'channel' && d.contributors === 0 && key !== 'sku') {
      droppedKeys.push(key)
      drafts.delete(key)
    }
  }

  // ── 4. groups in display order ────────────────────────────────────
  const groups: SheetGroup[] = []
  for (const g of Object.values(MASTER_GROUPS)) {
    groups.push({ ...g, channelLabel: null, order: groups.length })
  }
  groups.push(...channelGroups)
  // Ungrouped channel fields (and a field's group omitted from spec.groups) still need an
  // addressable destination in the customiser. Preserve their existing trailing position.
  const knownGroups = new Set(groups.map((g) => g.key))
  for (const d of drafts.values()) {
    if (knownGroups.has(d.groupKey)) continue
    knownGroups.add(d.groupKey)
    groups.push({ key: d.groupKey, label: d.group, channelLabel: null, order: groups.length })
  }
  const usedGroups = new Set([...drafts.values()].map((d) => d.groupKey))
  const workflowRank = (key: string) => {
    const i = GROUP_WORKFLOW_ORDER.indexOf(key)
    return i < 0 ? GROUP_WORKFLOW_ORDER.length : i
  }
  groups.splice(0, groups.length, ...groups.filter((g) => usedGroups.has(g.key)).sort((a, b) =>
    workflowRank(a.key) - workflowRank(b.key) || a.order - b.order || a.key.localeCompare(b.key),
  ))
  groups.forEach((g, i) => { g.order = i })
  const groupOrder = groups.map((g) => g.key)
  const groupRank = (g: string) => {
    const i = groupOrder.indexOf(g)
    return i === -1 ? groupOrder.length : i
  }

  // ── 5. finalise: shapes → columns (slot expansion), scope, order ──
  const columns: SheetColumn[] = []
  for (const d of drafts.values()) {
    const labels = [d.channelLabel, ...Object.values(d.channels).map((c) => c.label)]
    const scope = axes.has(canonicalVariantAxis(d.key)) ? 'per_variant' : d.declaredScope ?? scopeFor(d.key, labels, axes)
    const options = d.hasOptions && d.options && d.options.length > 0 ? d.options : undefined
    const kind: SheetColumnKind = options && d.kind === 'text' ? 'select' : d.kind
    const base: SheetColumn = {
      key: d.key,
      ...(d.managedBy ? { managedBy: d.managedBy } : {}),
      ...(d.shopifyField ? { shopifyField: d.shopifyField, formulaWritable: false } : {}),
      ...(d.formulaWritable !== undefined ? { formulaWritable: d.formulaWritable } : {}),
      writeField: d.writeField,
      label: d.label,
      group: d.group,
      groupKey: d.groupKey,
      kind,
      storage: d.storage,
      scope,
      familyRules: d.familyRules,
      validation: d.validation,
      options,
      optionLabels: d.optionLabels,
      mode: options ? (d.allStrict ? 'strict' : 'open') : undefined,
      requiredBy: d.requiredBy,
      maxLength: d.cap.maxLength,
      maxBytes: d.maxBytes,
      // #415 — `capFrom` must name a coordinate whenever ANY cap is declared, not only when a
      // CHARACTER cap is. A byte cap has exactly one possible source here: the channel that set it.
      capFrom: d.cap.capFrom ?? (d.maxBytes !== undefined ? firstCoordinateWithBytes(d) : undefined),
      channelLabel: d.channelLabel,
      applicableProductTypes: !d.anyType && d.applicableProductTypes.length > 0 ? d.applicableProductTypes : undefined,
      requiredForProductTypes: !d.anyType && d.requiredForProductTypes.length > 0 ? d.requiredForProductTypes : undefined,
      editable: d.editable,
      width: d.width ?? defaultWidth(kind, d.shape),
      helpText: d.helpText,
      defaultVisible: d.requiredBy.length > 0 || DEFAULT_VISIBLE_GROUPS.has(d.group),
      deprecatedOptions: d.deprecatedOptions.length > 0 ? d.deprecatedOptions : undefined,
      shape: d.shape,
      ...(d.shape === 'list' ? { cardinality: d.cardinality } : {}),
      ...(d.shape === 'measure' ? { unitOptions: d.unitOptions } : {}),
      ...(d.variantEligible ? { variantEligible: true } : {}),
      ...(d.hidden === true ? { hidden: true } : {}),
      ...(Object.keys(d.channels).length > 0 ? { channels: d.channels } : {}),
    }

    if (d.shape === 'list' && d.cardinality.max !== null && d.cardinality.max <= 1) {
      // A list the channel caps at one item is a scalar for the sheet; the channel facts keep the truth.
      columns.push({ ...base, shape: 'scalar', cardinality: undefined })
      continue
    }
    if (d.shape === 'list' && d.cardinality.max !== null && d.cardinality.max <= SLOT_COLUMNS_MAX) {
      // Numbered slots: one cell per position, one array store behind them. Slot 1 carries the
      // list's requirement (Amazon needs ≥ 1 bullet, not 10 — flagging every empty slot would tell
      // the operator to write nine bullets they do not need).
      for (let i = 1; i <= d.cardinality.max; i++) {
        columns.push({
          ...base,
          key: slotKey(d.key, i),
          writeField: `${d.writeField}[${i}]`,
          label: d.key === 'bulletPoints' ? `Bullet ${i}` : `${d.label} ${i}`,
          requiredBy: i === 1 ? d.requiredBy : [],
          requiredForProductTypes: i === 1 ? base.requiredForProductTypes : undefined,
          defaultVisible: i === 1 ? base.defaultVisible : DEFAULT_VISIBLE_GROUPS.has(d.group),
          shape: 'scalar',
          cardinality: undefined,
          width: d.width ?? defaultWidth(kind, 'scalar'),
          slot: { of: d.key, index: i, max: d.cardinality.max, label: d.label },
        })
      }
      continue
    }
    columns.push(base)
  }

  // These are Amazon listing metadata, not the shared Product.parentId relationship. In particular,
  // a historical parentage_level may be inherited by a variant; never label it as the product role.
  for (const column of columns) {
    if (column.key === 'parentage_level') {
      column.label = scopeKind === 'master' ? 'Saved Amazon parentage level' : 'Amazon listing role'
      column.helpText = 'Stored Amazon parentage value. This does not define the shared product relationship. Product role and Parent SKU show the catalog relationship.'
    } else if (column.key === 'child_parent_sku_relationship__parent_sku') {
      column.label = 'Amazon parent SKU'
      column.helpText = 'Parent SKU used by this Amazon listing. The shared Parent SKU field defines the catalog relationship across listing aliases.'
    } else if (column.key === 'child_parent_sku_relationship__child_relationship_type') {
      column.label = 'Amazon relationship type'
      column.helpText = 'Relationship type submitted with the Amazon listing.'
    }
  }

  // Repeated schema titles describe distinct slots/paths. Keep every attribute and qualify its
  // label, so eight "Other Image URL" headers are eight recognisable image positions.
  const labelCounts = new Map<string, number>()
  for (const c of columns) labelCounts.set(c.label, (labelCounts.get(c.label) ?? 0) + 1)
  for (const c of columns) {
    if (c.key.startsWith('shopify_metafield:')) continue
    if ((labelCounts.get(c.label) ?? 0) < 2) continue
    const position = c.key.match(/_(\d+)$/)?.[1]
    c.label = position ? `${c.label} ${position}` : `${c.label} · ${humanizeKey(c.key)}`
  }

  columns.sort((a, b) => {
    const g = groupRank(a.groupKey!) - groupRank(b.groupKey!)
    if (g !== 0) return g
    // Required fields lead each group. Related controls then follow the workflow (measurements
    // with their units, condition with the offer); remaining schema fields sort alphabetically.
    // Slots retain their list's priority and stay together in index order.
    const ar = (a.slot ? a.slot.index === 1 ? a.requiredBy.length > 0 : sameListRequired(columns, a) : a.requiredBy.length > 0) ? 1 : 0
    const br = (b.slot ? b.slot.index === 1 ? b.requiredBy.length > 0 : sameListRequired(columns, b) : b.requiredBy.length > 0) ? 1 : 0
    if (ar !== br) return br - ar
    // Respect the family's configured order within its group; a mixed-family header uses
    // the earliest declared position deterministically. Applicability remains per row.
    const familyRank = (c: SheetColumn) => c.familyRules ? Math.min(...Object.values(c.familyRules).map(rule => rule.sortOrder)) : null
    const af = familyRank(a), bf = familyRank(b)
    if (af !== null && bf !== null && af !== bf) return af - bf
    const al = a.slot ? a.slot.label : a.label
    const bl = b.slot ? b.slot.label : b.label
    const contentRank = (c: SheetColumn) => {
      const order = FIELD_ORDER_BY_GROUP[c.groupKey ?? ''] ?? CONTENT_FIELD_ORDER
      const i = order.indexOf(c.slot?.of ?? c.key)
      return i < 0 ? order.length : i
    }
    const content = contentRank(a) - contentRank(b)
    if (content !== 0) return content
    const l = al.localeCompare(bl, 'en', { numeric: true })
    if (l !== 0) return l
    return (a.slot?.index ?? 0) - (b.slot?.index ?? 0)
  })

  return { columns, droppedKeys, groups }
}

function sameListRequired(columns: SheetColumn[], slot: SheetColumn): boolean {
  const first = columns.find((c) => c.slot && c.slot.of === slot.slot!.of && c.slot.index === 1)
  return !!first && first.requiredBy.length > 0
}

function firstCoordinateWithBytes(d: Draft): string | undefined {
  for (const [label, facts] of Object.entries(d.channels)) if (facts.maxBytes !== undefined) return label
  return undefined
}

function channelDisplayName(channel: string): string {
  return CHANNEL_LABEL[channel] ?? titleCase(channel)
}

/** Fold one channel field's facts into the column it belongs to. */
function mergeSpecField(
  d: Draft,
  f: ChannelFieldSpec,
  coordinate: SheetCoordinate,
  spec: ChannelSpec,
  englishLabels: Map<string, string> | undefined,
  scopeKind: 'master' | 'channel',
): void {
  d.contributors++
  if (scopeKind === 'channel' && f.validation) d.validation = f.validation
  const existing = d.channels[coordinate.label]
  const categoryFacts: SheetColumnChannelFacts = {
    key: f.key,
    attribute: f.attribute,
    path: f.path,
    label: f.label,
    requirement: f.requirement,
    cardinality: { ...f.cardinality },
    maxLength: f.maxLength,
    maxBytes: f.maxBytes,
    options: f.options,
    mode: f.mode,
    store: f.channelStore,
    selectors: f.selectors,
    hidden: f.hidden,
    editableOnExisting: f.editable,
    categories: [spec.category],
  }
  const facts: SheetColumnChannelFacts = existing ?? { ...categoryFacts, categories: [] }
  facts.byCategory = { ...facts.byCategory, [spec.category]: categoryFacts }
  if (existing) {
    // The same coordinate declaring the field for a second category (a family spanning two Amazon
    // product types): tightest caps, unioned options, the stricter requirement.
    facts.maxLength = tighterOf(facts.maxLength, f.maxLength)
    facts.maxBytes = tighterOf(facts.maxBytes, f.maxBytes)
    if (f.options) facts.options = [...new Set([...(facts.options ?? []), ...f.options])]
    if (f.mode === 'open' || facts.mode === 'open') facts.mode = facts.options ? 'open' : undefined
    if (f.requirement === 'required') facts.requirement = 'required'
    else if (f.requirement === 'requiredIfRelevant' && facts.requirement !== 'required') facts.requirement = 'requiredIfRelevant'
    else if (f.requirement === 'bestPractice' && facts.requirement === 'optional') facts.requirement = 'bestPractice'
    if (f.cardinality.max !== null) facts.cardinality.max = facts.cardinality.max === null ? f.cardinality.max : Math.min(facts.cardinality.max, f.cardinality.max)
  }
  if (!facts.categories.includes(spec.category)) facts.categories.push(spec.category)
  d.channels[coordinate.label] = facts

  // A channel's Brand/Manufacturer is an override of a shared product fact. Keeping the master's
  // `column` storage here made eBay display itemSpecifics.Marca but write Product.brand instead.
  if (scopeKind === 'channel' && d.storage === 'column' && f.channelStore?.kind !== 'listingColumn') {
    d.storage = f.channelStore ? 'listing' : 'categoryAttributes'
    d.writeField = `attr_${d.key}`
  }

  // Shopify uses the shared display registry while retaining its original name in field help.
  if (scopeKind === 'channel' && f.shopifyField) {
    d.shopifyField = f.shopifyField
    d.editable = f.editable && !f.readOnlyReason
    d.formulaWritable = false
    d.label = f.label
    d.helpText = [f.helpText, f.readOnlyReason && !f.helpText?.includes(f.readOnlyReason) ? f.readOnlyReason : ''].filter(Boolean).join(' ') || undefined
    if (f.readOnlyReason) d.editable = false
  }
  if (scopeKind === 'channel' && f.masterKey === 'name' && !f.shopifyField) d.label = 'Title'
  if (scopeKind === 'channel' && f.readOnlyReason) {
    d.editable = false
    d.formulaWritable = false
    d.helpText = f.helpText ?? f.readOnlyReason
  }
  if (scopeKind === 'channel' && f.managedBy) d.managedBy = f.managedBy
  if (scopeKind === 'channel' && f.key === 'productType') d.label = 'Product type'
  if (scopeKind === 'channel' && f.group && d.isMaster) {
    d.group = f.group.label
    d.groupKey = `${spec.channel}:${f.group.key}`
  }

  if (f.requirement === 'required') {
    if (!d.requiredBy.includes(coordinate.label)) d.requiredBy.push(coordinate.label)
    if (spec.category !== '*' && !d.requiredForProductTypes.includes(spec.category)) d.requiredForProductTypes.push(spec.category)
  }
  if (spec.category !== '*' && (spec.channel === 'AMAZON' || scopeKind === 'channel')) {
    if (!d.applicableProductTypes.includes(spec.category)) d.applicableProductTypes.push(spec.category)
    if (scopeKind === 'channel') d.anyType = false
  } else {
    d.anyType = true
  }

  // A channel field with its OWN per-listing store (Amazon's `title` column for item_name, eBay's
  // `title` for its title) caps the LISTING's value, not the master's: the listing may carry its own
  // title and usually does (every GALE eBay listing holds a 76-char title beside a 127-char master
  // name). On the MASTER scope such caps stay per coordinate (`channels[coord].maxLength`) and do
  // not tighten the column — otherwise every master Name cell tints "over eBay's 80" for a value eBay
  // never receives. On the CHANNEL scope the column IS the listing's value, so the cap applies.
  const capsTheMaster = scopeKind === 'channel' || f.channelStore?.kind !== 'listingColumn'
  if (capsTheMaster) {
    d.cap = tightest(d.cap, f.maxLength, coordinate.label)
    d.maxBytes = tighterOf(d.maxBytes, f.maxBytes)
  }

  if (f.options && f.options.length > 0) {
    d.options = [...new Set([...(d.options ?? []), ...f.options])]
    d.hasOptions = true
    if (f.mode !== 'strict') d.allStrict = false
    if (f.optionLabels) d.optionLabels = { ...(d.optionLabels ?? {}), ...f.optionLabels }
  }
  if (f.deprecatedOptions) d.deprecatedOptions = [...new Set([...d.deprecatedOptions, ...f.deprecatedOptions])]

  if (!d.channelLabel && f.label && f.label !== d.label) d.channelLabel = f.label
  if (!d.helpText && f.helpText) d.helpText = f.helpText
  d.variantEligible = d.variantEligible || f.variantEligible
  d.hidden = d.hidden === null ? f.hidden : d.hidden && f.hidden

  if (!d.isMaster || scopeKind === 'channel') {
    // The master's shape wins where a master field exists; otherwise the channels decide.
    if (f.shape === 'measure') { d.shape = 'measure'; d.unitOptions = d.unitOptions ?? f.unitOptions }
    else if (f.shape === 'list' && d.shape !== 'measure') d.shape = 'list'
    if (scopeKind === 'channel' && d.contributors === 1) {
      d.shape = f.shape
      d.cardinality = { ...f.cardinality }
    } else if (d.shape === 'list') {
      d.cardinality.max = d.cardinality.max === null || f.cardinality.max === null ? null : Math.max(d.cardinality.max, f.cardinality.max)
    }
    if (d.kind === 'text' && f.kind !== 'text') d.kind = f.kind
    if (d.label === humanizeKey(d.key)) {
      const better = englishLeafLabel(f, englishLabels)
      if (better !== d.label) d.label = better
    }
  }
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
  /**
   * TRUE narrowing: keep ONLY these channels.
   *
   * Distinct from `channels`, which force-INCLUDES past `present` and never excludes anything — a
   * distinction that cost real correctness (byte-identical column sets across scopes, every eBay cap
   * labelled Amazon's). Added rather than changing `channels`, whose force-include semantics MS.1 and
   * MS.2 depend on.
   */
  only?: string[]
}

export function coordinatesFor(
  market: string,
  marketplaces: Array<{ channel: string; code: string; name?: string | null; isActive?: boolean; languages?: string[]; language?: string }>,
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
    if (options.only && !options.only.map((c) => c.toUpperCase()).includes(ch)) continue
    const forced = (options.channels ?? []).map((c) => c.toUpperCase()).includes(ch)
    if (options.present && !forced && !options.present.has(`${ch}:${mp}`)) continue
    const name = CHANNEL_LABEL[ch] ?? titleCase(ch)
    out.push({
      channel: ch,
      marketplace: mp,
      ...(m.languages || m.language ? { languages: marketLanguages(ch, mp, [{ ...m, languages: m.languages ?? [] }]) } : {}),
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

/**
 * A market the platform does not have. Thrown rather than returning an empty sheet: a typo'd or
 * stale `?market=` used to come back HTTP 200 with zero coordinates and a full set of rows, so a
 * broken link rendered as a real market that simply had no channels — the operator's only clue was
 * an absence, which is exactly the failure mode this sheet exists to remove.
 */
export class UnknownMarketError extends Error {
  readonly code = 'unknown_market'
  constructor(readonly market: string, readonly known: string[]) {
    super(`Unknown market "${market}". This platform has: ${known.join(', ')}`)
    this.name = 'UnknownMarketError'
  }
}

export interface GetSheetColumnsInput {
  accountId?: string | null
  locale?: string

  familyIds?: string[]
  savedFields?: FieldDefinition[]
  market: string
  productTypes: string[]
  /** The variation axes present in the rows being shown. */
  variationAxes?: string[]
  /** Force these channels into the coordinate list before their first listing exists. */
  channels?: string[]
  /** TRUE narrowing — keep ONLY these channels. See CoordinatesForOptions.only. */
  onlyChannels?: string[]
  /** Skip the presence check and report every active channel in the market. */
  includeEmptyChannels?: boolean
  /**
   * AM.1 — the eBay leaf categories the family's listings use (`platformAttributes.categoryId`),
   * so the eBay coordinate's spec is THOSE categories' aspects. Without any, the marketplace-wide
   * aspect rows stand in.
   */
  ebayCategoryIds?: string[]
  etsyCategoryIds?: string[]
  /** `channel` includes fields that live only on the listing; default derives from `onlyChannels`. */
  scopeKind?: 'master' | 'channel'
}

/**
 * The master's content fields the sheet serves whether or not the registry lists them: the
 * `Product.bulletPoints` / `Product.keywords` String[] columns (and the same keys per locale). They
 * are what Amazon's `bullet_point` and `generic_keyword` LINK to — one concept, one column.
 */
export const SHEET_CONTENT_FIELDS: FieldDefinition[] = [
  { id: 'bulletPoints', label: 'Bullet points', type: 'text', category: 'content', editable: true, width: 110, helpText: 'Shared feature bullets. Each channel category defines its accepted count and length.' },
  { id: 'keywords', label: 'Search keywords', type: 'text', category: 'content', editable: true, width: 160, helpText: 'Shared search terms. Channel mappings determine how these are sent; limits depend on the marketplace and product type.' },
]

/**
 * Column sets are derived from cached schemas plus a rarely-changing aspect table, and both the
 * columns route AND every row read need one. Caching here rather than in the route means a page of
 * rows does not pay the schema walk on every keystroke of a search.
 */
const columnSetCache = new WorkspaceCache<string, { at: number; value: SheetColumnSet }>()
const COLUMN_SET_TTL_MS = 5 * 60_000
const englishLabelCache = new WorkspaceCache<string, { at: number; value: Map<string, string> }>()

export async function getSheetColumns(input: GetSheetColumnsInput): Promise<SheetColumnSet> {
  const market = String(input.market).toUpperCase()
  const productTypes = [...new Set((input.productTypes ?? []).map((t) => String(t).toUpperCase()).filter(Boolean))]
  const axes = [...new Set((input.variationAxes ?? []).map((a) => String(a)))].sort()
  const ebayCategoryIds = [...new Set((input.ebayCategoryIds ?? []).map(String).filter(Boolean))].sort()
  const etsyCategoryIds = [...new Set((input.etsyCategoryIds ?? []).map(String).filter(Boolean))].sort()
  const scopeKind: 'master' | 'channel' = input.scopeKind ?? ((input.onlyChannels?.length ?? 0) === 1 ? 'channel' : 'master')

  // ⚠ EVERY input that changes the RESULT must be in this key.
  const cacheKey = JSON.stringify([
    market,
    productTypes.slice().sort(),
    axes,
    (input.channels ?? []).slice().sort(),
    (input.onlyChannels ?? []).slice().sort(),
    !!input.includeEmptyChannels,
    ebayCategoryIds,
    etsyCategoryIds,
    scopeKind,
    (input.familyIds ?? []).slice().sort(),
    input.savedFields ?? [],
    input.accountId ?? null,
    input.locale ?? null,
  ])
  const cached = columnSetCache.get(cacheKey)
  if (!input.accountId && cached && Date.now() - cached.at < COLUMN_SET_TTL_MS) return cached.value

  const { default: prisma } = await import('../../db.js')
  const { getAvailableFields } = await import('./field-registry.service.js')
  const { loadAmazonSpec, loadAmazonEnglishLabels, loadEbaySpec } = await import('./channel-specs/index.js')
  const { etsyProductSpec } = await import('./channel-specs/store.js')

  const [marketplaceRows, presentRows] = await Promise.all([
    prisma.marketplace.findMany({
      where: { isActive: true },
      select: { channel: true, code: true, name: true, isActive: true, language: true, languages: true },
    }),
    input.includeEmptyChannels
      ? Promise.resolve([] as Array<{ channel: string; marketplace: string }>)
      : prisma.channelListing.groupBy({ by: ['channel', 'marketplace'], _count: { _all: true } }),
  ])
  const present = input.includeEmptyChannels
    ? undefined
    : new Set(presentRows.map((r) => `${String(r.channel).toUpperCase()}:${String(r.marketplace).toUpperCase()}`))
  const availableMarkets = [...new Set(presentRows.map((r) => String(r.marketplace).toUpperCase()).filter((m) => m && m !== 'DEFAULT'))].sort()
  const knownMarkets = [...new Set(marketplaceRows.map((m) => String(m.code).toUpperCase()).filter((c) => c && c !== 'DEFAULT'))].sort()
  if (!knownMarkets.includes(market)) throw new UnknownMarketError(market, knownMarkets)

  const coordinates = coordinatesFor(market, marketplaceRows, { present, channels: input.channels, only: input.onlyChannels })
  const languageCoordinate = coordinates[0]
  const locale = input.locale ?? (languageCoordinate ? marketLanguages(languageCoordinate.channel, languageCoordinate.marketplace, marketplaceRows)[0] : PRIMARY_CONTENT_LOCALE)
  if (scopeKind === 'channel') for (const coordinate of coordinates) assertInformationLocale(coordinate.channel, input.locale, marketLanguages(coordinate.channel, coordinate.marketplace, marketplaceRows))
  else assertInformationLocale(undefined, input.locale)

  const channels = [...new Set(coordinates.map((c) => c.channel))]
  // NOTE the missing `marketplace`: passing it makes `getAvailableFields` do its own dynamic schema
  // lookup. The channel fields come from the specs below — derived once, here.
  const familySchema = scopeKind === 'master' && input.familyIds !== undefined
  const registry = (await getAvailableFields({ productTypes: familySchema ? [] : productTypes, channels })).filter(f =>
    !familySchema || !['amazonAsin', 'parentAsin', 'ebayItemId', 'buyBoxPrice', 'competitorPrice', 'shippingTemplate', 'fulfillmentChannel', 'productType'].includes(f.id),
  )
  const familyFields = familySchema ? await (await import('./family-sheet-schema.js')).familySheetFields(input.familyIds!, input.locale) : []
  const canonical = new Set([...registry, ...familyFields].map(f => f.id.replace(/^attr_/, '')))
  const saved = familySchema ? (input.savedFields ?? []).filter(f => !canonical.has(f.id.replace(/^attr_/, '')) && !(f.id === 'attr_country_of_origin' && canonical.has('countryOfOrigin'))) : []
  const fields = [...new Map([...registry, ...SHEET_CONTENT_FIELDS, ...saved, ...familyFields].map(f => [f.id, f])).values()]

  // ── the channel specs, CACHE ONLY (never a live channel call on a page-load path) ──
  const specs: Array<{ coordinate: SheetCoordinate; spec: ChannelSpec }> = []
  const schemaMissing: string[] = []
  if (familySchema && !input.familyIds?.length) schemaMissing.push('MASTER:product family not selected')
  const schemaAge: Array<{ productType: string; fetchedAt: string }> = []
  const coverage: SheetSpecCoverage[] = []
  const englishLabels = new Map<string, string>()
  for (const f of fields) {
    const k = normaliseKey(f.id.replace(/^attr_/, ''))
    if (f.label && !englishLabels.has(k)) englishLabels.set(k, f.label)
  }

  for (const coordinate of coordinates) {
    if (familySchema) continue
    if (coordinate.channel === 'AMAZON') {
      if (scopeKind === 'channel') {
        const { amazonClassificationSpec } = await import('./channel-specs/amazon.js')
        specs.push({ coordinate, spec: amazonClassificationSpec(market) })
        if (!productTypes.length) schemaMissing.push('AMAZON:category not selected')
      }
      // #467 — deterministic order: product types sorted, so the columns never move when a cache
      // refreshes or a family's types are listed in a different order.
      for (const pt of [...productTypes].sort()) {
        try {
          const spec = await loadAmazonSpec(market, pt, input.accountId)
          if (spec.absent) { schemaMissing.push(pt); continue }
          specs.push({ coordinate, spec })
          schemaAge.push({ productType: pt, fetchedAt: spec.fetchedAt ? spec.fetchedAt.toISOString() : '' })
          coverage.push({
            coordinate: coordinate.label, channel: 'AMAZON', category: pt,
            declared: Object.keys(spec.coverage).length, columns: 0,
            fetchedAt: spec.fetchedAt ? spec.fetchedAt.toISOString() : null, unrecognised: spec.unrecognised,
          })
          // D10 — Amazon's own English wording beats a humanised key. One walk per type, cached.
          let en = englishLabelCache.get(pt)
          if (!en || Date.now() - en.at > COLUMN_SET_TTL_MS) {
            en = { at: Date.now(), value: await loadAmazonEnglishLabels(pt) }
            englishLabelCache.set(pt, en)
          }
          for (const [k, v] of en.value) if (!englishLabels.has(k)) englishLabels.set(k, v)
        } catch (err) {
          console.error('[sheet-columns] cached Amazon schema unreadable:', pt, err instanceof Error ? err.message : err)
          schemaMissing.push(pt)
        }
      }
    } else if (coordinate.channel === 'SHOPIFY' || coordinate.channel === 'ETSY') {
      const spec = coordinate.channel === 'SHOPIFY' ? await (await import('./channel-specs/shopify.js')).loadShopifyProductSpec(input.accountId, input.locale) : etsyProductSpec(input.locale)
      specs.push({ coordinate, spec })
      coverage.push({ coordinate: coordinate.label, channel: coordinate.channel, category: '*',
        declared: Object.keys(spec.coverage).length, columns: 0, fetchedAt: null, unrecognised: spec.unrecognised })
      if (coordinate.channel === 'ETSY') {
        if (!etsyCategoryIds.length) schemaMissing.push('ETSY:*')
        for (const category of etsyCategoryIds) {
          try {
            const taxonomy = await (await import('./channel-specs/etsy-loader.js')).loadEtsyTaxonomySpec(category)
            if (taxonomy.absent) schemaMissing.push(`ETSY:${category}`)
            specs.push({ coordinate, spec: taxonomy })
            if (taxonomy.fetchedAt) schemaAge.push({ productType: `ETSY:${category}`, fetchedAt: taxonomy.fetchedAt.toISOString() })
            coverage.push({ coordinate: coordinate.label, channel: 'ETSY', category,
              declared: Object.keys(taxonomy.coverage).length, columns: 0, fetchedAt: taxonomy.fetchedAt?.toISOString() ?? null, unrecognised: taxonomy.unrecognised })
          } catch (error) {
            schemaMissing.push(`ETSY:${category}`)
            console.error('[sheet-columns] Etsy category unavailable:', category, error instanceof Error ? error.message : 'Invalid definition')
          }
        }
      }
    } else if (coordinate.channel === 'EBAY') {
      for (const category of ebayCategoryIds.length ? ebayCategoryIds : ['*']) {
        try {
          const spec = await loadEbaySpec(market, category === '*' ? [] : [category])
          specs.push({ coordinate, spec })
          if (spec.absent) schemaMissing.push(`EBAY:${category}`)
          if (spec.fetchedAt) schemaAge.push({ productType: `EBAY:${category}`, fetchedAt: spec.fetchedAt.toISOString() })
          coverage.push({
            coordinate: coordinate.label, channel: 'EBAY', category,
            declared: Object.keys(spec.coverage).length, columns: 0,
            fetchedAt: spec.fetchedAt?.toISOString() ?? null, unrecognised: spec.unrecognised,
          })
        } catch (err) {
          schemaMissing.push(`EBAY:${category}`)
          console.error('[sheet-columns] eBay category unavailable:', category, err)
        }
      }
    }
  }

  const { columns, droppedKeys, groups } = buildSheetColumns({ fields, specs, coordinates, variationAxes: input.variationAxes, englishLabels, scopeKind, familySchema })
  for (const cov of coverage) {
    cov.columns = columns.filter((c) => c.channels?.[cov.coordinate]?.categories.includes(cov.category)).length
  }
  const value: SheetColumnSet = { market, locale, coordinates, productTypes, columns, groups, droppedKeys, schemaMissing, schemaAge, coverage, availableMarkets }
  columnSetCache.set(cacheKey, { at: Date.now(), value })
  return value
}

/** Exported for tests and for a refresh path that wants to drop it explicitly. */
export function clearSheetColumnCache(): void {
  columnSetCache.clear()
  englishLabelCache.clear()
}
