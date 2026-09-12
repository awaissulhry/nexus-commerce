/**
 * AM.1 — the ONE shape every channel's schema is read into.
 *
 * `docs/2026-09-04-channel-attribute-model-design.md` §A.1. A channel adapter (`amazon.ts`,
 * `ebay.ts`, …) walks the channel's cached schema for one (marketplace × category) and returns a
 * `ChannelSpec`: every field the channel declares, in the SHAPE the channel gives it. The sheet's
 * column builder, readiness, the write router, import/export and the mapping catalogue all consume
 * this — never the raw schema — so a property the channel declares cannot fall out of one consumer
 * and stay in another.
 *
 * Conformance (Owner ruling 2026-09-05, "no resistance … the attributes provided by the channel
 * according to the category"): an adapter classifies EVERY top-level property of its source. There is
 * no exclusion path. A shape the walker does not recognise still becomes a column (text, editable)
 * and is listed in `unrecognised`, which the adapter's test asserts EMPTY — so an unknown shape is a
 * failing test, never a silently missing column.
 *
 * This module is a leaf: no prisma, no imports from the sheet. Pure and node-loadable.
 */

export type ChannelCode = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'

/**
 * `scalar`  — one value.
 * `list`    — an ordered array of values (`cardinality.max` 2+ or null = unbounded). The column
 *             builder turns a bounded list into numbered SLOT columns (`bulletPoints_1 …`) and an
 *             unbounded one into a single chip-list column.
 * `measure` — a value + unit pair (`item_weight` = { value: 1.2, unit: 'kilograms' }).
 * Compound attributes do not exist as a shape: they are flattened to one spec per scalar/list/
 * measure LEAF, keyed `parent__leaf` (`closure__type`, `battery__weight`) — the convention Amazon's
 * own flat-file manifest and the listing pull already use for these keys.
 */
export type FieldShape = 'scalar' | 'list' | 'measure'

export type LeafKind = 'text' | 'longtext' | 'number' | 'select' | 'boolean' | 'date'

/** Derived from the channel, never invented — see `reference_amazon_requirement_levels_derivation`. */
export type Requirement = 'required' | 'requiredIfRelevant' | 'bestPractice' | 'optional'

export interface Cardinality {
  /** The schema's minimum when the field is present at all. NOT a requirement signal. */
  min: number
  /** `null` = the channel declares no upper bound. */
  max: number | null
}

export interface ChannelGroup {
  key: string
  /** English (D10 — chrome is English). */
  label: string
  /** The channel's own title, in the marketplace language (`Offerta`, `Angebot`). */
  channelLabel: string | null
  order: number
}

/** Where the channel's OWN copy of a value lives when it is not the resolver's override bag. */
export type ChannelStore =
  | { kind: 'listingColumn'; column: string; followFlag?: string }
  | { kind: 'platformAttributes'; path: string[]; unitPath?: string[]; legacyPaths?: string[][] }

export interface ChannelFieldSpec {
  /** A dedicated shared workspace owns authoring; the API field remains in the catalogue. */
  managedBy?: 'productMedia'
  sourceOwner?: import('../mapping/source-definition-plan.js').SourceOwner
  /** Shopify keeps native and live definition identity through every mapping consumer. */
  shopifyField?: import('@nexus/shared/shopify-information').InformationField
  readOnlyReason?: string
  defaultRule?: import('../schema-mapping.service.js').FieldMappingRule

  validation?: Record<string, unknown>
  /**
   * The COLUMN key this field contributes on the sheet, before the master join:
   * the channel's attribute name (`bullet_point`), or `parent__leaf` for a compound leaf.
   * The builder replaces it with `masterKey` when one is declared (one concept, one column).
   */
  key: string
  /** The channel's top-level attribute this leaf belongs to (`closure` for `closure__type`). */
  attribute: string
  /** Sub-property path inside the attribute; empty for the attribute's own value leaf. */
  path: string[]
  /** The channel's label, in the marketplace language (`Punto elenco`). */
  label: string
  /** The channel's ENGLISH term when the adapter has one (eBay's `englishName`); the builder fills the rest. */
  englishLabel?: string
  shape: FieldShape
  kind: LeafKind
  cardinality: Cardinality
  /** measure only — the unit enum. */
  unitOptions?: string[]
  options?: string[]
  optionLabels?: Record<string, string>
  /** `strict` = the channel accepts only the list. */
  mode?: 'strict' | 'open'
  deprecatedOptions?: string[]
  maxLength?: number
  maxBytes?: number
  requirement: Requirement
  /** Required INSIDE its parent object (`items.required`) — a compound leaf fact. */
  requiredInParent: boolean
  /** Amazon's `editable: false` — cannot change on an EXISTING listing. Still authorable. */
  editable: boolean
  /** The channel marks it hidden in its own UI. Still a column; the client may de-emphasise. */
  hidden: boolean
  /** eBay: the aspect may vary per variation. Amazon: derived from `variation_theme` elsewhere. */
  variantEligible: boolean
  group: ChannelGroup | null
  helpText?: string
  /** One concept, one column: the master field this channel field IS (`item_name` → `name`). */
  masterKey?: string
  channelStore?: ChannelStore
  /** Facet selectors the outbound writer supplies (`marketplace_id`, `language_tag`, `currency`). */
  selectors?: string[]
}

