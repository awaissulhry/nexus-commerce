/**
 * Google Ads programme 2, G12 (2026-10-16) — Merchant Center read LIVE through the Merchant API v1: products with their
 * status per destination and country and their issues, the account's issues and its product counts, data sources (with
 * their rules, inputs and the last fetch), promotions, a product's local and regional inventory, and product performance
 * (the Merchant reports). Every read goes through the gateway to the account the business chose (client.ts).
 *
 * Checked 2026-10-16 with curl of developers.google.com/merchant/api/reference/rest and the discovery documents
 * (https://merchantapi.googleapis.com/$discovery/rest?version=<sub-API>):
 *   GET  products/v1/accounts/{a}/products?pageSize (max 1000)          ListProductsResponse { products[] Product, nextPageToken }
 *   GET  products/v1/accounts/{a}/products/{product}                    Product { name, offerId, contentLanguage, feedLabel,
 *        dataSource (its PRIMARY data source), productAttributes, productStatus { destinationStatuses[] { reportingContext,
 *        approvedCountries, pendingCountries, disapprovedCountries }, itemLevelIssues[] { code, severity NOT_IMPACTED |
 *        DEMOTED | DISAPPROVED, resolution, attribute, reportingContext, description, detail, documentation,
 *        applicableCountries }, googleExpirationDate } } — {product}: the unpadded base64url of contentLanguage~feedLabel~offerId
 *   GET  accounts/v1/accounts/{a}/issues?pageSize (max 100)             { accountIssues[] { title, severity CRITICAL | ERROR |
 *        SUGGESTION, detail, documentationUri, impactedDestinations[] { reportingContext, impacts[] { regionCode, severity } } } }
 *   GET  issueresolution/v1/accounts/{a}/aggregateProductStatuses       { aggregateProductStatuses[] { reportingContext, country,
 *        stats { activeCount, pendingCount, disapprovedCount, expiringCount }, itemLevelIssues[] { …, productCount } } }
 *   GET  datasources/v1/accounts/{a}/dataSources?pageSize (max 1000)    DataSource { dataSourceId, displayName, input API | FILE |
 *        UI | AUTOFEED, primaryProductDataSource { feedLabel, contentLanguage, countries, destinations, defaultRule {
 *        takeFromDataSources[] { self | supplementalDataSourceName } } } | supplementalProductDataSource { feedLabel,
 *        contentLanguage, referencingPrimaryDataSources[] } | promotionDataSource { targetCountry, contentLanguage } |
 *        localInventoryDataSource | regionalInventoryDataSource | productReviewDataSource | merchantReviewDataSource,
 *        fileInput { fileName, fileInputType, fetchSettings { enabled, frequency, fetchUri, … } } }
 *   GET  datasources/v1/accounts/{a}/dataSources/{d}/fileUploads/latest FileUpload { processingState, itemsTotal, itemsCreated,
 *        itemsUpdated, uploadTime, issues[] { title, description, severity, count, code } } (file data sources only)
 *   GET  promotions/v1/accounts/{a}/promotions?pageSize (max 250)       Promotion { name, promotionId, contentLanguage, targetCountry,
 *        redemptionChannel, dataSource, attributes, promotionStatus { destinationStatuses[] { reportingContext, status IN_REVIEW
 *        | REJECTED | LIVE | STOPPED | EXPIRED | PENDING }, itemLevelIssues[] } }
 *   GET  inventories/v1/accounts/{a}/products/{p}/localInventories      { localInventories[] { storeCode, localInventoryAttributes } }
 *   GET  inventories/v1/accounts/{a}/products/{p}/regionalInventories   { regionalInventories[] { region, regionalInventoryAttributes } }
 *   POST reports/v1/accounts/{a}/reports:search  { query, pageSize }    MCQL (guides/reports/query-language): product_performance_view
 *        offer_id, title, marketing_method ORGANIC | ADS, impressions, clicks, click_through_rate; WHERE date BETWEEN is required.
 *        conversions and conversion_value are left out: Google gives them for the free (organic) traffic only.
 */
import { merchantList, merchantRead, type MerchantAccount } from './client.js'

type Json = Record<string, any>
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null)
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : 0)
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const idOf = (name: unknown): string | null => { const s = str(name); return s ? s.slice(s.lastIndexOf('/') + 1) : null }

