/**
 * Google Ads programme 2, G12 (2026-10-16) — the Merchant Center changes Nexus sends (Merchant API v1,
 * merchantapi.googleapis.com). The gateway lets through exactly these methods and paths, for ONE Merchant Center account
 * the business chose in Nexus (its GoogleAccountLink product MERCHANT, through this Google connection), with exactly the
 * bodies the Merchant tools send (google-ads-merchant.tools.ts) — nothing broader. Every other Merchant change stays
 * refused (GOOGLE_READ_ONLY).
 *
 * Checked 2026-10-16 with curl of developers.google.com/merchant/api/reference/rest/<sub-API>/<resource>/<method> and the
 * discovery documents (https://merchantapi.googleapis.com/$discovery/rest?version=products_v1 | datasources_v1 |
 * promotions_v1), the stable v1 of each sub-API:
 *   POST   /products/v1/accounts/{a}/productInputs:insert?dataSource=accounts/{a}/dataSources/{d}   body ProductInput
 *          ("Only API data sources are supported"; an input with the same contentLanguage, offerId and dataSource is replaced)
 *   DELETE /products/v1/accounts/{a}/productInputs/{productInput}?dataSource=accounts/{a}/dataSources/{d}   no body
 *          ({productInput}: the unpadded base64url of contentLanguage~feedLabel~offerId, the encoded form Google recommends)
 *   POST   /datasources/v1/accounts/{a}/dataSources                                                 body DataSource
 *          (Nexus makes a supplemental product data source or a promotion data source, both API input)
 *   PATCH  /datasources/v1/accounts/{a}/dataSources/{d}?updateMask=displayName                      body DataSource
 *          ("Fields specified in the update mask without a value … will be deleted"; "*" is not supported)
 *   DELETE /datasources/v1/accounts/{a}/dataSources/{d}                                             no body
 *   POST   /datasources/v1/accounts/{a}/dataSources/{d}:fetch                                       body {} (FetchDataSourceRequest
 *          has no field; "only works on data sources with a file input set")
 *   POST   /promotions/v1/accounts/{a}/promotions:insert                                            body InsertPromotionRequest
 *          { promotion, dataSource } (an insert of an existing promotion replaces it: "overwrites the entire promotions resource")
 * No Merchant API write has validate_only (none of the request messages above has the field): Google cannot check a
 * Merchant change first, so every one goes as a write, under the Google publish mode (NEXUS_GOOGLE_ADS_WRITES=off refuses
 * it). Not here, on purpose: a PRIMARY data source and any change of one (its products, countries or rules: the primary
 * feed belongs to Shopify's Google channel; a product in a primary needs a price, availability and link that must match
 * the shop, and an insert into another primary MOVES the product out of its feed), productInputs.patch (Nexus sends a
 * whole input, from its own record), local and regional inventory writes (Nexus has no store a Merchant Center store
 * code names), regions, account settings, and every other sub-API.
 *
 * Reads: a GET (or a reports `…:search` POST) that names a Merchant Center account in its path is let through only for an
 * account this business chose through this connection (merchantReadAccount): a Merchant Center id never crosses
 * businesses. The account list (`/accounts/v1/accounts`, discovery) names none and stays as it is.
 */

const HOST = 'merchantapi.googleapis.com'

export type MerchantCallKind =
  | 'productInputs:insert' | 'productInputs:delete'
  | 'dataSources:create' | 'dataSources:patch' | 'dataSources:delete' | 'dataSources:fetch'
  | 'promotions:insert'

export interface MerchantCall {
  kind: MerchantCallKind
  /** The Merchant Center account in the path (digits). */
  account: string
  /** The data source the call names (path or `dataSource` query), digits; absent on a create and a promotion. */
  dataSource?: string
  /** productInputs:delete — the input's encoded id. */
  productInput?: string
  /** dataSources:patch — the one field it changes. */
  updateMask?: string
}

