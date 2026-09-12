/** Versioned interchange format. Values and inheritance are separate facts. */
export const CATALOG_TRANSFER_VERSION = 1
export const TRANSFER_CHANNELS: string[] = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY']
export const transferIsStore = (channel: string) => channel === 'SHOPIFY' || channel === 'ETSY'
export function transferCategoryField(channel: string): string {
  const field = ({ AMAZON: 'productType', EBAY: 'categoryId', SHOPIFY: 'category', ETSY: 'taxonomy_id' } as Record<string, string>)[channel]
  if (!field) throw new Error(`Unsupported product information channel: ${channel}`)
  return field
}
export const TRANSFER_COLUMNS = ['entity', 'sku', 'channel', 'accountId', 'marketplace', 'aliasKey', 'locale', 'field', 'action', 'format', 'value', 'version'] as const
export type TransferEntity = 'Products' | 'Listings' | 'Overrides'
export type TransferAction = 'SET' | 'CLEAR' | 'INHERIT'
export type TransferMode = 'create' | 'update' | 'upsert'
/** Product-editor selection. The server resolves IDs and freezes the resulting boundary on the job. */
export interface ProductTransferSelection {
  productIds: string[]
  includeShared: boolean
  listingIds: string[]
  locales: string[]
}
export interface ProductTransferBoundary {
  productId: string
  rootId: string
  products: { id: string; sku: string; parentId: string | null }[]
  includeShared: boolean
  listings: { id: string; productId: string; channel: string; accountId: string; marketplace: string; aliasKey: string; aliasLabel?: string }[]
  locales: string[]
}
export interface ProductTransferOptions {
  recentJobs?: { id: string; filename: string | null; state: string }[]
  familyId?: string | null
  productId: string
  rootId: string
  products: { id: string; sku: string; parentId: string | null }[]
  listings: ProductTransferBoundary['listings']
  locales: string[]
  accounts: { id: string; channelType: string; marketplace: string | null; displayName: string | null }[]
  markets: { channel: string; code: string; name: string; language: string }[]
}
export interface TransferRow {
  source?: { file?: string; sheet?: string; column?: string }
  row: number
  entity: TransferEntity
  sku: string
  channel: string
  accountId: string
  marketplace: string
  aliasKey: string
  locale: string
  field: string
  action: TransferAction
  value?: unknown
  version?: number
}
export interface TransferIssue { row: number; sku: string; field: string; message: string; source?: TransferRow['source'] }
export interface TransferCell extends TransferRow {
  label?: string
  effectiveBefore?: { value: unknown; source: string }
  effectiveAfter?: { value: unknown; source: string }
  before: unknown
  after: unknown
  beforeState: 'stored' | 'inherited'
  afterState: 'stored' | 'inherited'
  verdict: 'changed' | 'unchanged'
}
export interface TransferPreview {
  jobId: string
  mode: TransferMode
  state: string
  expiresAt: string
  cells: TransferCell[]
  issues: TransferIssue[]
  counts: { productsCreated: number; listingsCreated: number; changed: number; unchanged: number; refused: number }
  warnings: string[]
}
export const transferTargetKey = (row: Pick<TransferRow, 'entity' | 'sku' | 'channel' | 'accountId' | 'marketplace' | 'aliasKey'>): string =>
  JSON.stringify(row.entity === 'Products' ? ['Products', row.sku] : ['Listings', row.sku, row.channel, row.accountId, row.marketplace, row.aliasKey])

/** Structural equality keeps false, zero, null and empty strings distinct. */
export function transferCanonical(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(transferCanonical).join(',')}]`
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${transferCanonical((value as Record<string, unknown>)[k])}`).join(',')}}`
}

export function transferFileRow(row: TransferRow): Record<string, string> {
  return {
    entity: row.entity, sku: row.sku, channel: row.channel, accountId: row.accountId,
    marketplace: row.marketplace, aliasKey: row.aliasKey, locale: row.locale,
    field: row.field, action: row.action,
    format: row.action === 'SET' ? (typeof row.value === 'string' ? 'text' : 'json') : '',
    value: row.action === 'SET' ? (typeof row.value === 'string' ? row.value : JSON.stringify(row.value) ?? '') : '',
    version: row.version === undefined ? '' : String(row.version),
  }
}