export interface ChannelSpec {
  /** Internal schema for product-aware validation; never projected into field catalogue JSON. */
  validationSchema?: Record<string, unknown>
  channel: ChannelCode
  marketplace: string
  /** Amazon product type, or eBay category id. */
  category: string
  fields: ChannelFieldSpec[]
  groups: ChannelGroup[]
  fetchedAt: Date | null
  schemaVersion: string | null
  /**
   * Every top-level property of the source → the spec keys it produced. The conformance witness:
   * a property with zero keys is a defect the adapter's test fails on.
   */
  coverage: Record<string, string[]>
  /** Property paths whose shape the walker did not recognise (rendered as text, listed here). */
  unrecognised: string[]
  /** No cached schema for this coordinate — `fields` is empty and the caller must say so. */
  absent: boolean
}

// ────────────────────────────────────────────────────────────────────
// Shared rules (one copy — both adapters and the column builder read these)
// ────────────────────────────────────────────────────────────────────

/**
 * A cell that reads as PROSE gets the popup editor and a counter. Cap size is NOT the signal —
 * Amazon gives `color` a 1000-character cap and `product_tax_code` 949, and neither is prose. The
 * key is. (Measured on the real IT schema 2026-08-29: a cap-based rule made 12 one-word attributes
 * open a textarea.)
 */
const PROSE_KEYS = new Set([
  'title', 'name', 'item_name', 'description', 'product_description', 'keywords', 'generic_keyword',
  'search_terms', 'bulletPoints', 'bullet_point', 'care_instructions', 'special_feature',
  'fabric_type', 'legal_disclaimer_description', 'safety_warning', 'subtitle',
])

/** Prose by KEY (the attribute or master key, never a slot/leaf suffix), or by a `_description` tail. */
export function isProseKey(key: string): boolean {
  const base = key.replace(/^attr_/, '')
  if (PROSE_KEYS.has(base)) return true
  return /_description$/.test(base)
}

/**
 * Bounded lists become numbered slot columns up to this size; longer or unbounded lists become ONE
 * chip-list column. ONE constant, so every channel draws the line in the same place. Ten is where
 * Amazon's own bullet array stops (10 × 700 on every cached schema, measured 2026-09-04) and where
 * a row of numbered headers stops being readable.
 */
export const SLOT_COLUMNS_MAX = 10

/** `bulletPoints` + 3 → `bulletPoints_3`. The slot key convention (Amazon's own: `bullet_point_1`). */
export function slotKey(base: string, index: number): string {
  return `${base}_${index}`
}

/** `parent` + `leaf` → `parent__leaf` (the flat-file manifest's convention for compound leaves). */
export function leafKey(parent: string, leaf: string): string {
  return `${parent}__${leaf}`
}

/**
 * Normalised join key: Amazon `outer_material` and eBay `Outer Material` become the same token.
 * Diacritics are folded first (`Quantità` → `quantita`, `Età` → `eta`) — stripping them as
 * non-alphanumerics produced `quantit` and `et` as column keys (measured on the IT aspects).
 */
export function normaliseKey(raw: string): string {
  return String(raw)
    .replace(/^attr_/, '')
    .replace(/^aspect_/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Last-resort English label from a key: `fabric_type` → `Fabric type`. Sentence case, not Title Case. */
export function humanizeKey(key: string): string {
  const words = key.split(/[_\-\s]+/).filter(Boolean)
  if (words.length === 0) return key
  const first = words[0][0].toUpperCase() + words[0].slice(1)
  return [first, ...words.slice(1)].join(' ')
}