const ACCOUNT = '(\\d{1,20})'
const DS = '(\\d{1,20})'
const PATHS: Array<{ method: string; kind: MerchantCallKind; re: RegExp; query: readonly string[] }> = [
  { method: 'POST', kind: 'productInputs:insert', re: new RegExp(`^/products/v1/accounts/${ACCOUNT}/productInputs:insert$`), query: ['dataSource'] },
  { method: 'DELETE', kind: 'productInputs:delete', re: new RegExp(`^/products/v1/accounts/${ACCOUNT}/productInputs/([A-Za-z0-9_-]{4,400})$`), query: ['dataSource'] },
  { method: 'POST', kind: 'dataSources:create', re: new RegExp(`^/datasources/v1/accounts/${ACCOUNT}/dataSources$`), query: [] },
  { method: 'PATCH', kind: 'dataSources:patch', re: new RegExp(`^/datasources/v1/accounts/${ACCOUNT}/dataSources/${DS}$`), query: ['updateMask'] },
  { method: 'DELETE', kind: 'dataSources:delete', re: new RegExp(`^/datasources/v1/accounts/${ACCOUNT}/dataSources/${DS}$`), query: [] },
  { method: 'POST', kind: 'dataSources:fetch', re: new RegExp(`^/datasources/v1/accounts/${ACCOUNT}/dataSources/${DS}:fetch$`), query: [] },
  { method: 'POST', kind: 'promotions:insert', re: new RegExp(`^/promotions/v1/accounts/${ACCOUNT}/promotions:insert$`), query: [] },
]

/** The kinds of Merchant change Nexus sends, for the gateway's own test (a new one is a new line there, on purpose). */
export const MERCHANT_CALL_KINDS: readonly MerchantCallKind[] = PATHS.map((p) => p.kind)

/** The data source fields a dataSources.patch may change (its updateMask): its name only. */
export const DATA_SOURCE_MASKS = ['displayName'] as const

const dataSourceRef = (account: string) => new RegExp(`^accounts/${account}/dataSources/(\\d{1,20})$`)

/** The Merchant change of a method and URL Nexus sends, or null when the call is not one. */
export function googleMerchantCall(method: string, url: string): MerchantCall | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== HOST || parsed.hash) return null
  const m = method.toUpperCase()
  for (const path of PATHS) {
    if (path.method !== m) continue
    const match = path.re.exec(parsed.pathname)
    if (!match) continue
    const keys = [...parsed.searchParams.keys()]
    if (keys.length !== path.query.length || keys.some((k) => !path.query.includes(k)) || new Set(keys).size !== keys.length) return null
    const account = match[1]
    const call: MerchantCall = { kind: path.kind, account }
    if (path.kind === 'productInputs:insert' || path.kind === 'productInputs:delete') {
      const ref = dataSourceRef(account).exec(parsed.searchParams.get('dataSource') ?? '')
      if (!ref) return null
      call.dataSource = ref[1]
      if (path.kind === 'productInputs:delete') call.productInput = match[2]
    } else if (path.kind !== 'dataSources:create' && path.kind !== 'promotions:insert') {
      call.dataSource = match[2]
    }
    if (path.kind === 'dataSources:patch') {
      const mask = parsed.searchParams.get('updateMask') ?? ''
      if (!(DATA_SOURCE_MASKS as readonly string[]).includes(mask)) return null
      call.updateMask = mask
    }
    return call
  }
  return null
}

/** The Merchant Center account a Merchant READ names in its path (`/{api}/v1/accounts/{id}/…`), or null when it names none. */
export function merchantReadAccount(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== HOST) return null
  const match = /^\/[a-z]+\/v1(?:beta|alpha)?\/accounts\/(\d{1,20})(?:[/:]|$)/.exec(parsed.pathname)
  return match ? match[1] : null
}