/** A product's key as Merchant Center names it: contentLanguage~feedLabel~offerId. */
export const productKey = (contentLanguage: string, feedLabel: string, offerId: string): string => `${contentLanguage}~${feedLabel}~${offerId}`
/** The encoded {product} / {productInput} segment Google recommends (unpadded base64url of the key). */
export const encodedKey = (key: string): string => Buffer.from(key, 'utf8').toString('base64url')

/** A price as Nexus shows it: cents and the currency (whole cents; Google's micros / 10,000, rounded). */
export function priceOf(p: unknown): { cents: number; currency: string } | null {
  const o = (p ?? {}) as Json
  const micros = str(o.amountMicros)
  const currency = str(o.currencyCode)
  return micros !== null && currency ? { cents: Math.round(Number(micros) / 10_000), currency } : null
}

// ── products ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface MerchantStatus { context: string; approved: string[]; pending: string[]; disapproved: string[] }
export interface MerchantIssue {
  code: string | null; severity: string | null; attribute: string | null; context: string | null; countries: string[]
  description: string | null; detail: string | null; resolution: string | null; documentation: string | null
}
export interface MerchantProductRow {
  key: string; offerId: string; contentLanguage: string; feedLabel: string
  title: string | null; brand: string | null; price: { cents: number; currency: string } | null; availability: string | null
  /** The product's PRIMARY data source (its id). */
  dataSourceId: string | null
  customLabels: Record<string, string>
  pause: string | null
  status: MerchantStatus[]
  issues: MerchantIssue[]
  expires: string | null
}

export const issueOf = (i: Json): MerchantIssue => ({
  code: str(i.code), severity: str(i.severity), attribute: str(i.attribute), context: str(i.reportingContext), countries: list(i.applicableCountries),
  description: str(i.description), detail: str(i.detail), resolution: str(i.resolution), documentation: str(i.documentation ?? i.documentationUri),
})

export function productRowOf(p: Json): MerchantProductRow | null {
  const offerId = str(p.offerId)
  const contentLanguage = str(p.contentLanguage)
  const feedLabel = str(p.feedLabel)
  if (!offerId || !contentLanguage || !feedLabel) return null
  const a = (p.productAttributes ?? {}) as Json
  const status = (p.productStatus ?? {}) as Json
  const customLabels: Record<string, string> = {}
  for (const n of [0, 1, 2, 3, 4]) { const v = str(a[`customLabel${n}`]); if (v) customLabels[`customLabel${n}`] = v }
  return {
    key: productKey(contentLanguage, feedLabel, offerId), offerId, contentLanguage, feedLabel,
    title: str(a.title), brand: str(a.brand), price: priceOf(a.price), availability: str(a.availability),
    dataSourceId: idOf(p.dataSource), customLabels, pause: str(a.pause),
    status: (Array.isArray(status.destinationStatuses) ? status.destinationStatuses as Json[] : []).map((d) => ({
      context: str(d.reportingContext) ?? 'UNKNOWN', approved: list(d.approvedCountries), pending: list(d.pendingCountries), disapproved: list(d.disapprovedCountries),
    })),
    issues: (Array.isArray(status.itemLevelIssues) ? status.itemLevelIssues as Json[] : []).map(issueOf),
    expires: str(status.googleExpirationDate),
  }
}

/** How a product stands, in one word: disapproved somewhere, pending somewhere, approved, or not shown anywhere. */
export function productVerdict(row: Pick<MerchantProductRow, 'status'>): 'disapproved' | 'pending' | 'approved' | 'none' {
  if (row.status.some((s) => s.disapproved.length)) return 'disapproved'
  if (row.status.some((s) => s.pending.length)) return 'pending'
  return row.status.some((s) => s.approved.length) ? 'approved' : 'none'
}

/** At most 1000 products are read per call (one page, Google's largest). */
export const MAX_PRODUCTS = 1000

export async function liveProducts(account: MerchantAccount, maxItems = MAX_PRODUCTS): Promise<{ rows: MerchantProductRow[]; more: boolean }> {
  const { items, more } = await merchantList(account, 'merchant.products.list', `products/v1/accounts/${account.merchantCenterId}/products`, 'products', { pageSize: Math.min(1000, maxItems), maxItems })
  return { rows: items.map(productRowOf).filter((r): r is MerchantProductRow => r !== null), more }
}

