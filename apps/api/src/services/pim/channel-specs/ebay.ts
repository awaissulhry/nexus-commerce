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
import { ebayConditionName, toInventoryCondition } from '../../ebay-condition.js'
import { englishEbayAspectLabel } from '../../ebay-aspect-names.js'
import { sheetName } from '@nexus/shared/sheet-names'
import { EBAY_ASPECT_VALUE_MAX } from '../../ebay-aspect-values.js'
import { EBAY_PACKAGE_LABELS, EBAY_PACKAGE_TYPES } from '../ebay-packages.js'

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
  /** eBay's approximate date from which it plans to require this aspect (aspectConstraint.expectedRequiredByDate). */
  expectedRequiredByDate?: string | null
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
  conditionId: 'offer', listingFormat: 'offer', listingDuration: 'offer', quantityLimitPerBuyer: 'offer',
  bestOffer: 'offer', bestOfferFloor: 'offer', bestOfferCeiling: 'offer', vatRate: 'offer',
  dimensionUnit: 'shipping', handlingTime: 'shipping', itemLocationCountry: 'shipping', itemLocation: 'shipping', itemPostalCode: 'shipping', packageType: 'shipping', packageWeight: 'shipping',
  packageLength: 'shipping', packageWidth: 'shipping', packageHeight: 'shipping',
  paymentPolicyId: 'policies', returnPolicyId: 'policies', fulfillmentPolicyId: 'policies',
}

/** eBay's own enums for the listing-level fields (Sell Inventory API vocabularies). */
// E1 (2026-10-04) — Nexus publishes fixed-price eBay listings only, so the list offers only that. A stored AUCTION shows
// as off the list (it can be cleared) and publish still refuses it with its reason.
const LISTING_FORMATS = ['FIXED_PRICE']
// Wave 2 (Owner decision 1, 2026-10-05) — every Trading publish sends GTC (`ebay-trading-api.service.ts`): a fixed-price
// listing runs until cancelled. The column shows GTC, read-only (`EBAY_FIXED_VALUES`), whatever the listing stores.
const LISTING_DURATIONS = ['GTC']
const WEIGHT_UNITS = ['KILOGRAM', 'GRAM', 'POUND', 'OUNCE']
const LENGTH_UNITS = ['CENTIMETER', 'METER', 'INCH', 'FEET']
// E1 — the one package list publish knows (`ebay-packages.ts`); the column is strict: a type outside it cannot be sent.
const PACKAGE_TYPES = EBAY_PACKAGE_TYPES
/** W3-4 — the dimension units as people write them; the code stored and sent is unchanged (eBay's CENTIMETER…). */
const LENGTH_UNIT_LABELS: Record<string, string> = { CENTIMETER: 'cm', METER: 'm', INCH: 'in', FEET: 'ft' }
/** The condition list when the category's cached conditions are not known. */
const CONDITION_FALLBACK = ['NEW', 'NEW_OTHER', 'NEW_WITH_DEFECTS', 'USED_EXCELLENT', 'USED_VERY_GOOD', 'USED_GOOD', 'USED_ACCEPTABLE', 'FOR_PARTS_OR_NOT_WORKING']

/**
 * W3-4 — each condition in eBay's English words, following the category's own wording for 1000 / 1500 (its cached market
 * name says tags or box). The market name ("Nuovo con etichette") stays an accepted spelling (`optionAliases`), so a
 * paste or an import of the old words still lands on the code.
 */
function conditionNames(conditions: EbayCachedCondition[]): Pick<ChannelFieldSpec, 'optionLabels' | 'optionAliases'> {
  const entries = conditions.length > 0 ? conditions.map(c => ({ code: c.value, market: typeof c.label === 'string' ? c.label.trim() : '' }))
    : CONDITION_FALLBACK.map(code => ({ code, market: '' }))
  const optionLabels = Object.fromEntries(entries.map(({ code, market }) => [code, ebayConditionName(code, market)]))
  const optionAliases: Record<string, string[]> = {}
  for (const { code, market } of entries) {
    if (market && market.toLowerCase() !== optionLabels[code].toLowerCase() && !optionAliases[code]?.includes(market)) optionAliases[code] = [...(optionAliases[code] ?? []), market]
  }
  return { optionLabels, ...(Object.keys(optionAliases).length ? { optionAliases } : {}) }
}