// ── product inputs ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a product input Nexus sends may hold: these ProductAttributes (Merchant API products_v1, camelCase JSON names,
 * checked in the discovery document 2026-10-16) and nothing else. Lengths are the product data specification's
 * (support.google.com/merchants/answer/7052112, read 2026-10-16): title 150, description 5000, brand 70, mpn 70, product
 * type 750, custom label 100, colour 100, size 100, material 200, pattern 100, product highlight 150, image link 2000, up
 * to 10 additional images, GTIN up to 14 digits (up to 10 GTINs; Nexus sends one or more), shipping and return policy
 * label 100. NOT here, on purpose: price, sale price and availability (they must match the shop's landing page; Nexus sets
 * prices and stock in Nexus, from where they reach the shop and its Google feed), link / mobile link / ads redirect (where
 * a buyer lands), item group id (variant grouping).
 */
export type MerchantAttributeSpec =
  | { kind: 'text'; max: number }
  | { kind: 'texts'; max: number; items: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'enums'; values: readonly string[]; items: number }
  | { kind: 'url' }
  | { kind: 'urls'; items: number }
  | { kind: 'bool' }
  | { kind: 'gtins' }
  | { kind: 'countries' }

/** Marketing methods a product may be excluded from or included in (ProductAttributes.excludedDestinations' enum, the ones a shop uses). */
export const PRODUCT_DESTINATIONS = [
  'SHOPPING_ADS', 'DISPLAY_ADS', 'LOCAL_INVENTORY_ADS', 'FREE_LISTINGS', 'FREE_LOCAL_LISTINGS', 'YOUTUBE_SHOPPING',
  'YOUTUBE_SHOPPING_CHECKOUT', 'YOUTUBE_AFFILIATE', 'CLOUD_RETAIL', 'LOCAL_CLOUD_RETAIL',
] as const

export const MERCHANT_PRODUCT_ATTRIBUTES: Readonly<Record<string, MerchantAttributeSpec>> = {
  title: { kind: 'text', max: 150 },
  description: { kind: 'text', max: 5000 },
  brand: { kind: 'text', max: 70 },
  gtins: { kind: 'gtins' },
  mpn: { kind: 'text', max: 70 },
  identifierExists: { kind: 'bool' },
  googleProductCategory: { kind: 'text', max: 750 },
  productTypes: { kind: 'texts', max: 750, items: 10 },
  customLabel0: { kind: 'text', max: 100 },
  customLabel1: { kind: 'text', max: 100 },
  customLabel2: { kind: 'text', max: 100 },
  customLabel3: { kind: 'text', max: 100 },
  customLabel4: { kind: 'text', max: 100 },
  color: { kind: 'text', max: 100 },
  size: { kind: 'text', max: 100 },
  sizeSystem: { kind: 'enum', values: ['AU', 'BR', 'CN', 'DE', 'EU', 'FR', 'IT', 'JP', 'MEX', 'UK', 'US'] },
  sizeTypes: { kind: 'enums', values: ['REGULAR', 'PETITE', 'MATERNITY', 'BIG', 'TALL', 'PLUS'], items: 2 },
  gender: { kind: 'enum', values: ['MALE', 'FEMALE', 'UNISEX'] },
  ageGroup: { kind: 'enum', values: ['ADULT', 'KIDS', 'TODDLER', 'INFANT', 'NEWBORN'] },
  material: { kind: 'text', max: 200 },
  pattern: { kind: 'text', max: 100 },
  condition: { kind: 'enum', values: ['NEW', 'USED', 'REFURBISHED'] },
  productHighlights: { kind: 'texts', max: 150, items: 10 },
  imageLink: { kind: 'url' },
  additionalImageLinks: { kind: 'urls', items: 10 },
  excludedDestinations: { kind: 'enums', values: PRODUCT_DESTINATIONS, items: PRODUCT_DESTINATIONS.length },
  includedDestinations: { kind: 'enums', values: PRODUCT_DESTINATIONS, items: PRODUCT_DESTINATIONS.length },
  shoppingAdsExcludedCountries: { kind: 'countries' },
  pause: { kind: 'enum', values: ['ADS', 'ALL'] },
  shippingLabel: { kind: 'text', max: 100 },
  returnPolicyLabel: { kind: 'text', max: 100 },
}

