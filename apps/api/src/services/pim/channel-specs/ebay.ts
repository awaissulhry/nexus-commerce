/**
 * AM.1 — the eBay adapter: the category's item ASPECTS plus the listing-level fields every eBay
 * listing carries, read into the one `ChannelSpec` shape.
 *
 * Measured 2026-09-04 (category 177104, IT): the cached category schema declares 20 aspects (1
 * required, 3 variant-eligible, 4 multi-value) and every listing holds 23 Italian-keyed item
 * specifics plus listingFormat / listingDuration / conditionId / bestOffer / handlingTime / package
 * weight and dimensions — and the sheet's eBay scope showed NONE of it (0 aspect columns; two dead
 * `ebay_format` / `ebay_duration` placeholders). `docs/2026-09-04-channel-attribute-model-design.md` §1.2.
 *
 * Two caches hold half the facts each, so the adapter takes both (Phase 4 unifies them):
 *   - `CategorySchema` (channel EBAY, productType = category id): `{ aspects: [{ id, label,
 *     localizedName?, englishName?, kind, options, enumMode, required, variantEligible }], conditions }`.
 *     Older rows carry the English name only inside the label, as `Marca (Brand)`.
 *   - `ChannelSchema` (channel EBAY, marketplace): `aspect_<English>` rows whose `notes` carry
 *     `multi-value` and `eBay: <localised>`, and `maxLength`.
 *
 * Aspect values live on the listing at `platformAttributes.itemSpecifics[<localised name>]`; the
 * listing-level fields at `platformAttributes.<key>` (measured on 247 of 252 IT listings). Pure; no prisma.
 */
import {
  humanizeKey, isProseKey, normaliseKey,
  type ChannelFieldSpec, type ChannelGroup, type ChannelSpec,
} from './types.js'
import { toInventoryCondition } from '../../ebay-condition.js'
import { englishEbayAspectLabel } from '../../ebay-aspect-names.js'

export interface EbayCachedAspect {
  id: string
  label: string
  localizedName?: string | null
  englishName?: string | null
  kind?: string
  options?: string[]
  enumMode?: 'open' | 'strict' | null
  required?: boolean
  recommended?: boolean
  guidance?: string
  variantEligible?: boolean
  /** Present once the cache writer persists it; until then the ChannelSchema notes carry it. */
  cardinality?: 'SINGLE' | 'MULTI' | string
  maxLength?: number | null
  dataType?: string
}

export interface EbayCachedCondition { value: string; label: string }

/** A `ChannelSchema` row for channel EBAY — the second half of the facts. */
export interface EbayChannelSchemaRow {
  fieldKey: string
  label: string
  maxLength: number | null
  required: boolean
  allowedValues: unknown
  notes: string | null
}

export interface EbaySpecInput {
  marketplace: string
  categoryId: string
  aspects: EbayCachedAspect[]
  conditions?: EbayCachedCondition[]
  channelSchemaRows?: EbayChannelSchemaRow[]
  fetchedAt?: Date | null
}

const LISTING_GROUP: ChannelGroup = { key: 'listing', label: 'Listing', channelLabel: null, order: 0 }
const ASPECTS_GROUP: ChannelGroup = { key: 'aspects', label: 'Item specifics', channelLabel: 'Specifiche dell\'oggetto', order: 1 }
const LISTING_GROUPS: Record<string, ChannelGroup> = Object.fromEntries([
  ['classification', 'Classification'], ['content', 'Content'], ['variations', 'Variations'],
  ['images', 'Images and media'], ['offer', 'Offer'], ['shipping', 'Shipping'], ['policies', 'Policies'],
].map(([key, label], order) => [key, { key, label, channelLabel: null, order }]))

const GROUP_FOR_LISTING_FIELD: Record<string, string> = {
  price: 'offer', quantity: 'offer',
  categoryId: 'classification',
  title: 'content', subtitle: 'content', description: 'content', descriptionThemeId: 'content',
  variationTheme: 'variations', sharedSkuListing: 'variations',
  imageUrls: 'images', videoId: 'images',
  conditionId: 'offer', listingFormat: 'offer', listingDuration: 'offer',
  bestOffer: 'offer', bestOfferFloor: 'offer', bestOfferCeiling: 'offer', vatRate: 'offer',
  dimensionUnit: 'shipping', handlingTime: 'shipping', itemLocationCountry: 'shipping', packageType: 'shipping', packageWeight: 'shipping',
  packageLength: 'shipping', packageWidth: 'shipping', packageHeight: 'shipping',
  paymentPolicyId: 'policies', returnPolicyId: 'policies', fulfillmentPolicyId: 'policies',
}