/** One processed product (raw, as Google gives it), or null when Merchant Center has none with this key. */
export async function liveProduct(account: MerchantAccount, key: string): Promise<Json | null> {
  return merchantRead(account, 'merchant.products.get', `products/v1/accounts/${account.merchantCenterId}/products/${encodedKey(key)}`, { notFound: 'null' })
}

// ── the account ────────────────────────────────────────────────────────────────────────────────────────────────

export interface MerchantAccountIssue { title: string | null; severity: string | null; detail: string | null; documentation: string | null; where: Array<{ context: string | null; regions: string[] }> }

export async function liveAccountIssues(account: MerchantAccount): Promise<MerchantAccountIssue[]> {
  const { items } = await merchantList(account, 'merchant.accounts.issues.list', `accounts/v1/accounts/${account.merchantCenterId}/issues`, 'accountIssues', { pageSize: 100, maxItems: 300, query: { languageCode: 'en-US' } })
  return items.map((i) => ({
    title: str(i.title), severity: str(i.severity), detail: str(i.detail), documentation: str(i.documentationUri),
    where: (Array.isArray(i.impactedDestinations) ? i.impactedDestinations as Json[] : []).map((d) => ({
      context: str(d.reportingContext), regions: (Array.isArray(d.impacts) ? d.impacts as Json[] : []).map((x) => str(x.regionCode)).filter((x): x is string => !!x),
    })),
  }))
}

export interface MerchantAggregate {
  context: string | null; country: string | null; active: number; pending: number; disapproved: number; expiring: number
  issues: Array<MerchantIssue & { products: number }>
}

export async function liveAggregateStatuses(account: MerchantAccount): Promise<MerchantAggregate[]> {
  const { items } = await merchantList(account, 'merchant.aggregateProductStatuses.list', `issueresolution/v1/accounts/${account.merchantCenterId}/aggregateProductStatuses`, 'aggregateProductStatuses', { pageSize: 250, maxItems: 1000 })
  return items.map((s) => {
    const stats = (s.stats ?? {}) as Json
    return {
      context: str(s.reportingContext), country: str(s.country),
      active: num(stats.activeCount), pending: num(stats.pendingCount), disapproved: num(stats.disapprovedCount), expiring: num(stats.expiringCount),
      issues: (Array.isArray(s.itemLevelIssues) ? s.itemLevelIssues as Json[] : []).map((i) => ({ ...issueOf(i), products: num(i.productCount) })),
    }
  })
}

// ── data sources ───────────────────────────────────────────────────────────────────────────────────────────────

export type DataSourceType = 'primary' | 'supplemental' | 'promotion' | 'local-inventory' | 'regional-inventory' | 'product-review' | 'merchant-review' | 'other'

export interface MerchantDataSource {
  dataSourceId: string
  displayName: string | null
  /** API | FILE | UI | AUTOFEED */
  input: string | null
  type: DataSourceType
  feedLabel: string | null
  contentLanguage: string | null
  /** primary: its default countries; promotion: its one country. */
  countries: string[]
  /** primary: the marketing methods and their state. */
  destinations: Array<{ destination: string; state: string | null }>
  /** primary: its default rule, in order: 'self' or a supplemental data source id. */
  defaultRule: string[]
  /** supplemental: the primary data sources that link it (in a default or a custom rule). */
  linkedFrom: string[]
  /** A file data source: its file and fetch schedule (the fetch link's host only: a link may carry a secret). */
  file: { fileName: string | null; type: string | null; fetchEnabled: boolean | null; frequency: string | null; fetchHost: string | null } | null
}

const TYPE_KEYS: Array<[string, DataSourceType]> = [
  ['primaryProductDataSource', 'primary'], ['supplementalProductDataSource', 'supplemental'], ['promotionDataSource', 'promotion'],
  ['localInventoryDataSource', 'local-inventory'], ['regionalInventoryDataSource', 'regional-inventory'],
  ['productReviewDataSource', 'product-review'], ['merchantReviewDataSource', 'merchant-review'],
]

const hostOf = (link: unknown): string | null => { try { return new URL(String(link)).host || null } catch { return null } }