export const OFFER_ID_RE = /^\S(?:.{0,48}\S)?$/
export const LANGUAGE_RE = /^[a-z]{2}$/
export const FEED_LABEL_RE = /^[A-Z0-9_-]{1,20}$/
export const COUNTRY_RE = /^[A-Z]{2}$/
const GTIN_RE = /^\d{8,14}$/
const URL_RE = /^https?:\/\/[^\s]{1,1990}$/

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const onlyKeys = (o: Json, allowed: readonly string[]): string[] => Object.keys(o).filter((k) => !allowed.includes(k))
const text = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const oneLine = (v: unknown, max: number): boolean => text(v, max) && !/[\r\n]/.test(v as string)

/** Why one attribute value is refused, or null when it is one Nexus sends. */
export function attributeProblem(name: string, value: unknown): string | null {
  const spec = MERCHANT_PRODUCT_ATTRIBUTES[name]
  if (!spec) return `${name} is not an attribute Nexus sends`
  const list = (items: number, each: (v: unknown) => boolean) => Array.isArray(value) && value.length > 0 && value.length <= items && value.every(each) && new Set(value).size === value.length
  switch (spec.kind) {
    case 'text': return (name === 'description' ? text(value, spec.max) : oneLine(value, spec.max)) ? null : `${name} is not 1 to ${spec.max} characters`
    case 'texts': return list(spec.items, (v) => oneLine(v, spec.max)) ? null : `${name} is not 1 to ${spec.items} texts of up to ${spec.max} characters`
    case 'enum': return spec.values.includes(value as string) ? null : `${name} is not one of ${spec.values.join(', ')}`
    case 'enums': return list(spec.items, (v) => spec.values.includes(v as string)) ? null : `${name} is not 1 to ${spec.items} of ${spec.values.join(', ')}`
    case 'url': return typeof value === 'string' && URL_RE.test(value) ? null : `${name} is not an http(s) link of up to 2000 characters`
    case 'urls': return list(spec.items, (v) => typeof v === 'string' && URL_RE.test(v)) ? null : `${name} is not 1 to ${spec.items} http(s) links`
    case 'bool': return typeof value === 'boolean' ? null : `${name} is not true or false`
    case 'gtins': return list(10, (v) => typeof v === 'string' && GTIN_RE.test(v)) ? null : `${name} is not 1 to 10 GTINs of 8 to 14 digits`
    case 'countries': return list(50, (v) => typeof v === 'string' && COUNTRY_RE.test(v)) ? null : `${name} is not 1 to 50 two-letter country codes`
  }
}

function productInputProblem(body: Json): string | null {
  const extra = onlyKeys(body, ['offerId', 'contentLanguage', 'feedLabel', 'productAttributes'])
  if (extra.length) return `the product input names ${extra.join(', ')}`
  if (typeof body.offerId !== 'string' || !OFFER_ID_RE.test(body.offerId)) return 'the offer id is not 1 to 50 characters'
  if (typeof body.contentLanguage !== 'string' || !LANGUAGE_RE.test(body.contentLanguage)) return 'the language is not a two-letter code'
  if (typeof body.feedLabel !== 'string' || !FEED_LABEL_RE.test(body.feedLabel)) return 'the feed label is not 1 to 20 of A-Z, 0-9, - and _'
  const attributes = body.productAttributes
  if (!isObject(attributes) || !Object.keys(attributes).length) return 'the product input holds no attribute'
  for (const [name, value] of Object.entries(attributes)) {
    const problem = attributeProblem(name, value)
    if (problem) return problem
  }
  return null
}

// ── data sources ───────────────────────────────────────────────────────────────────────────────────────────────

const DISPLAY_NAME_MAX = 200

function labelLanguage(o: Json, required: boolean): string | null {
  const has = o.feedLabel !== undefined || o.contentLanguage !== undefined
  if (!has) return required ? 'it has no feed label and language' : null
  if (typeof o.feedLabel !== 'string' || !FEED_LABEL_RE.test(o.feedLabel)) return 'the feed label is not 1 to 20 of A-Z, 0-9, - and _'
  if (typeof o.contentLanguage !== 'string' || !LANGUAGE_RE.test(o.contentLanguage)) return 'the language is not a two-letter code'
  return null
}