/** eBay's own enums for the listing-level fields (Sell Inventory API vocabularies). */
const LISTING_FORMATS = ['FIXED_PRICE', 'AUCTION']
const LISTING_DURATIONS = ['GTC', 'DAYS_1', 'DAYS_3', 'DAYS_5', 'DAYS_7', 'DAYS_10', 'DAYS_30']
const WEIGHT_UNITS = ['KILOGRAM', 'GRAM', 'POUND', 'OUNCE']
const LENGTH_UNITS = ['CENTIMETER', 'METER', 'INCH', 'FEET']
const PACKAGE_TYPES = ['LETTER', 'BULKY_GOODS', 'CARAVAN', 'CARS', 'EUROPALLET', 'EXPANDABLE_TOUGH_BAGS', 'EXTRA_LARGE_PACK', 'FURNITURE', 'INDUSTRY_VEHICLES', 'LARGE_CANADA_POSTBOX', 'LARGE_CANADA_POST_BUBBLE_MAILER', 'LARGE_ENVELOPE', 'MAILING_BOX', 'MEDIUM_CANADA_POST_BOX', 'MEDIUM_CANADA_POST_BUBBLE_MAILER', 'MOTORBIKES', 'ONE_WAY_PALLET', 'PACKAGE_THICK_ENVELOPE', 'PADDED_BAGS', 'PARCEL_OR_PADDED_ENVELOPE', 'ROLL', 'SMALL_CANADA_POST_BOX', 'SMALL_CANADA_POST_BUBBLE_MAILER', 'TOUGH_BAGS', 'UPS_LETTER', 'USPS_FLAT_RATE_ENVELOPE', 'USPS_LARGE_PACK', 'VERY_LARGE_PACK', 'WINE_PAK']