export function dataSourceOf(d: Json): MerchantDataSource | null {
  const dataSourceId = str(d.dataSourceId) ?? idOf(d.name)
  if (!dataSourceId) return null
  const found = TYPE_KEYS.find(([k]) => d[k] && typeof d[k] === 'object')
  const inner = (found ? d[found[0]] : {}) as Json
  const type = found?.[1] ?? 'other'
  const fetch = (d.fileInput?.fetchSettings ?? null) as Json | null
  return {
    dataSourceId, displayName: str(d.displayName), input: str(d.input), type,
    feedLabel: str(inner.feedLabel), contentLanguage: str(inner.contentLanguage),
    countries: type === 'promotion' ? list([inner.targetCountry]) : list(inner.countries),
    destinations: (Array.isArray(inner.destinations) ? inner.destinations as Json[] : []).map((x) => ({ destination: str(x.destination) ?? 'UNKNOWN', state: str(x.state) })),
    defaultRule: (Array.isArray(inner.defaultRule?.takeFromDataSources) ? inner.defaultRule.takeFromDataSources as Json[] : [])
      .map((x) => (x.self === true ? 'self' : idOf(x.supplementalDataSourceName ?? x.primaryDataSourceName)))
      .filter((x): x is string => !!x),
    linkedFrom: (Array.isArray(inner.referencingPrimaryDataSources) ? inner.referencingPrimaryDataSources as Json[] : [])
      .map((x) => idOf(x.primaryDataSourceName ?? x.supplementalDataSourceName)).filter((x): x is string => !!x),
    file: d.fileInput ? {
      fileName: str(d.fileInput.fileName), type: str(d.fileInput.fileInputType),
      fetchEnabled: typeof fetch?.enabled === 'boolean' ? fetch.enabled : null, frequency: str(fetch?.frequency), fetchHost: hostOf(fetch?.fetchUri),
    } : null,
  }
}

export async function liveDataSources(account: MerchantAccount): Promise<MerchantDataSource[]> {
  const { items } = await merchantList(account, 'merchant.dataSources.list', `datasources/v1/accounts/${account.merchantCenterId}/dataSources`, 'dataSources', { pageSize: 1000, maxItems: 1000 })
  return items.map(dataSourceOf).filter((d): d is MerchantDataSource => d !== null)
}

export interface MerchantFileUpload {
  state: string | null; uploadedAt: string | null; total: number; created: number; updated: number
  issues: Array<{ title: string | null; severity: string | null; count: number; description: string | null }>
}

/** The last fetch or upload of a FILE data source (null when Google has none). */
export async function liveFileUpload(account: MerchantAccount, dataSourceId: string): Promise<MerchantFileUpload | null> {
  const u = await merchantRead(account, 'merchant.fileUploads.get', `datasources/v1/accounts/${account.merchantCenterId}/dataSources/${dataSourceId}/fileUploads/latest`, { notFound: 'null' })
  if (!u) return null
  return {
    state: str(u.processingState), uploadedAt: str(u.uploadTime), total: num(u.itemsTotal), created: num(u.itemsCreated), updated: num(u.itemsUpdated),
    issues: (Array.isArray(u.issues) ? u.issues as Json[] : []).slice(0, 10).map((i) => ({ title: str(i.title), severity: str(i.severity), count: num(i.count), description: str(i.description) })),
  }
}

// ── promotions ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface MerchantPromotion {
  promotionId: string; contentLanguage: string | null; targetCountry: string | null; dataSourceId: string | null
  title: string | null; type: string | null; percentOff: number | null; moneyOff: { cents: number; currency: string } | null
  minimumPurchase: { cents: number; currency: string } | null; code: string | null; products: string | null
  starts: string | null; ends: string | null; destinations: string[]
  status: Array<{ context: string | null; status: string | null }>
  issues: MerchantIssue[]
}