function createProblem(body: Json): string | null {
  const kinds = ['supplementalProductDataSource', 'promotionDataSource'].filter((k) => k in body)
  if (onlyKeys(body, ['displayName', 'supplementalProductDataSource', 'promotionDataSource']).length || kinds.length !== 1) {
    return 'Nexus makes a supplemental product data source or a promotion data source only, with its name and nothing else'
  }
  if (!oneLine(body.displayName, DISPLAY_NAME_MAX)) return `the data source name is not 1 to ${DISPLAY_NAME_MAX} characters on one line`
  const inner = body[kinds[0]]
  if (!isObject(inner)) return 'the data source settings are not an object'
  if (kinds[0] === 'supplementalProductDataSource') {
    if (onlyKeys(inner, ['feedLabel', 'contentLanguage']).length) return 'a supplemental data source names its feed label and language only'
    return labelLanguage(inner, false)
  }
  if (onlyKeys(inner, ['targetCountry', 'contentLanguage']).length) return 'a promotion data source names its country and language only'
  if (typeof inner.targetCountry !== 'string' || !COUNTRY_RE.test(inner.targetCountry)) return 'the promotion country is not a two-letter code'
  return typeof inner.contentLanguage === 'string' && LANGUAGE_RE.test(inner.contentLanguage) ? null : 'the language is not a two-letter code'
}

function patchProblem(call: MerchantCall, body: Json): string | null {
  if (body.name !== `accounts/${call.account}/dataSources/${call.dataSource}`) return 'the body does not name the data source in the path'
  if (call.updateMask !== 'displayName') return 'the data source field it changes is not one Nexus changes'
  if (onlyKeys(body, ['name', 'displayName']).length) return 'a rename names the data source and its new name only'
  return oneLine(body.displayName, DISPLAY_NAME_MAX) ? null : `the data source name is not 1 to ${DISPLAY_NAME_MAX} characters on one line`
}

// ── promotions ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PROMOTION_ID_RE = /^[A-Za-z0-9_-]{1,50}$/
/** The promotion types Nexus sends (Attributes.couponValueType). */
export const COUPON_VALUE_TYPES = ['PERCENT_OFF', 'MONEY_OFF', 'FREE_SHIPPING_STANDARD'] as const
export const PROMOTION_DESTINATIONS = ['SHOPPING_ADS', 'FREE_LISTINGS'] as const
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const CURRENCY_RE = /^[A-Z]{3}$/

const priceProblem = (v: unknown, what: string): string | null =>
  isObject(v) && !onlyKeys(v, ['amountMicros', 'currencyCode']).length && typeof v.amountMicros === 'string' && /^\d{1,15}$/.test(v.amountMicros)
    && Number(v.amountMicros) > 0 && Number(v.amountMicros) % 10_000 === 0 && typeof v.currencyCode === 'string' && CURRENCY_RE.test(v.currencyCode)
    ? null : `${what} is not whole cents (amountMicros) with a currency`

const intervalProblem = (v: unknown, what: string): string | null => {
  if (!isObject(v) || onlyKeys(v, ['startTime', 'endTime']).length) return `${what} is not a start and an end`
  if (typeof v.startTime !== 'string' || !TIMESTAMP_RE.test(v.startTime) || typeof v.endTime !== 'string' || !TIMESTAMP_RE.test(v.endTime)) return `${what} is not two UTC times`
  return Date.parse(v.startTime) < Date.parse(v.endTime) ? null : `${what} does not end after it starts`
}

const idList = (v: unknown, max: number, re: RegExp | null, maxLength: number) =>
  Array.isArray(v) && v.length > 0 && v.length <= max && v.every((x) => typeof x === 'string' && (re ? re.test(x) : oneLine(x, maxLength))) && new Set(v).size === v.length