export function ebaySpecFromCache(input: EbaySpecInput): ChannelSpec {
  const marketplace = String(input.marketplace).toUpperCase()
  const fields: ChannelFieldSpec[] = []
  const coverage: Record<string, string[]> = {}
  const unrecognised: string[] = []

  // ── listing-level fields ─────────────────────────────────────────
  const conditions = (input.conditions ?? []).filter((c) => c && typeof c.value === 'string' && c.value)
    .map(c => ({ ...c, value: toInventoryCondition(c.value) }))
  const listingFields: ChannelFieldSpec[] = [
    listing('price', 'Prezzo', 'Listing price', { kind: 'number', requirement: 'required', channelStore: { kind: 'listingColumn', column: 'price', followFlag: 'followMasterPrice' } }),
    listing('quantity', 'Quantità disponibile', 'Available quantity', { kind: 'number', requirement: 'required', channelStore: { kind: 'listingColumn', column: 'quantity', followFlag: 'followMasterQuantity' } }),
    listing('title', 'Titolo', 'Title', { kind: 'text', maxLength: 80, requirement: 'required', masterKey: 'name', channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } }),
    listing('subtitle', 'Sottotitolo', 'Subtitle', { kind: 'text', maxLength: 55, channelStore: pa('subtitle') }),
    listing('description', 'Descrizione', 'Description', { kind: 'longtext', requirement: 'required', masterKey: 'description', channelStore: { kind: 'listingColumn', column: 'description', followFlag: 'followMasterDescription' } }),
    listing('conditionId', 'Condizione', 'Condition', {
      kind: 'select', requirement: 'required', mode: 'strict',
      options: conditions.length > 0 ? conditions.map((c) => c.value) : ['NEW', 'NEW_OTHER', 'NEW_WITH_DEFECTS', 'USED_EXCELLENT', 'USED_VERY_GOOD', 'USED_GOOD', 'USED_ACCEPTABLE', 'FOR_PARTS_OR_NOT_WORKING'],
      optionLabels: conditions.length > 0 ? Object.fromEntries(conditions.map((c) => [c.value, c.label])) : undefined,
      channelStore: pa('conditionId'),
    }),
    listing('categoryId', 'Categoria', 'Category', { kind: 'text', channelStore: pa('categoryId'), helpText: 'The eBay category this listing is filed under.' }),
    listing('listingFormat', 'Formato', 'Listing format', { kind: 'select', mode: 'strict', options: LISTING_FORMATS, channelStore: pa('listingFormat') }),
    listing('listingDuration', 'Durata', 'Listing duration', { kind: 'select', mode: 'strict', options: LISTING_DURATIONS, channelStore: pa('listingDuration') }),
    listing('bestOffer', 'Proposta d\'acquisto', 'Best offer', { kind: 'boolean', channelStore: pa('bestOffer') }),
    listing('bestOfferFloor', 'Proposta minima accettata', 'Best offer auto-accept', { kind: 'number', channelStore: pa('bestOfferFloor') }),
    listing('bestOfferCeiling', 'Proposta rifiutata sotto', 'Best offer auto-decline', { kind: 'number', channelStore: pa('bestOfferCeiling') }),
    listing('handlingTime', 'Tempo di imballaggio', 'Handling time (days)', { kind: 'number', channelStore: pa('handlingTime') }),
    listing('itemLocationCountry', 'Paese dell’oggetto', 'Item location country', { kind: 'text', maxLength: 2, channelStore: pa('itemLocationCountry'), helpText: 'Two-letter country code for the item location. The legacy eBay workbook labels this field Location.' }),
    listing('packageType', 'Tipo di pacco', 'Package type', { kind: 'select', mode: 'open', options: PACKAGE_TYPES, channelStore: pa('packageType') }),
    listing('packageWeight', 'Peso del pacco', 'Package weight', { kind: 'number', shape: 'measure', unitOptions: WEIGHT_UNITS, channelStore: { kind: 'platformAttributes', path: ['packageWeight'], unitPath: ['weightUnit'] } }),
    listing('packageLength', 'Lunghezza del pacco', 'Package length', { kind: 'number', channelStore: pa('packageLength'), helpText: 'Uses the shared package dimension unit.' }),
    listing('packageWidth', 'Larghezza del pacco', 'Package width', { kind: 'number', channelStore: pa('packageWidth'), helpText: 'Uses the shared package dimension unit.' }),
    listing('packageHeight', 'Altezza del pacco', 'Package height', { kind: 'number', channelStore: pa('packageHeight'), helpText: 'Uses the shared package dimension unit.' }),
    listing('dimensionUnit', 'Unità delle dimensioni', 'Package dimension unit', { kind: 'select', mode: 'strict', options: LENGTH_UNITS, channelStore: pa('dimensionUnit'), helpText: 'Applies to package length, width and height together.' }),
    listing('vatRate', 'Aliquota IVA', 'VAT rate (%)', { kind: 'number', channelStore: pa('vatRate') }),
    listing('videoId', 'Video', 'Video id', { kind: 'text', channelStore: pa('videoId') }),
    listing('imageUrls', 'Immagini', 'Image URLs', { kind: 'text', shape: 'list', cardinality: { min: 1, max: 24 }, channelStore: pa('imageUrls'), helpText: 'The listing\'s picture URLs, in order — the Images tab publishes them; this column reads the same store.' }),
    listing('paymentPolicyId', 'Regola di pagamento', 'Payment policy', { kind: 'text', channelStore: pa('paymentPolicyId') }),
    listing('returnPolicyId', 'Regola di restituzione', 'Return policy', { kind: 'text', channelStore: pa('returnPolicyId') }),
    listing('fulfillmentPolicyId', 'Regola di spedizione', 'Shipping policy', { kind: 'text', channelStore: pa('fulfillmentPolicyId') }),
    listing('descriptionThemeId', 'Tema della descrizione', 'Description theme', { kind: 'text', channelStore: pa('descriptionThemeId') }),
    listing('sharedSkuListing', 'Inserzione a SKU condiviso', 'Shared-SKU listing', { kind: 'boolean', channelStore: pa('sharedSkuListing') }),
    // VT.1 (2026-09-13, D-VT3): the SHEET no longer serves this as a raw column - the engine-owned Variation
    // theme column does, and the exclusion lives in `sheet-columns.service.ts` where the sheet is built. The spec
    // still declares the field because the mapping engine's field catalogue reads this walk too (dropping it here
    // put "Category requirement validation is unavailable" on every Amazon cell when the same was tried there).
    listing('variationTheme', 'Tema delle varianti', 'Variation theme', { kind: 'text', channelStore: { kind: 'listingColumn', column: 'variationTheme' }, helpText: 'How the variation axes report to eBay (ChannelListing.variationTheme). Edited through the Variation theme column, which serves this store with the site aspects and the relist warning.' }),
  ]
  for (const f of listingFields) {
    f.group = LISTING_GROUPS[GROUP_FOR_LISTING_FIELD[f.key]] ?? LISTING_GROUP
    fields.push(f)
    coverage[f.key] = [f.key]
  }

  // ── aspects ──────────────────────────────────────────────────────
  const rowsByEnglish = new Map<string, EbayChannelSchemaRow>()
  for (const r of input.channelSchemaRows ?? []) {
    if (r.fieldKey.startsWith('aspect_')) rowsByEnglish.set(normaliseKey(r.fieldKey), r)
  }

  for (const a of input.aspects ?? []) {
    if (!a || typeof a !== 'object') continue
    const names = aspectNames(a)
    if (!names) { unrecognised.push(`${String(a.id ?? '?')}: no name`); continue }
    const norm = normaliseKey(names.english)
    const row = rowsByEnglish.get(norm)
    const multi = a.cardinality ? a.cardinality === 'MULTI' : /multi-value/i.test(row?.notes ?? '')
    const options = Array.isArray(a.options) && a.options.length > 0 ? a.options.map(String) : undefined
    const isEnum = a.kind === 'enum' && !!options
    const kind: ChannelFieldSpec['kind'] = isEnum ? 'select' : a.kind === 'number' || a.dataType === 'NUMBER' ? 'number' : a.kind === 'date' || a.dataType === 'DATE' ? 'date' : isProseKey(norm) ? 'longtext' : 'text'
    const maxLength = typeof a.maxLength === 'number' && a.maxLength > 0 ? a.maxLength : typeof row?.maxLength === 'number' && row.maxLength > 0 ? row.maxLength : undefined
    const spec: ChannelFieldSpec = {
      key: norm,
      attribute: `aspect_${names.english}`,
      path: [],
      label: names.localized,
      englishLabel: englishEbayAspectLabel(names.english) ?? names.english,
      shape: multi ? 'list' : 'scalar',
      kind,
      // eBay's aspect metadata declares no per-aspect maximum in the cache; the adapter records
      // the truth (unbounded) rather than inventing one.
      cardinality: multi ? { min: 1, max: null } : { min: 1, max: 1 },
      options,
      mode: options ? (a.enumMode === 'strict' ? 'strict' : 'open') : undefined,
      maxLength,
      requirement: (a.required ?? row?.required) ? 'required' : a.recommended || a.guidance === 'RECOMMENDED' ? 'bestPractice' : 'optional',
      requiredInParent: true,
      editable: true,
      hidden: false,
      variantEligible: a.variantEligible === true,
      group: ASPECTS_GROUP,
      helpText: a.recommended || a.guidance === 'RECOMMENDED' ? 'eBay recommends this item specific for this category.' : undefined,
      channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', names.localized] },
    }
    if (norm === 'brand') spec.masterKey = 'brand'
    fields.push(spec)
    coverage[spec.attribute] = [spec.key]
  }

  return {
    channel: 'EBAY',
    marketplace,
    category: String(input.categoryId),
    fields,
    groups: [...Object.values(LISTING_GROUPS), ASPECTS_GROUP, LISTING_GROUP],
    fetchedAt: input.fetchedAt ?? null,
    schemaVersion: 'live',
    coverage,
    unrecognised,
    absent: false,
  }
}