// Wave 2 (Owner decision 8, 2026-10-05) — each listing setting says what a BLANK cell does at Publish, in true words for the
// Trading publish (new listing, Partial update, Full update) and the Inventory photo publish. A field Publish fixes or
// does not use carries its reason instead (`editHeldReason`: read-only, never a "Blank:" sentence).
const BLANK_NONE = 'Blank: Publish sends none. A live listing keeps eBay\'s value.'
const BLANK_POLICY = 'Blank: Publish uses this eBay account\'s default policy.'
const BLANK_LOCATION = 'Blank: Publish uses the eBay account\'s location. A live listing keeps eBay\'s, unless a Full update sends the account\'s.'
/** Wave 2 — the held columns' reasons (read-only on the sheet; the eBay workbook import does not import them). */
export const EBAY_HELD_REASONS = {
  listingDuration: 'eBay fixed-price listings run until cancelled. Publish always sends GTC.',
  handlingTime: 'eBay takes the handling time from the listing\'s shipping policy. Change it in that policy on eBay.',
  sharedSkuListing: 'Publish here does not use this. It only steered the old eBay flat-file page. To sell the same SKUs on another eBay listing, add a listing alias.',
} as const

export function ebaySpecFromCache(input: EbaySpecInput): ChannelSpec {
  const marketplace = String(input.marketplace).toUpperCase()
  const fields: ChannelFieldSpec[] = []
  const coverage: Record<string, string[]> = {}
  const unrecognised: string[] = []

  // ── listing-level fields ─────────────────────────────────────────
  const conditions = (input.conditions ?? []).filter((c) => c && typeof c.value === 'string' && c.value)
    .map(c => ({ ...c, value: toInventoryCondition(c.value) }))
  const listingFields: ChannelFieldSpec[] = [
    // Step 2.2: sheet price edits now use writeChannelPrices; the temporary hold is lifted.
    // W3-6 — the English names read the sheet's naming table: "Price", "Qty", "Video ID" (were "Listing price",
    // "Available quantity", "Video id"). The Italian names are eBay's and stay.
    listing('price', 'Prezzo', sheetName('price', 'EBAY')!, {
      kind: 'number', requirement: 'required',
      channelStore: { kind: 'listingColumn', column: 'price', followFlag: 'followMasterPrice' },
    }),
    listing('quantity', 'Quantità disponibile', sheetName('quantity', 'EBAY')!, { kind: 'number', requirement: 'required', channelStore: { kind: 'listingColumn', column: 'quantity', followFlag: 'followMasterQuantity' } }),
    listing('title', 'Titolo', 'Title', { kind: 'text', maxLength: 80, requirement: 'required', masterKey: 'name', channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } }),
    listing('subtitle', 'Sottotitolo', 'Subtitle', { kind: 'text', maxLength: 55, channelStore: pa('subtitle'), helpText: 'Blank: Publish sends none. A live listing keeps eBay\'s subtitle, unless a Full update removes it.' }),
    listing('description', 'Descrizione', 'Description', { kind: 'longtext', requirement: 'required', masterKey: 'description', channelStore: { kind: 'listingColumn', column: 'description', followFlag: 'followMasterDescription' } }),
    listing('conditionId', 'Condizione', 'Condition', {
      kind: 'select', requirement: 'required', mode: 'strict',
      options: conditions.length > 0 ? conditions.map((c) => c.value) : [...CONDITION_FALLBACK],
      // W3-4 (Owner decision 7) — eBay's English names, in the category's own wording ("New with tags"); the market's name
      // ("Nuovo con etichette") is still accepted when pasted. The code stored and sent is unchanged.
      ...conditionNames(conditions),
      channelStore: pa('conditionId'),
      helpText: 'Blank: Publish refuses a new listing without one. A live listing keeps eBay\'s condition.',
    }),
    listing('categoryId', 'Categoria', 'Category', { kind: 'text', requirement: 'required', channelStore: pa('categoryId'), helpText: 'The eBay category this listing is filed under. eBay needs one per site. Blank: a variation row uses the main row\'s; Publish refuses a main row without one.' }),
    listing('listingFormat', 'Formato', 'Listing format', { kind: 'select', mode: 'strict', options: LISTING_FORMATS, channelStore: pa('listingFormat'), helpText: 'Nexus publishes fixed-price listings only. Blank: Publish sends a fixed-price listing.' }),
    listing('listingDuration', 'Durata', 'Listing duration', { kind: 'select', mode: 'strict', options: LISTING_DURATIONS, channelStore: pa('listingDuration'), editHeldReason: EBAY_HELD_REASONS.listingDuration }),
    listing('bestOffer', 'Proposta d\'acquisto', 'Best offer', { kind: 'boolean', channelStore: pa('bestOffer'), helpText: BLANK_NONE }),
    // CHMAP M7 (B3) — the floor is eBay's autoDeclinePrice and the ceiling its autoAcceptPrice (`ebay-variation-push.service.ts`).
    listing('bestOfferFloor', 'Rifiuto automatico sotto', 'Best offer auto-decline below', { kind: 'number', channelStore: pa('bestOfferFloor'), helpText: `Offers below this are declined automatically (eBay autoDeclinePrice). Must be below the auto-accept price. ${BLANK_NONE}` }),
    listing('bestOfferCeiling', 'Accettazione automatica da', 'Best offer auto-accept from', { kind: 'number', channelStore: pa('bestOfferCeiling'), helpText: `Offers at or above this are accepted automatically (eBay autoAcceptPrice). Must be above the auto-decline price. ${BLANK_NONE}` }),
    // E1 (2026-10-04) — publish already sent the stored value (`QuantityRestrictionPerBuyer`) with no column to see or edit it.
    listing('quantityLimitPerBuyer', 'Quantità massima per acquirente', 'Max per buyer', { kind: 'number', channelStore: pa('quantityLimitPerBuyer'), helpText: 'The most units one buyer may buy from this listing: a whole number, 1 or more. Publish sends it (an eBay Inventory listing gets it when its photos are published). Blank: no limit is sent, and a live listing keeps the limit eBay holds.' }),
    // Wave 2 (Owner decision 6) — not sent (eBay takes it from the shipping policy): read-only and blank (`EBAY_FIXED_VALUES`).
    listing('handlingTime', 'Tempo di imballaggio', 'Handling time (days)', { kind: 'number', channelStore: pa('handlingTime'), editHeldReason: EBAY_HELD_REASONS.handlingTime }),
    listing('itemLocationCountry', 'Paese dell’oggetto', 'Item location country', { kind: 'text', maxLength: 2, channelStore: pa('itemLocationCountry'), helpText: `Two-letter country code for the item location. The legacy eBay workbook labels this field Location. ${BLANK_LOCATION}` }),
    // #30 (2026-09-30) — the city and postal code publish already reads (`studio-publication-ebay.ts`, `settings.itemLocation`
    // / `settings.itemPostalCode`) had no column, so a new listing on an account with no default location could not be published.
    listing('itemLocation', 'Località dell’oggetto', 'Item location (city)', { kind: 'text', channelStore: pa('itemLocation'), helpText: `City or town where the item is. eBay needs a postal code or a city, with the country, to create a listing. It overrides the account's default location. ${BLANK_LOCATION}` }),
    listing('itemPostalCode', 'CAP dell’oggetto', 'Item location postal code', { kind: 'text', channelStore: pa('itemPostalCode'), helpText: `Postal code where the item is. eBay needs a postal code or a city, with the country, to create a listing. It overrides the account's default location. ${BLANK_LOCATION}` }),
    listing('packageType', 'Tipo di pacco', 'Package type', { kind: 'select', mode: 'strict', options: [...PACKAGE_TYPES], optionLabels: { ...EBAY_PACKAGE_LABELS }, channelStore: pa('packageType'), helpText: BLANK_NONE }),
    listing('packageWeight', 'Peso del pacco', 'Package weight', { kind: 'number', shape: 'measure', unitOptions: WEIGHT_UNITS, channelStore: { kind: 'platformAttributes', path: ['packageWeight'], unitPath: ['weightUnit'] }, helpText: BLANK_NONE }),
    listing('packageLength', 'Lunghezza del pacco', 'Package length', { kind: 'number', channelStore: pa('packageLength'), helpText: `Uses the shared package dimension unit. ${BLANK_NONE}` }),
    listing('packageWidth', 'Larghezza del pacco', 'Package width', { kind: 'number', channelStore: pa('packageWidth'), helpText: `Uses the shared package dimension unit. ${BLANK_NONE}` }),
    listing('packageHeight', 'Altezza del pacco', 'Package height', { kind: 'number', channelStore: pa('packageHeight'), helpText: `Uses the shared package dimension unit. ${BLANK_NONE}` }),
    listing('dimensionUnit', 'Unità delle dimensioni', 'Package dimension unit', { kind: 'select', mode: 'strict', options: LENGTH_UNITS, optionLabels: LENGTH_UNIT_LABELS, channelStore: pa('dimensionUnit'), helpText: 'Applies to package length, width and height together. Blank: a package length, width or height cannot be sent without it.' }),
    // Wave 2 (Owner decision 7) — blank sends nothing (it sent <VATPercent>0</VATPercent>).
    listing('vatRate', 'Aliquota IVA', 'VAT rate (%)', { kind: 'number', channelStore: pa('vatRate'), helpText: `A number from 0 to 100. ${BLANK_NONE}` }),
    listing('videoId', 'Video', sheetName('videoId', 'EBAY')!, { kind: 'text', channelStore: pa('videoId'), helpText: BLANK_NONE }),
    listing('imageUrls', 'Immagini', 'Image URLs', { kind: 'text', shape: 'list', cardinality: { min: 1, max: 24 }, channelStore: pa('imageUrls'), helpText: 'The listing\'s picture URLs, in order — the Images tab publishes them; this column reads the same store.' }),
    listing('paymentPolicyId', 'Regola di pagamento', 'Payment policy', { kind: 'text', channelStore: pa('paymentPolicyId'), helpText: BLANK_POLICY }),
    listing('returnPolicyId', 'Regola di restituzione', 'Return policy', { kind: 'text', channelStore: pa('returnPolicyId'), helpText: BLANK_POLICY }),
    listing('fulfillmentPolicyId', 'Regola di spedizione', 'Shipping policy', { kind: 'text', channelStore: pa('fulfillmentPolicyId'), helpText: BLANK_POLICY }),
    listing('descriptionThemeId', 'Tema della descrizione', 'Description theme', { kind: 'text', channelStore: pa('descriptionThemeId'), helpText: 'Blank: Publish uses the default description theme, or the plain description when there is none.' }),
    // Wave 2 (Owner decision 4) — only the old flat-file page read it: read-only with the reason.
    listing('sharedSkuListing', 'Inserzione a SKU condiviso', 'Shared-SKU listing', { kind: 'boolean', channelStore: pa('sharedSkuListing'), editHeldReason: EBAY_HELD_REASONS.sharedSkuListing }),
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
    // P1 (report 3 I-3.9) — eBay refuses any ONE value over 65 characters (21919308) whatever the cache says; the cache
    // carries no cap, so the column declares eBay's: the sheet warns while editing and publish blocks it.
    const cached = typeof a.maxLength === 'number' && a.maxLength > 0 ? a.maxLength : typeof row?.maxLength === 'number' && row.maxLength > 0 ? row.maxLength : undefined
    const maxLength = Math.min(cached ?? EBAY_ASPECT_VALUE_MAX, EBAY_ASPECT_VALUE_MAX)
    const required = !!(a.required ?? row?.required)
    const recommended = !!(a.recommended || a.guidance === 'RECOMMENDED')
    // W3-5 — eBay names a date from which it plans to require an aspect that is not required yet: shown as a
    // recommendation with that date. An aspect already required stays required; a date that is not a real date is ignored.
    const requiredFrom = required ? null : ebayRequiredFromDay(a.expectedRequiredByDate)
    const spec: ChannelFieldSpec = {
      key: norm,
      attribute: `aspect_${names.english}`,
      path: [],
      label: names.localized,
      englishLabel: englishEbayAspectLabel(names.english) ?? names.english,
      shape: multi ? 'list' : 'scalar',
      kind,
      // eBay's aspect metadata declares no per-aspect maximum NUMBER of values in the cache; the adapter
      // records the truth (unbounded) rather than inventing one.
      cardinality: multi ? { min: 1, max: null } : { min: 1, max: 1 },
      options,
      mode: options ? (a.enumMode === 'strict' ? 'strict' : 'open') : undefined,
      maxLength,
      requirement: required ? 'required' : recommended || requiredFrom ? 'bestPractice' : 'optional',
      requiredInParent: true,
      editable: true,
      hidden: false,
      variantEligible: a.variantEligible === true,
      group: ASPECTS_GROUP,
      helpText: requiredFrom ? `eBay plans to require this item specific from about ${requiredFrom}.`
        : recommended ? 'eBay recommends this item specific for this category.' : undefined,
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

/**
 * W3-5 — eBay's `expectedRequiredByDate` (ISO 8601, e.g. `2027-01-15T00:00:00.000Z`) as an English day, `15 January 2027`:
 * the calendar day eBay wrote (eBay calls the date approximate). Null when it is missing or not a real date.
 */
function ebayRequiredFromDay(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/)
  if (!m || Number.isNaN(Date.parse(text))) return null
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const at = new Date(Date.UTC(year, month - 1, day))
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
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