function promotionProblem(call: MerchantCall, body: Json): string | null {
  if (onlyKeys(body, ['promotion', 'dataSource']).length) return 'it names more than the promotion and its data source'
  const ref = dataSourceRef(call.account).exec(typeof body.dataSource === 'string' ? body.dataSource : '')
  if (!ref) return 'it does not name a data source of this account'
  const p = body.promotion
  if (!isObject(p)) return 'it holds no promotion'
  if (onlyKeys(p, ['promotionId', 'contentLanguage', 'targetCountry', 'redemptionChannel', 'attributes']).length) return 'the promotion names a field Nexus does not send'
  if (typeof p.promotionId !== 'string' || !PROMOTION_ID_RE.test(p.promotionId)) return 'the promotion id is not 1 to 50 of A-Z, a-z, 0-9, - and _'
  if (typeof p.contentLanguage !== 'string' || !LANGUAGE_RE.test(p.contentLanguage)) return 'the language is not a two-letter code'
  if (typeof p.targetCountry !== 'string' || !COUNTRY_RE.test(p.targetCountry)) return 'the country is not a two-letter code'
  if (!Array.isArray(p.redemptionChannel) || p.redemptionChannel.length !== 1 || p.redemptionChannel[0] !== 'ONLINE') return 'Nexus sends online promotions only (redemptionChannel ONLINE)'
  const a = p.attributes
  if (!isObject(a)) return 'the promotion has no attributes'
  const allowed = ['longTitle', 'couponValueType', 'percentOff', 'moneyOffAmount', 'minimumPurchaseAmount', 'offerType', 'genericRedemptionCode',
    'productApplicability', 'itemIdInclusion', 'itemIdExclusion', 'brandInclusion', 'productTypeInclusion', 'promotionEffectiveTimePeriod',
    'promotionDisplayTimePeriod', 'promotionDestinations', 'promotionUrl']
  const extra = onlyKeys(a, allowed)
  if (extra.length) return `the promotion names ${extra.join(', ')}`
  if (!oneLine(a.longTitle, 60)) return 'the promotion title is not 1 to 60 characters'
  if (!(COUPON_VALUE_TYPES as readonly unknown[]).includes(a.couponValueType)) return `the promotion type is not ${COUPON_VALUE_TYPES.join(', ')}`
  if (a.couponValueType === 'PERCENT_OFF' && !(typeof a.percentOff === 'string' && /^\d{1,2}$/.test(a.percentOff) && Number(a.percentOff) >= 1)) return 'a percent off is a whole 1 to 99'
  if (a.couponValueType !== 'PERCENT_OFF' && a.percentOff !== undefined) return 'only a percent off names a percent'
  if (a.couponValueType === 'MONEY_OFF') {
    const money = priceProblem(a.moneyOffAmount, 'the money off')
    if (money) return money
  } else if (a.moneyOffAmount !== undefined) return 'only a money off names an amount off'
  if (a.minimumPurchaseAmount !== undefined) {
    const minimum = priceProblem(a.minimumPurchaseAmount, 'the minimum purchase')
    if (minimum) return minimum
  }
  if (a.offerType !== 'NO_CODE' && a.offerType !== 'GENERIC_CODE') return 'the offer type is not NO_CODE or GENERIC_CODE'
  if (a.offerType === 'GENERIC_CODE' ? !(typeof a.genericRedemptionCode === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(a.genericRedemptionCode)) : a.genericRedemptionCode !== undefined) {
    return 'a code is 1 to 20 of A-Z, a-z, 0-9, - and _, with offer type GENERIC_CODE only'
  }
  // Google's promotions data specification: "All shipping promotions must include a valid redemption code".
  if (a.couponValueType === 'FREE_SHIPPING_STANDARD' && a.offerType !== 'GENERIC_CODE') return 'a free shipping promotion needs a code (Google\'s rule)'
  if (a.productApplicability !== 'ALL_PRODUCTS' && a.productApplicability !== 'SPECIFIC_PRODUCTS') return 'the products are not ALL_PRODUCTS or SPECIFIC_PRODUCTS'
  const filters = ['itemIdInclusion', 'itemIdExclusion', 'brandInclusion', 'productTypeInclusion'].filter((k) => a[k] !== undefined)
  if (a.productApplicability === 'ALL_PRODUCTS' && filters.length) return 'a promotion for all products names no product filter'
  if (a.productApplicability === 'SPECIFIC_PRODUCTS' && !filters.some((k) => k !== 'itemIdExclusion')) return 'a promotion for specific products names which (items, brands or product types)'
  if (a.itemIdInclusion !== undefined && !idList(a.itemIdInclusion, 250, null, 50)) return 'the items are not 1 to 250 offer ids of up to 50 characters'
  if (a.itemIdExclusion !== undefined && !idList(a.itemIdExclusion, 250, null, 50)) return 'the excluded items are not 1 to 250 offer ids of up to 50 characters'
  if (a.brandInclusion !== undefined && !idList(a.brandInclusion, 50, null, 70)) return 'the brands are not 1 to 50 of up to 70 characters'
  if (a.productTypeInclusion !== undefined && !idList(a.productTypeInclusion, 50, null, 750)) return 'the product types are not 1 to 50 of up to 750 characters'
  const effective = intervalProblem(a.promotionEffectiveTimePeriod, 'the promotion period')
  if (effective) return effective
  if (a.promotionDisplayTimePeriod !== undefined) {
    const display = intervalProblem(a.promotionDisplayTimePeriod, 'the display period')
    if (display) return display
  }
  if (!idList(a.promotionDestinations, PROMOTION_DESTINATIONS.length, null, 40) || !(a.promotionDestinations as unknown[]).every((d) => (PROMOTION_DESTINATIONS as readonly unknown[]).includes(d))) {
    return `the destinations are not ${PROMOTION_DESTINATIONS.join(' and/or ')}`
  }
  if (a.promotionUrl !== undefined && !(typeof a.promotionUrl === 'string' && /^https:\/\/[^\s]{1,1990}$/.test(a.promotionUrl))) return 'the promotion page is not an https link'
  const currencies = [a.moneyOffAmount, a.minimumPurchaseAmount].filter(isObject).map((m) => m.currencyCode)
  return new Set(currencies).size > 1 ? 'the amounts are in more than one currency' : null
}