/**
 * The localised and English names of an aspect. Newer cache rows carry both explicitly; older rows
 * fold the English name into the label as `Marca (Brand)`. An aspect with no English name at all
 * (`Scollatura`, `Quantità`) is keyed by its localised name — the same key `ChannelSchema` uses.
 */
export function aspectNames(a: EbayCachedAspect): { localized: string; english: string } | null {
  const explicitLocalized = typeof a.localizedName === 'string' && a.localizedName.trim() ? a.localizedName.trim() : null
  const explicitEnglish = typeof a.englishName === 'string' && a.englishName.trim() ? a.englishName.trim() : null
  if (explicitLocalized || explicitEnglish) {
    return { localized: explicitLocalized ?? explicitEnglish!, english: explicitEnglish ?? explicitLocalized! }
  }
  const label = typeof a.label === 'string' ? a.label.trim() : ''
  if (!label) {
    const fromId = typeof a.id === 'string' ? a.id.replace(/^aspect_/, '').replace(/_/g, ' ').trim() : ''
    return fromId ? { localized: fromId, english: fromId } : null
  }
  const m = label.match(/^(.+?)\s*\((.+)\)$/)
  if (m) return { localized: m[1].trim(), english: m[2].trim() }
  return { localized: label, english: label }
}

// ────────────────────────────────────────────────────────────────────

function pa(key: string): ChannelFieldSpec['channelStore'] {
  return { kind: 'platformAttributes', path: [key] }
}

function listing(
  key: string,
  label: string,
  englishLabel: string,
  over: Partial<ChannelFieldSpec> & { kind: ChannelFieldSpec['kind'] },
): ChannelFieldSpec {
  return {
    key,
    attribute: key,
    path: [],
    label,
    englishLabel,
    shape: 'scalar',
    cardinality: { min: 1, max: 1 },
    requirement: 'optional',
    requiredInParent: true,
    editable: true,
    hidden: false,
    variantEligible: false,
    group: LISTING_GROUP,
    ...over,
    helpText: over.helpText ?? (over.kind === 'text' && !over.maxLength ? undefined : undefined),
  }
}

/** Exported so the column builder can label an eBay-only key the adapter did not name. */
export { humanizeKey }