export function promotionOf(p: Json): MerchantPromotion | null {
  const promotionId = str(p.promotionId)
  if (!promotionId) return null
  const a = (p.attributes ?? {}) as Json
  const s = (p.promotionStatus ?? {}) as Json
  return {
    promotionId, contentLanguage: str(p.contentLanguage), targetCountry: str(p.targetCountry), dataSourceId: idOf(p.dataSource),
    title: str(a.longTitle), type: str(a.couponValueType), percentOff: a.percentOff === undefined ? null : num(a.percentOff),
    moneyOff: priceOf(a.moneyOffAmount), minimumPurchase: priceOf(a.minimumPurchaseAmount), code: str(a.genericRedemptionCode),
    products: str(a.productApplicability), starts: str(a.promotionEffectiveTimePeriod?.startTime), ends: str(a.promotionEffectiveTimePeriod?.endTime),
    destinations: list(a.promotionDestinations),
    status: (Array.isArray(s.destinationStatuses) ? s.destinationStatuses as Json[] : []).map((d) => ({ context: str(d.reportingContext), status: str(d.status) })),
    issues: (Array.isArray(s.itemLevelIssues) ? s.itemLevelIssues as Json[] : []).map(issueOf),
  }
}

export async function livePromotions(account: MerchantAccount): Promise<MerchantPromotion[]> {
  const { items } = await merchantList(account, 'merchant.promotions.list', `promotions/v1/accounts/${account.merchantCenterId}/promotions`, 'promotions', { pageSize: 250, maxItems: 1000 })
  return items.map(promotionOf).filter((p): p is MerchantPromotion => p !== null)
}

// ── inventory ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface MerchantInventory {
  local: Array<{ storeCode: string | null; availability: string | null; quantity: number | null; price: { cents: number; currency: string } | null; salePrice: { cents: number; currency: string } | null; pickupMethod: string | null }>
  regional: Array<{ region: string | null; availability: string | null; price: { cents: number; currency: string } | null; salePrice: { cents: number; currency: string } | null }>
}

export async function liveInventory(account: MerchantAccount, key: string): Promise<MerchantInventory> {
  const product = `inventories/v1/accounts/${account.merchantCenterId}/products/${encodedKey(key)}`
  const [local, regional] = await Promise.all([
    merchantList(account, 'merchant.localInventories.list', `${product}/localInventories`, 'localInventories', { pageSize: 1000, maxItems: 1000 }),
    merchantList(account, 'merchant.regionalInventories.list', `${product}/regionalInventories`, 'regionalInventories', { pageSize: 1000, maxItems: 1000 }),
  ])
  return {
    local: local.items.map((i) => {
      const a = (i.localInventoryAttributes ?? {}) as Json
      return { storeCode: str(i.storeCode), availability: str(a.availability), quantity: a.quantity === undefined ? null : num(a.quantity), price: priceOf(a.price), salePrice: priceOf(a.salePrice), pickupMethod: str(a.pickupMethod) }
    }),
    regional: regional.items.map((i) => {
      const a = (i.regionalInventoryAttributes ?? {}) as Json
      return { region: str(i.region), availability: str(a.availability), price: priceOf(a.price), salePrice: priceOf(a.salePrice) }
    }),
  }
}

// ── performance (Merchant reports) ─────────────────────────────────────────────────────────────────────────────

export interface MerchantPerformanceRow { offerId: string | null; title: string | null; method: string | null; impressions: number; clicks: number; ctr: number }

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The MCQL of product performance between two days (Merchant Center's time zone), most clicks first. */
export function performanceQuery(from: string, to: string, limit: number): string {
  if (!DAY.test(from) || !DAY.test(to)) throw new Error('performanceQuery: days are YYYY-MM-DD')
  return 'SELECT offer_id, title, marketing_method, impressions, clicks, click_through_rate FROM product_performance_view '
    + `WHERE date BETWEEN '${from}' AND '${to}' ORDER BY clicks DESC LIMIT ${Math.max(1, Math.min(1000, Math.trunc(limit)))}`
}

export async function livePerformance(account: MerchantAccount, from: string, to: string, limit: number): Promise<MerchantPerformanceRow[]> {
  const answer = await merchantRead(account, 'merchant.reports.search', `reports/v1/accounts/${account.merchantCenterId}/reports:search`, { body: { query: performanceQuery(from, to, limit), pageSize: 1000 } }) ?? {}
  return (Array.isArray(answer.results) ? answer.results as Json[] : []).map((r) => {
    const v = (r.productPerformanceView ?? {}) as Json
    return { offerId: str(v.offerId), title: str(v.title), method: str(v.marketingMethod), impressions: num(v.impressions), clicks: num(v.clicks), ctr: num(v.clickThroughRate) }
  })
}