/** Whether any key, at any depth, is in snake_case. */
function snakeKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(snakeKey)
  if (!isObject(v)) return false
  return Object.entries(v).some(([k, x]) => k.includes('_') || snakeKey(x))
}

/**
 * A Merchant change's body as the gateway judges it, or why it is refused. The parsed body is what is sent (null: the
 * method takes no body). A body the methods without one carry is refused; a field in snake_case is refused (Google reads
 * both spellings, so a second spelling could slip past this check).
 */
export function googleMerchantCallBodyOf(call: MerchantCall, body: unknown): { body: string | null } | { refusal: string } {
  if (call.kind === 'productInputs:delete' || call.kind === 'dataSources:delete') {
    return body === null || body === undefined || body === '' ? { body: null } : { refusal: 'a delete carries no body' }
  }
  if (typeof body !== 'string') return { refusal: 'the body is not JSON text' }
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return { refusal: 'the body is not JSON' } }
  if (!isObject(parsed)) return { refusal: 'the body is not a JSON object' }
  if (snakeKey(parsed)) return { refusal: 'the body names a field in snake_case' }
  let problem: string | null
  switch (call.kind) {
    case 'productInputs:insert': problem = productInputProblem(parsed); break
    case 'dataSources:create': problem = createProblem(parsed); break
    case 'dataSources:patch': problem = patchProblem(call, parsed); break
    case 'dataSources:fetch': problem = Object.keys(parsed).length ? 'a fetch carries an empty body' : null; break
    case 'promotions:insert': problem = promotionProblem(call, parsed); break
  }
  return problem ? { refusal: problem } : { body: JSON.stringify(parsed) }
}
