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
  /**
   * CFI (R-CFI-1) — the value was read from the channel's OWN file (an Amazon template or our eBay
   * workbook). It describes what the channel holds, so the planner may store a field that is
   * read-only on a live listing, the RRP (`list_price`), and the channel-file-only fields
   * `sellerSku` / `presence` (Listings) and `price` / `sale` (Overrides). Absent = an operator's file.
   */
  origin?: 'channel-file'
  /**
   * CFI Q1 — a blank cell of a FULL-update row: clear the market value only when Nexus's effective
   * value is not already empty. Only with `action: 'CLEAR'`; an already-empty value plans nothing.
   */
  clearIfPresent?: true
  /** CFI-4 — the SKU as written in the file, when the row was resolved to a different Nexus SKU. */
  fileSku?: string
  /**
   * A list field read from a channel's own template: how many columns the template gives it (Amazon's
   * `bullet_point` #1…#5). The planner keeps a longer Nexus list whose start the file restates in full.
   */
  listSlots?: number
  /**
   * PSIE — what the EXPORT held for this cell (its editing baseline), on a changed cell of a Nexus editing
   * file read in changes-only mode. The review compares it with the current value: a cell that also changed
   * in Nexus after the export is a problem for that cell only. `null` = the export held no value here.
   */
  expected?: { action: TransferAction; value: unknown } | null
}
export interface TransferIssue {
  row: number; sku: string; field: string; message: string; source?: TransferRow['source']
  /** CFI — a channel-file issue names the file's own SKU and the listing coordinate it concerns (e.g. an unconfirmed delete). */
  fileSku?: string; channel?: string; marketplace?: string; accountId?: string; aliasKey?: string
}
/**
 * CFI-8 (D7) — what the channel held at its last read (`ChannelDrift`). `differs: false` = the last
 * read recorded no difference from Nexus for this field; `readAt` is that read's time.
 */
export type TransferChannelRead =
  | { differs: true; value: unknown; ours: unknown; readAt: string; source: string }
  | { differs: false; readAt: string; source: string }
  /** The listing was read, but no read compares this field (e.g. Amazon RRP, images, parent links) — never "same". */
  | { notCompared: true; readAt: string }
export interface TransferCell extends TransferRow {
  label?: string
  channelRead?: TransferChannelRead
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

// ── PSIE — the product sheet's import: one engine, two buttons ──────────────────────────────────
// Import → drop a file → one summary → Apply → Done (with Undo). Only changed cells travel; a cell
// the file leaves as exported is never sent, checked or saved. Saving writes Nexus only: sending to
// the channels is its own step (the Owner's D1 (a), 2026-09-26).

export type SheetImportState = 'CHECKING' | 'READY' | 'SAVING' | 'DONE' | 'PARTIAL' | 'FAILED'
/** What the file was: our editing file, an older Nexus file, a channel's own file, a CSV, or an undo. */
export type SheetImportFormat = 'nexus' | 'nexus-legacy' | 'amazon' | 'ebay' | 'shopify' | 'csv' | 'undo'
export interface SheetImportSummary {
  /** Changed cells the import will save. */
  changes: number
  /** Cells (or rows) that cannot be saved, each with a reason. */
  problems: number
  /** Shared product records and listing records that change. */
  products: number
  listings: number
  /** Cells the file sets to the value Nexus already holds (a channel file restates everything). */
  unchanged: number
  /** Channel files only: listings the file creates or ends, and prices recorded without a push. */
  created: number
  ended: number
  prices: number
}
export interface SheetImportLink { fileSku: string; proposedSku: string; reason: string }
export interface SheetImportDelete { sku: string; fileSku: string; channel: string; marketplace: string; accountId: string; evidence?: string; confirmed: boolean }
export interface SheetImportStatus {
  jobId: string
  state: SheetImportState
  format: SheetImportFormat
  filename: string
  summary: SheetImportSummary
  warnings: string[]
  /** Records done / all records, for the progress bar while checking or saving. */
  processed: number
  total: number
  startedAt: string
  completedAt: string | null
  /** Present once the check is complete; Apply must send it back. */
  reviewToken?: string
  receipt?: { saved: number; failed: number; skipped: number }
  /** Channel files: identities and deletes the Owner must confirm (re-upload with the decisions). */
  links: SheetImportLink[]
  deletes: SheetImportDelete[]
  /** The destinations the file touches, in reading order: "Shared", "Amazon · IT", … */
  destinations: string[]
  /** Listings whose values changed (for the publish step). */
  listingIds: string[]
  undoOf?: string
  undoneBy?: string
  /** True when the import saved something that an undo can put back. */
  canUndo: boolean
  /**
   * The families' readiness, rebuilt right AFTER the save (the Owner's choice, 2026-09-26): `pending` while it runs,
   * `failed` when it could not (the next edit of the family rebuilds it). Absent when nothing was saved.
   */
  readiness?: 'pending' | 'done' | 'failed'
  /** Product families this import created besides the open product's (phase 2, 2026-10-01): the done screen offers to open them. */
  newFamilies?: { productId: string; sku: string }[]
  error?: string
}
/** `new` (2026-10-01): a product, variation, listing SKU or listing Apply makes, and the values of a listing it creates. */
export type SheetImportChangeStatus = 'ready' | 'new' | 'problem' | 'saved' | 'failed' | 'skipped'
export interface SheetImportChange {
  id: string
  sku: string
  /** "Shared", or "Amazon · IT" plus the listing label when the product has aliases. */
  destination: string
  entity: TransferEntity
  channel: string
  marketplace: string
  accountId: string
  aliasKey: string
  listing?: string
  locale: string
  field: string
  label: string
  before: unknown
  after: unknown
  beforeState: 'stored' | 'inherited'
  afterState: 'stored' | 'inherited'
  status: SheetImportChangeStatus
  problem?: string
  row?: number
  sheet?: string
  column?: string
}
export interface SheetImportChangesPage { changes: SheetImportChange[]; total: number; page: number; pageSize: number }
/** Typed in a cell of a Nexus file: empty the value / follow the shared value again. Case-insensitive. */
export const SHEET_CELL_MARKERS = { '#clear': 'CLEAR', '#shared': 'INHERIT' } as const satisfies Record<string, TransferAction>
export function sheetCellMarker(value: unknown): 'CLEAR' | 'INHERIT' | undefined {
  if (typeof value !== 'string') return undefined
  return (SHEET_CELL_MARKERS as Record<string, 'CLEAR' | 'INHERIT'>)[value.trim().toLowerCase()]
}
