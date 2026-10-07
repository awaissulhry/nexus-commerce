/**
 * eBay orders — the ONE transactional writer, shared by polling (EbayOrdersService) and stored
 * notification replay (cx/ingress/ebay-processing.ts, dormant until activation).
 *
 * Why it exists: ingestion used to insert the order and its lines, then deduct stock line by line
 * and SWALLOW any stock failure. The order and lines committed with no movement, and every later
 * poll skipped the line as already seen — a sale that never left the shelf. A failure inserting a
 * second line did the same to the first. Awaiting the old path from a webhook would only have
 * copied that defect.
 *
 * The rule here: the order row, every unseen line, and each line's stock effect commit together or
 * not at all. Only a typed insufficient-own-stock refusal (raised before that movement writes) is
 * an answer rather than a failure: the sale is real, so it is recorded with a durable `shortfall`
 * disposition and the owners are told in the same transaction. Everything that leaves the database
 * (queue pushes, the pool worker, events, customer cache, cancellation cascade, MCF) runs only
 * after the commit, best-effort, exactly as before.
 *
 * Stock timing is unchanged: a non-cancelled order takes stock when it is first ingested; an order
 * that arrives already cancelled never shipped and takes none.
 */
import type { Order, Prisma } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { afterStockMovementCommit, InsufficientStockError, type StockMovementTxResult } from './stock-movement.service.js'
import { takeOrderUnitsInTx } from './stock-level.service.js'
import { saleLocationInTx } from './stock/sale-location.service.js'
import { takeForOrderInTx } from './stock-pool/order-routing.js'
import { shouldPreserveTerminalStatus } from './order-status-guards.js'
import { ebaySellerIdentity } from './cx/ebay-identity.js'
import { raiseChannelAlertInTx } from './cx/channel-alerts.service.js'
import { StockLocationUnresolved } from './default-stock-location.js'
import { PooledProductError } from './stock-pool/pool-guard.js'
import { recordOrderItem } from './sales-aggregate.service.js'
import { orderRestorePending } from './order-cancellation/index.js'
import { matchInboundSku, type InboundSkuMatch } from './listings/channel-sku-inbound.js'

type Tx = Prisma.TransactionClient

/** eBay money fields: the live Fulfillment API sends { value, currency };
 *  older code/fixtures assumed bare strings. */
export type EbayAmountLike = string | number | { value?: string | number; currency?: string } | null | undefined

/** Pure — returns a finite number or null (never NaN). */
export function parseEbayAmount(raw: EbayAmountLike): number | null {
  if (raw === null || raw === undefined) return null
  const candidate = typeof raw === 'object' ? (raw as { value?: string | number }).value : raw
  if (candidate === null || candidate === undefined || candidate === '') return null
  const n = Number(candidate)
  return Number.isFinite(n) ? n : null
}

/** Currency code from an Amount-like, when present. */
export function ebayAmountCurrency(raw: EbayAmountLike): string | null {
  if (raw && typeof raw === 'object' && typeof raw.currency === 'string' && raw.currency) return raw.currency
  return null
}

/**
 * MAP.2 — the store an eBay order came from. A new order takes the importing store. An existing
 * order gains the link only when it has none; a DIFFERENT existing link is never overwritten.
 */
export function ebayOrderConnectionLink(
  existingConnectionId: string | null | undefined,
  importingConnectionId: string,
): { data: { channelConnectionId?: string }; conflict: boolean } {
  if (!existingConnectionId) return { data: { channelConnectionId: importingConnectionId }, conflict: false }
  return { data: {}, conflict: existingConnectionId !== importingConnectionId }
}

export type EbayOrderStatus = 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'CANCELLED' | 'DELIVERED'

/**
 * eBay's status taxonomy is coarser than ours; ambiguous states default to PENDING, and a more
 * specific fulfillment state wins. O.1: COMPLETED + NOT_STARTED = paid, ready to fulfil.
 */
export function mapEbayOrderStatus(ebayStatus: string, fulfillmentStatus: string): EbayOrderStatus {
  if (ebayStatus === 'CANCELLED' || ebayStatus === 'INACTIVE') return 'CANCELLED'
  if (fulfillmentStatus === 'FULFILLED') return 'DELIVERED'
  if (fulfillmentStatus === 'IN_PROGRESS') return 'SHIPPED'
  if (ebayStatus === 'COMPLETED' && fulfillmentStatus === 'NOT_STARTED') return 'PROCESSING'
  if (ebayStatus === 'COMPLETED') return 'SHIPPED'
  return 'PENDING'
}

/**
 * The one thing that refuses an order: without a usable order id it has no identity to record it
 * under. Everything else eBay sends unreadable is recorded as the order's disposition (R5).
 */
export class EbayOrderInvalid extends Error {
  constructor(readonly reason: 'order_id') {
    super(`This eBay order does not match the supported order contract (${reason}).`)
    this.name = 'EbayOrderInvalid'
  }
}

/**
 * R5 — a part of the order eBay sent unreadable. The order is still recorded: an unreadable order
 * field falls back (below), an unreadable line is not recorded and takes no stock. The list is kept
 * on the order (`ebayMetadata.problems`) and the owners are told once; a later complete read of
 * the order records what was missing and clears the list.
 */
export type EbayOrderProblem =
  | { readonly field: 'creation_date' | 'total' | 'line_items' }
  | { readonly field: 'line_item_id' | 'duplicate_line_item' | 'quantity' | 'line_cost'; readonly index: number; readonly lineItemId: string | null; readonly sku: string | null }

/** The business is not active: the database refuses every write there, so nothing can be recorded. */
export class EbayOrderBusinessInactive extends Error {
  constructor() { super('This business profile is not active, so the eBay order cannot be recorded in it.'); this.name = 'EbayOrderBusinessInactive' }
}

/** The stored order belongs to a different eBay seller than the account importing it. Nothing is written. */
export class EbayOrderAttributionConflict extends Error {
  constructor(readonly reason: 'different_seller' | 'account_missing') {
    super(reason === 'account_missing'
      ? 'The eBay account importing this order is not an eBay account of this business.'
      : 'This eBay order is already recorded for a different eBay seller. It was not changed.')
    this.name = 'EbayOrderAttributionConflict'
  }
}

export interface NormalizedEbayLine {
  readonly lineItemId: string
  /** Non-empty SKU, else null (resolved through a single shared-listing membership, as before). */
  readonly sku: string | null
  readonly rawSku: string | null
  readonly legacyItemId: string | null
  readonly title: string | null
  readonly quantity: number
  /** Null: a non-numeric lineItemCost. The writer does not record the line; it is a problem (R5). */
  readonly price: number | null
  /** Position in eBay's lineItems, for the owner's notice. */
  readonly index: number
  /** eBay's lineItemFulfillmentStatus (FULFILLED, IN_PROGRESS, NOT_STARTED): which lines shipped (C1). */
  readonly fulfillmentStatus: string | null
  readonly rawCost: unknown
  readonly taxAmount: number
  readonly discountAmount: number
}

export interface NormalizedEbayOrder {
  readonly orderId: string
  /** Null: unreadable (R5). A new order takes the time Nexus first read it; a stored one keeps its date. */
  readonly purchaseDate: Date | null
  /** Null: unreadable (R5). A new order records 0; a stored one keeps its total. */
  readonly totalPrice: number | null
  readonly currencyCode: string
  readonly status: EbayOrderStatus
  readonly customerName: string
  readonly customerEmail: string
  readonly shippingAddress: Record<string, unknown>
  readonly metadata: {
    readonly orderStatus: string
    readonly fulfillmentStatus: string
    readonly orderPaymentStatus: string | null
    readonly cancelState: string | null
    readonly lastModifiedDate: string | null
    /** Exactly as eBay sent it: customerName may be replaced later, this may not. */
    readonly buyer: { readonly username: string | null }
  }
  /** Only the readable lines: a unique line id and a positive whole quantity. */
  readonly lines: readonly NormalizedEbayLine[]
  readonly problems: readonly EbayOrderProblem[]
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const identifier = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null
const text = (value: unknown): string | null => typeof value === 'string' ? value : null

/**
 * Pure. The Fulfillment API order (live shape, and the historical fixture shapes) as the writer
 * needs it. Strict where a wrong value would corrupt identity or stock: the order id, unique line
 * ids and positive whole quantities. Only a missing order id refuses the order; every other
 * unreadable part is returned as a problem and left out (R5). AS.3c: live payloads carry statuses
 * and ship-to under orderFulfillmentStatus / orderPaymentStatus / cancelStatus / fulfillmentStartInstructions.
 */
export function normalizeEbayOrder(raw: unknown): NormalizedEbayOrder {
  const order = object(raw)
  const orderId = identifier(order?.orderId)
  if (!order || !orderId) throw new EbayOrderInvalid('order_id')
  const problems: EbayOrderProblem[] = []
  const created = typeof order.creationDate === 'string' ? new Date(order.creationDate) : null
  const purchaseDate = created && Number.isFinite(created.getTime()) ? created : null
  if (!purchaseDate) problems.push({ field: 'creation_date' })
  const pricing = object(order.pricingSummary)
  const totalPrice = parseEbayAmount(pricing?.total as EbayAmountLike)
  if (totalPrice === null) problems.push({ field: 'total' })
  if (!Array.isArray(order.lineItems)) problems.push({ field: 'line_items' })

  const seen = new Set<string>()
  const lines: NormalizedEbayLine[] = []
  for (const [index, value] of (Array.isArray(order.lineItems) ? order.lineItems : []).entries()) {
    const line = object(value)
    const lineItemId = identifier(line?.lineItemId)
    const sku = typeof line?.sku === 'string' && line.sku ? line.sku : null
    if (!line || !lineItemId) { problems.push({ field: 'line_item_id', index, lineItemId: null, sku }); continue }
    // The first line with an id is the line; a repeat of the id is not recorded twice.
    if (seen.has(lineItemId)) { problems.push({ field: 'duplicate_line_item', index, lineItemId, sku }); continue }
    seen.add(lineItemId)
    if (!Number.isSafeInteger(line.quantity) || (line.quantity as number) <= 0) { problems.push({ field: 'quantity', index, lineItemId, sku }); continue }
    const taxes = line.taxes as Array<{ amount?: EbayAmountLike; taxAmount?: EbayAmountLike }> | { taxAmount?: EbayAmountLike } | undefined
    const discounts = Array.isArray(line.discounts) ? line.discounts as Array<{ discountAmount?: EbayAmountLike }> : []
    lines.push(Object.freeze({
      lineItemId,
      sku,
      rawSku: text(line.sku),
      legacyItemId: typeof line.legacyItemId === 'string' && line.legacyItemId ? line.legacyItemId : null,
      title: text(line.title),
      quantity: line.quantity as number,
      price: parseEbayAmount(line.lineItemCost as EbayAmountLike),
      rawCost: line.lineItemCost,
      taxAmount: Array.isArray(taxes)
        ? taxes.reduce((sum, t) => sum + (parseEbayAmount(t?.amount ?? t?.taxAmount) ?? 0), 0)
        : (parseEbayAmount(object(taxes)?.taxAmount as EbayAmountLike) ?? 0),
      discountAmount: discounts.reduce((sum, d) => sum + (parseEbayAmount(d?.discountAmount) ?? 0), 0),
      index,
      fulfillmentStatus: identifier(line.lineItemFulfillmentStatus),
    }))
  }

  const shipTo = object(object(object((order.fulfillmentStartInstructions as unknown[] | undefined)?.[0])?.shippingStep)?.shipTo)
  const cancelState = text(object(order.cancelStatus)?.cancelState) ?? ''
  const orderPaymentStatus = text(order.orderPaymentStatus)
  const statusForMap = text(order.orderStatus)
    ?? (/^CANCEL/i.test(cancelState) && !/^NONE/i.test(cancelState) ? 'CANCELLED' : orderPaymentStatus === 'PAID' ? 'COMPLETED' : 'PENDING')
  const fulfillmentForMap = text(order.fulfillmentStatus) ?? text(order.orderFulfillmentStatus) ?? ''
  const username = text(object(order.buyer)?.username)
  // Guest checkout may omit buyer.email; the schema requires one, so a placeholder kept distinct
  // from real addresses with the .invalid suffix.
  const customerEmail = (text(object(order.buyer)?.email) ?? '').trim() || (text(shipTo?.email) ?? '').trim()
    || `${(username || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '')}@buyer.ebay.invalid`
  return Object.freeze({
    orderId,
    purchaseDate,
    totalPrice,
    currencyCode: ebayAmountCurrency(pricing?.total as EbayAmountLike) ?? text(pricing?.currency) ?? 'EUR',
    status: mapEbayOrderStatus(statusForMap, fulfillmentForMap),
    customerName: username || text(shipTo?.fullName) || 'eBay Buyer',
    customerEmail,
    // shippingAddress is a REQUIRED Json column: never undefined.
    shippingAddress: object(order.shippingAddress)
      ?? (shipTo ? { fullName: text(shipTo.fullName), ...(object(shipTo.contactAddress) ?? {}) } : {}),
    metadata: Object.freeze({
      orderStatus: statusForMap,
      fulfillmentStatus: fulfillmentForMap,
      orderPaymentStatus,
      cancelState: cancelState || null,
      lastModifiedDate: text(order.lastModifiedDate),
      buyer: Object.freeze({ username }),
    }),
    lines: Object.freeze(lines),
    problems: Object.freeze(problems),
  })
}

export type EbayLineStockEffect = 'own_movement' | 'pool_take' | 'pool_reused' | 'pool_refused' | 'shortfall' | 'stock_blocked' | 'unlinked' | 'arrived_cancelled'

/**
 * Pure. Stable routing order by lender source then borrower id. The scoped stock-lock door must
 * already hold the complete own + lender Product set; sorting pool takes alone cannot prevent
 * reciprocal mixed orders from deadlocking. Unpooled products sort by their own id.
 */
export function poolTakeOrder(productIds: string[], sourceOf: Map<string, string>): string[] {
  const key = (id: string) => sourceOf.get(id) ?? id
  return [...productIds].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : a > b ? 1 : 0))
}

/** Refusals the stock primitives raise after reads only: the order transaction is intact. */
function stockBlockOf(error: unknown): { code: string; reason: string } | null {
  if (error instanceof StockLocationUnresolved) return { code: error.code, reason: error.message }
  if (error instanceof PooledProductError) return { code: error.code, reason: 'This product sells from shared stock right now; its own stock was not changed.' }
  return null
}

export interface EbayOrderWriteResult {
  order: Order
  created: boolean
  newlyCancelled: boolean
  /** Already cancelled here, but its own or pool ledger still owes units back. */
  restorePending: boolean
  lines: Array<{ lineItemId: string; orderItemId: string; productId: string | null; stockEffect: EbayLineStockEffect }>
  movements: Array<{ productId: string; result: StockMovementTxResult }>
  /** A pool take moved stock: wake the pool worker after the commit. */
  poolChanged: boolean
  stats: { itemsProcessed: number; itemsLinked: number; inventoryDeducted: number }
}

/** eBay's last change to the order, when it names a real time; else now. */
function shippedTime(order: NormalizedEbayOrder): Date {
  const at = order.metadata.lastModifiedDate ? new Date(order.metadata.lastModifiedDate) : null
  return at && Number.isFinite(at.getTime()) ? at : new Date()
}

/** The transaction's own business profile, as the database applies it (also without a request context). */
async function transactionWorkspace(tx: Tx): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ id: string | null }>>`SELECT NULLIF(current_setting('nexus.workspace_id', true), '') AS id`
  if (!row?.id) throw new Error('An eBay order is written inside a business profile.')
  return row.id
}

/**
 * Two connection rows are one seller when both carry the same immutable eBay user and environment
 * (C11d4). 'different' needs positive evidence: both identities present and unequal. A row without a
 * readable identity (older connections) is 'unknown', never proof of another seller.
 */
async function ebaySellerRelation(tx: Tx, workspaceId: string, a: string, b: string): Promise<'same' | 'different' | 'unknown'> {
  const rows = await tx.channelConnection.findMany({ where: { id: { in: [a, b] }, workspaceId, channelType: 'EBAY' },
    select: { externalAccountId: true, connectionMetadata: true } })
  if (rows.length !== 2) return 'unknown'
  const identities = rows.map(row => { try { return ebaySellerIdentity(row) } catch { return null } })
  if (!identities[0] || !identities[1]) return 'unknown'
  return identities[0].userId === identities[1].userId && identities[0].environment === identities[1].environment ? 'same' : 'different'
}

/**
 * Resolve an eBay SKU to a Nexus product, inside the transaction (S6: the one inbound match). In order: this eBay
 * account's listings (the SKU eBay confirmed, the listing's own SKU, the old stores); the eBay variant listings of
 * this seller (the importing account and its verified siblings); the master SKU; the legacy ProductVariation.sku.
 * Two or more products at one step: not linked, with the reason. D7: the eBay LINE id is never matched against any
 * channel's listing id — that linked a sale to an unrelated product.
 */
async function productForSku(tx: Tx, sku: string, connectionId: string): Promise<InboundSkuMatch> {
  return matchInboundSku(tx, {
    channel: 'EBAY',
    channelConnectionId: connectionId,
    sku,
    accountStores: [{
      name: 'ebayVariantListing',
      find: async () => {
        // A sibling is supported only with positive evidence of the same immutable seller/environment.
        const accounts = await tx.channelConnection.findMany({ where: { channelType: 'EBAY' },
          select: { id: true, externalAccountId: true, connectionMetadata: true } })
        const identityOf = (row: typeof accounts[number]) => { try { return ebaySellerIdentity(row) } catch { return null } }
        const importing = accounts.find(row => row.id === connectionId)
        const identity = importing ? identityOf(importing) : null
        const accountIds = accounts.filter(row => {
          if (row.id === connectionId) return true
          const sibling = identityOf(row)
          return identity && sibling && identity.userId === sibling.userId && identity.environment === sibling.environment
        }).map(row => row.id)
        // eBay sync also writes channel-less listings; both forms need the same account fence.
        const listings = await tx.variantChannelListing.findMany({ where: { externalSku: sku,
          channelConnectionId: { in: accountIds }, OR: [{ channel: 'EBAY' }, { channel: null }] },
          select: { variant: { select: { productId: true } } } })
        return listings.map(listing => listing.variant.productId)
      },
    }],
    fallbacks: [{
      name: 'variationSku',
      find: async () => (await tx.productVariation.findMany({ where: { sku }, select: { productId: true } })).map(variation => variation.productId),
    }],
  })
}

/** Seen = what the database holds for this order after the locks, never an in-memory list. */
function seen(existing: { items: ReadonlyArray<{ externalLineItemId: string | null; ebayMetadata: Prisma.JsonValue }> } | null, lineItemId: string): boolean {
  return (existing?.items ?? []).some(item => item.externalLineItemId === lineItemId
    || (item.ebayMetadata as { lineItemId?: unknown } | null)?.lineItemId === lineItemId)
}

/** R5 — the owners are told once per order and set of unreadable parts; the words say what was and was not recorded. */
async function noticeUnreadableParts(tx: Tx, args: { problems: EbayOrderProblem[]; orderId: string; channelOrderId: string; workspaceId: string; created: boolean }): Promise<void> {
  const { problems, orderId, channelOrderId, workspaceId, created } = args
  const lineName = (problem: EbayOrderProblem) => 'index' in problem
    ? `line ${problem.index + 1}${problem.sku ? ` (${problem.sku})` : ''}` : ''
  const parts = problems.map(problem => {
    switch (problem.field) {
      case 'creation_date': return created ? 'its creation date (the time Nexus first read it is used)' : 'its creation date (the recorded date is kept)'
      case 'total': return created ? 'its total (recorded as 0)' : 'its total (the recorded total is kept)'
      case 'line_items': return 'its list of lines'
      case 'line_item_id': return `the line id of ${lineName(problem)}`
      case 'duplicate_line_item': return `${lineName(problem)}, which repeats the id of an earlier line`
      case 'quantity': return `the quantity of ${lineName(problem)}`
      case 'line_cost': return `the price of ${lineName(problem)}`
    }
  })
  const lineProblems = problems.some(problem => 'index' in problem || problem.field === 'line_items')
  await raiseChannelAlertInTx(tx, {
    kind: 'channel-order-unreadable', severity: lineProblems ? 'danger' : 'warn',
    title: 'An eBay order was recorded, but parts of it could not be read',
    body: `eBay order ${channelOrderId} is saved, but Nexus could not read ${parts.join('; ')}.`
      + (lineProblems ? ' The lines that could not be read are not recorded. Nothing was taken from stock for the lines that could not be read; a later read of the order from eBay records them if eBay then sends them complete.' : '')
      + ' Check the order in eBay.',
    entityType: 'Order', entityId: orderId, href: `/orders/${orderId}`,
    meta: { channelOrderId, problems },
  }, { workspaceId, actorUserId: null, occurrenceId: `ebay-order-unreadable:${orderId}:${problems.map(problem => 'index' in problem ? `${problem.field}@${problem.index}` : problem.field).join(',')}` })
}

/** One line waiting for its stock effect: a new line of this read, or (R6) a stock_blocked line taken again. */
interface PendingLine {
  line: NormalizedEbayLine; sku: string; productId: string | null; effect: EbayLineStockEffect; poolRefusalCode?: string; stockBlock?: { code: string; reason: string }
  /** S6 — why an unlinked line has no product (its SKU names several), kept on the line. */
  unlinkedReason?: string
  /** R6 — an existing line recorded stock_blocked, taken again now (its OrderItem id). */
  retryOf?: { orderItemId: string; metadata: Record<string, unknown> }
}

/** R6 — the order's stock_blocked lines, as pending lines to take again. */
function blockedLinesOf(items: ReadonlyArray<{ id: string; externalLineItemId: string | null; productId: string | null; sku: string; quantity: number; ebayMetadata: Prisma.JsonValue }>): PendingLine[] {
  const pending: PendingLine[] = []
  for (const item of items) {
    const metadata = (item.ebayMetadata ?? {}) as Record<string, unknown>
    if (metadata.stockEffect !== 'stock_blocked' || !item.productId || !(item.quantity > 0) || !item.externalLineItemId) continue
    pending.push({
      // The item id the line was sold through (kept on the line), so "Sells from" finds the same listing again.
      line: { lineItemId: item.externalLineItemId, sku: item.sku, rawSku: item.sku, legacyItemId: typeof metadata.legacyItemId === 'string' && metadata.legacyItemId ? metadata.legacyItemId : null, title: null, quantity: item.quantity, price: null, rawCost: null, taxAmount: 0, discountAmount: 0, index: -1, fulfillmentStatus: null },
      sku: item.sku, productId: item.productId, effect: 'own_movement', retryOf: { orderItemId: item.id, metadata },
    })
  }
  return pending
}

/**
 * The stock phase shared by a read of the order and the R6 database retry: takes each product once
 * for its pending lines, records every line's effect, and tells the owners about shortfalls and
 * blocked lines (one notice per order and line set). The caller holds the order's locks.
 */
async function takePendingLinesInTx(tx: Tx, args: { pending: PendingLine[]; orderId: string; channelOrderId: string; workspaceId: string; actor: string; stats: { inventoryDeducted: number }; connectionId: string | null }): Promise<Pick<EbayOrderWriteResult, 'lines' | 'movements' | 'poolChanged'>> {
  const { pending, orderId, channelOrderId, workspaceId, actor, stats, connectionId } = args
  // Stock leaves once per product for all its new lines: a pool takes ONE sale per order and product
  // (one variant can sit in two eBay listings bought together). Own stock moves line by line.
  const byProduct = new Map<string, PendingLine[]>()
  for (const entry of pending) if (entry.effect === 'own_movement') byProduct.set(entry.productId!, [...(byProduct.get(entry.productId!) ?? []), entry])
  // RLS hides lender products; the scoped door derives and locks own + pool sources together.
  // Locking own products first and lenders later deadlocks reciprocal mixed orders.
  if (byProduct.size) await tx.$executeRaw`SELECT nexus_lock_order_stock(${[...byProduct.keys()]}::text[])`
  const movements: EbayOrderWriteResult['movements'] = []
  const shortfalls: Array<PendingLine & { available: number; locationId: string }> = []
  const blocked: PendingLine[] = []
  let poolChanged = false
  const sources = new Map((await tx.stockPoolLink.findMany({ where: { productId: { in: [...byProduct.keys()] }, status: 'active' },
    select: { productId: true, sourceProductId: true }, orderBy: { id: 'asc' } })).map(link => [link.productId, link.sourceProductId]))
  for (const productId of poolTakeOrder([...byProduct.keys()], sources)) {
    const entries = byProduct.get(productId)!
    const quantity = entries.reduce((sum, entry) => sum + entry.line.quantity, 0)
    const routed = await takeForOrderInTx(tx, { productId, quantity, orderId, actor, workspaceId })
    if (routed.via === 'pool') {
      poolChanged ||= routed.changed
      // Door 4b takes ONE sale per order and product: a line arriving after that take reuses it and
      // takes nothing. Say so; never count it as deducted.
      const reused = (routed as { result: { reused: boolean } }).result.reused
      for (const entry of entries) entry.effect = reused ? 'pool_reused' : 'pool_take'
      if (!reused) stats.inventoryDeducted += entries.length
      continue
    }
    if (routed.via === 'refused') {
      const code = (routed as { refusal: { code: string } }).refusal.code
      for (const entry of entries) { entry.effect = 'pool_refused'; entry.poolRefusalCode = code }
      continue
    }
    for (const entry of entries) {
      try {
        // Step 2 — "Sells from": the line is taken from the first location of its listing's list with enough stock
        // (never split; none has enough → the first, which reports the shortfall). Picked under the locks above and
        // after the lines before it were taken. No answer (nothing routed): the default location, as before.
        const picked = await saleLocationInTx(tx, { productId, quantity: entry.line.quantity, channel: 'EBAY', channelConnectionId: connectionId, externalListingId: entry.line.legacyItemId })
        // R2 — the take is the stock service's: an ORDER_PLACED movement carrying the order.
        movements.push({ productId, result: await takeOrderUnitsInTx(tx, { orderId, productId, quantity: entry.line.quantity, actor, notes: `eBay order ${channelOrderId} line ${entry.line.lineItemId}`, locationId: picked?.locationId ?? null }) })
        stats.inventoryDeducted++
      } catch (error) {
        // Only typed refusals raised before the movement wrote anything: the sale is real, so it is
        // recorded with why its stock did not move. Every other failure, including a database error
        // that has aborted this transaction, rolls the order back.
        if (error instanceof InsufficientStockError) {
          entry.effect = 'shortfall'
          shortfalls.push({ ...entry, available: error.quantityBefore, locationId: error.locationId })
          continue
        }
        const block = stockBlockOf(error)
        if (!block) throw error
        entry.effect = 'stock_blocked'
        entry.stockBlock = block
        blocked.push(entry)
      }
    }
  }

  const lines: EbayOrderWriteResult['lines'] = []
  for (const entry of pending) {
    const { line } = entry
    if (entry.retryOf) {
      // Still blocked: unchanged. Taken (or now short): the line records what happened, and where it came from.
      if (entry.effect === 'stock_blocked') continue
      const { stockBlockedCode: _cleared, ...kept } = entry.retryOf.metadata
      await tx.orderItem.update({ where: { id: entry.retryOf.orderItemId }, data: { ebayMetadata: {
        ...kept, stockEffect: entry.effect, stockRetriedFrom: 'stock_blocked',
        ...(entry.poolRefusalCode ? { poolRefusalCode: entry.poolRefusalCode } : {}),
      } as Prisma.InputJsonValue } })
      continue
    }
    // O.5: externalLineItemId is the (order, line) unique key — the idempotency backstop.
    const created = await tx.orderItem.create({ data: {
      orderId, productId: entry.productId, externalLineItemId: line.lineItemId, sku: entry.sku,
      quantity: line.quantity, price: line.price!,
      ebayMetadata: {
        lineItemId: line.lineItemId, legacyItemId: line.legacyItemId, rawSku: line.rawSku, title: line.title,
        taxAmount: line.taxAmount, discountAmount: line.discountAmount, stockEffect: entry.effect,
        ...(line.fulfillmentStatus ? { fulfillmentStatus: line.fulfillmentStatus } : {}),
        ...(entry.poolRefusalCode ? { poolRefusalCode: entry.poolRefusalCode } : {}),
        ...(entry.stockBlock ? { stockBlockedCode: entry.stockBlock.code } : {}),
        ...(entry.unlinkedReason ? { unlinkedReason: entry.unlinkedReason } : {}),
      },
    }, select: { id: true } })
    lines.push({ lineItemId: line.lineItemId, orderItemId: created.id, productId: entry.productId, stockEffect: entry.effect })
  }

  if (shortfalls.length) {
    const codes = new Map((await tx.stockLocation.findMany({ where: { id: { in: [...new Set(shortfalls.map(entry => entry.locationId))] } }, select: { id: true, code: true } })).map(row => [row.id, row.code]))
    const units = shortfalls.map(entry => `${entry.line.quantity} × ${entry.sku} (${entry.available} in stock at ${codes.get(entry.locationId) ?? 'its warehouse'})`)
    await raiseChannelAlertInTx(tx, {
      kind: 'channel-order-stock-shortfall', severity: 'danger',
      title: shortfalls.length === 1
        ? `An eBay sale of ${shortfalls[0].line.quantity} × ${shortfalls[0].sku} was recorded without stock`
        : `An eBay sale was recorded without stock for ${shortfalls.length} lines`,
      body: `eBay order ${channelOrderId} is saved, but your own stock could not cover ${units.join(', ')}. Nothing was taken from stock for ${shortfalls.length === 1 ? 'this line' : 'these lines'}. Check the stock before it ships.`,
      entityType: 'Order', entityId: orderId, href: `/orders/${orderId}`,
      meta: { channelOrderId, lines: shortfalls.map(entry => ({ lineItemId: entry.line.lineItemId, productId: entry.productId, quantity: entry.line.quantity, available: entry.available, locationId: entry.locationId })) },
    }, { workspaceId, actorUserId: null, occurrenceId: `ebay-order:${orderId}:${shortfalls.map(entry => entry.line.lineItemId).join(',')}` })
  }

  if (blocked.length) {
    const reasons = [...new Set(blocked.map(entry => entry.stockBlock!.reason))]
    await raiseChannelAlertInTx(tx, {
      kind: 'channel-order-stock-blocked', severity: 'danger',
      title: blocked.length === 1
        ? `An eBay sale of ${blocked[0].line.quantity} × ${blocked[0].sku} was recorded, but its stock was not taken`
        : `An eBay sale was recorded, but stock was not taken for ${blocked.length} lines`,
      body: `eBay order ${channelOrderId} is saved. Stock was not taken for ${blocked.map(entry => `${entry.line.quantity} × ${entry.sku}`).join(', ')}: ${reasons.join(' ')} Once this is corrected, the next scheduled eBay order sync takes the stock for this order automatically, however old the order is. Do not change the stock by hand for it.`,
      entityType: 'Order', entityId: orderId, href: `/orders/${orderId}`,
      meta: { channelOrderId, lines: blocked.map(entry => ({ lineItemId: entry.line.lineItemId, productId: entry.productId, quantity: entry.line.quantity, code: entry.stockBlock!.code })) },
    }, { workspaceId, actorUserId: null, occurrenceId: `ebay-order-blocked:${orderId}:${blocked.map(entry => entry.line.lineItemId).join(',')}` })
  }

  return { lines, movements, poolChanged }
}

/**
 * The database phase of one eBay order. Uses ONLY `tx`; the caller owns the transaction
 * (ReadCommitted) and runs `afterEbayOrderCommit` once it has committed.
 *
 * Lock order: account (KEY SHARE) → order identity (advisory) → order row → shared link lock → products.
 * A notice replay already holds the account row, so a poll queues behind it rather than holding
 * the order the replay waits for.
 */
export async function writeEbayOrderInTx(tx: Tx, input: { order: NormalizedEbayOrder; connectionId: string; actor: string }): Promise<EbayOrderWriteResult> {
  const { order, connectionId, actor } = input
  const workspaceId = await transactionWorkspace(tx)
  const account = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "ChannelConnection" WHERE id=${connectionId} AND "workspaceId"=${workspaceId} AND "channelType"='EBAY' FOR KEY SHARE`
  if (!account.length) {
    // Row security hides every row of an inactive business; say that, not "unknown account".
    const [business] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Workspace" WHERE id=${workspaceId}`
    if (business && business.status !== 'active') throw new EbayOrderBusinessInactive()
    throw new EbayOrderAttributionConflict('account_missing')
  }
  // The advisory lock covers an order that does not exist yet; the database unique keys stay the backstop.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['nexus-ebay-order', workspaceId, order.orderId])}, 0))`
  // NO KEY UPDATE, like the stock lock: rows that reference the order (lines, shipments) take KEY SHARE,
  // which FOR UPDATE would block for no benefit. Any other writer of this row still waits here.
  await tx.$queryRaw`SELECT id FROM "Order" WHERE "workspaceId"=${workspaceId} AND channel='EBAY' AND "channelOrderId"=${order.orderId} FOR NO KEY UPDATE`
  const existing = await tx.order.findFirst({ where: { workspaceId, channel: 'EBAY', channelOrderId: order.orderId },
    select: { id: true, status: true, shippedAt: true, channelConnectionId: true, purchaseDate: true, totalPrice: true, items: { select: { id: true, externalLineItemId: true, productId: true, sku: true, quantity: true, ebayMetadata: true } } } })

  const link = ebayOrderConnectionLink(existing?.channelConnectionId, connectionId)
  const relation = link.conflict ? await ebaySellerRelation(tx, workspaceId, existing!.channelConnectionId!, connectionId) : 'same'
  if (relation === 'different') throw new EbayOrderAttributionConflict('different_seller')

  // O.7: a local terminal status (an operator's cancel) is not regressed by a stale channel read.
  let status: string = order.status
  if (shouldPreserveTerminalStatus(existing?.status, status)) {
    logger.info('ebay-orders: preserving local terminal status (channel still reports non-terminal)', { orderId: order.orderId, localStatus: existing!.status, channelStatus: status })
    status = existing!.status
  }
  const newlyCancelled = status === 'CANCELLED' && existing != null && existing.status !== 'CANCELLED'
  // The durable marker (E3): a cancelled order whose taking movements are not all given back.
  const restorePending = status === 'CANCELLED' && existing?.status === 'CANCELLED' && await orderRestorePending(tx, existing.id)
  // R5 — an unreadable date or total falls back: a stored order keeps its own, a new one takes the
  // time of this first read and 0. A line eBay sent without a readable cost is not recorded.
  const problems: EbayOrderProblem[] = [...order.problems]
  for (const line of order.lines) {
    if (line.price === null && !seen(existing, line.lineItemId)) problems.push({ field: 'line_cost', index: line.index, lineItemId: line.lineItemId, sku: line.sku })
  }
  problems.sort((x, y) => ('index' in x ? x.index : -1) - ('index' in y ? y.index : -1))
  const purchaseDate = order.purchaseDate ?? existing?.purchaseDate ?? new Date()
  const data = {
    channel: 'EBAY' as const,
    // eBay has no per-marketplace order split; EBAY-GLOBAL keeps the column honest.
    marketplace: 'EBAY-GLOBAL',
    channelOrderId: order.orderId,
    status: status as Order['status'],
    totalPrice: order.totalPrice ?? existing?.totalPrice ?? 0,
    currencyCode: order.currencyCode,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    shippingAddress: order.shippingAddress as Prisma.InputJsonValue,
    purchaseDate,
    fulfillmentMethod: 'MFN',
    // O.1: eBay default handling time = 1 day until the listing-level value is wired.
    fulfillmentLatency: 1,
    shipByDate: new Date(purchaseDate.getTime() + 24 * 60 * 60 * 1000),
    ebayMetadata: { ...order.metadata, ...(problems.length ? { problems } : {}) } as unknown as Prisma.InputJsonValue,
    // R4 — the first shipped read is recorded: a cancellation after it gives nothing back.
    ...(!existing?.shippedAt && (status === 'SHIPPED' || status === 'DELIVERED') ? { shippedAt: shippedTime(order) } : {}),
  }
  const dbOrder = existing
    ? await tx.order.update({ where: { id: existing.id }, data: { ...data, ...link.data } })
    : await tx.order.create({ data: { ...data, ...link.data } })
  if (relation === 'unknown') {
    // MAP.2's behaviour, kept: update the order, never move its store link — and tell the owners once.
    logger.warn('ebay-orders: order is linked to an account row without a seller identity — updated, link kept', { orderId: order.orderId, linkedConnectionId: existing!.channelConnectionId, importingConnectionId: connectionId })
    await raiseChannelAlertInTx(tx, {
      kind: 'channel-order-attribution-unverified', severity: 'warn',
      title: 'An eBay order is linked to an account Nexus cannot verify',
      body: `eBay order ${order.orderId} is linked to an eBay account whose seller identity is not recorded. It was updated from another of your eBay accounts and kept on its original account. Reconnect or remove the old account so the order's store can be confirmed.`,
      entityType: 'Order', entityId: dbOrder.id, href: `/orders/${dbOrder.id}`,
      meta: { channelOrderId: order.orderId, linkedConnectionId: existing!.channelConnectionId, importingConnectionId: connectionId },
    }, { workspaceId, actorUserId: null, occurrenceId: `ebay-order-link:${dbOrder.id}:${existing!.channelConnectionId}:${connectionId}` })
  }


  // R6 — a line recorded stock_blocked (a configuration refusal: no single default warehouse, the
  // pooled-product guard) is taken again on every later read until the configuration resolves, under
  // this order's locks, so exactly once. Never for a cancelled order: it took nothing and owes nothing.
  // The owner is never asked to adjust stock by hand: a manual adjustment carries no order, so a
  // cancellation could not give it back, and this retry would then take it a second time.
  // retryBlockedEbayLines does the same from the database for orders eBay no longer returns.
  const pending: PendingLine[] = status !== 'CANCELLED' ? blockedLinesOf(existing?.items ?? []) : []
  const stats = { itemsProcessed: order.lines.length, itemsLinked: 0, inventoryDeducted: 0 }
  for (const line of order.lines) {
    if (seen(existing, line.lineItemId)) continue
    if (line.price === null) {
      // AS.3b — a genuinely malformed payload: a problem on the order (R5), recorded by a later complete read.
      logger.warn('eBay line item: non-numeric lineItemCost — not recorded', { orderId: order.orderId, lineItemId: line.lineItemId, raw: JSON.stringify(line.rawCost)?.slice(0, 120) })
      continue
    }
    // AS.3d — a line without a SKU resolves through exactly one ACTIVE shared-listing membership;
    // anything ambiguous is recorded product-less, never a guessed deduction.
    let sku = line.sku
    let membershipProductId: string | null = null
    if (!sku && line.legacyItemId) {
      const members = await tx.sharedListingMembership.findMany({ where: { itemId: line.legacyItemId, status: 'ACTIVE' }, select: { sku: true, productId: true }, take: 2 })
      if (members.length === 1) {
        sku = members[0].sku
        membershipProductId = members[0].productId ?? null
      }
    }
    if (!sku) {
      sku = line.legacyItemId ? `EBAY-ITEM-${line.legacyItemId}` : `EBAY-LINE-${line.lineItemId}`
      logger.warn('eBay line item has no sku and no unambiguous membership — recorded without product link', { orderId: order.orderId, lineItemId: line.lineItemId, legacyItemId: line.legacyItemId })
    }
    const match = membershipProductId ? null : await productForSku(tx, sku, connectionId)
    const productId = membershipProductId
      ? (await tx.product.findUnique({ where: { id: membershipProductId }, select: { id: true } }))?.id ?? null
      : match?.productId ?? null
    const unlinkedReason = match?.problem?.sentence
    if (productId) stats.itemsLinked++
    else logger.warn('Could not link eBay line item to a Nexus product', { sku, lineItemId: line.lineItemId, orderId: order.orderId, ...(unlinkedReason ? { reason: unlinkedReason } : {}) })
    pending.push({ line, sku, productId, effect: !productId ? 'unlinked' : status === 'CANCELLED' ? 'arrived_cancelled' : 'own_movement', ...(unlinkedReason ? { unlinkedReason } : {}) })
  }

  const { lines, movements, poolChanged } = await takePendingLinesInTx(tx, { pending, orderId: dbOrder.id, channelOrderId: order.orderId, workspaceId, actor, stats, connectionId })
  // C1 — each recorded line keeps eBay's latest word on whether it shipped: a cancellation after a
  // partial shipment gives back only the lines that did not. Merged into the line's metadata (after
  // the stock phase, which rewrites a retried line's metadata from its earlier read).
  for (const item of existing?.items ?? []) {
    const status = order.lines.find((line) => line.lineItemId === item.externalLineItemId)?.fulfillmentStatus
    if (!status || (item.ebayMetadata as { fulfillmentStatus?: unknown } | null)?.fulfillmentStatus === status) continue
    await tx.$executeRaw`UPDATE "OrderItem" SET "ebayMetadata" = COALESCE("ebayMetadata", '{}'::jsonb) || jsonb_build_object('fulfillmentStatus', ${status}::text) WHERE id = ${item.id}`
  }
  if (problems.length) await noticeUnreadableParts(tx, { problems, orderId: dbOrder.id, channelOrderId: order.orderId, workspaceId, created: existing == null })
  return { order: dbOrder, created: existing == null, newlyCancelled, restorePending, lines, movements, poolChanged, stats }
}

/**
 * Everything that leaves the database, after the order's transaction has committed. Best-effort:
 * a failure here never un-records the sale; queue rows stay PENDING for the drain cron.
 */
export async function afterEbayOrderCommit(result: EbayOrderWriteResult): Promise<void> {
  const orderId = result.order.id
  for (const movement of result.movements) {
    try { await afterStockMovementCommit({ productId: movement.productId, reason: 'ORDER_PLACED' }, movement.result) }
    catch (error) { logger.warn('ebay-orders: post-commit stock hook failed', { orderId, productId: movement.productId, error: error instanceof Error ? error.message : String(error) }) }
  }
  if (result.poolChanged) {
    void import('./stock-pool/pool-tasks.js').then(({ afterPoolChange }) => afterPoolChange()).catch(() => { /* the poller is the backstop */ })
  }
  // F.1 — keep DailySalesAggregate current for the forecasting layer.
  for (const line of result.lines) {
    try { await recordOrderItem(line.orderItemId) }
    catch (error) { logger.warn('sales-aggregate refresh failed for OrderItem', { orderItemId: line.orderItemId, error: error instanceof Error ? error.message : String(error) }) }
  }
  // O.6: lifecycle event for /orders SSE subscribers.
  void (async () => {
    try {
      const { publishOrderEvent } = await import('./order-events.service.js')
      publishOrderEvent(result.created
        ? { type: 'order.created', orderId, channel: 'EBAY', channelOrderId: result.order.channelOrderId, ts: Date.now() }
        : { type: 'order.updated', orderId, channel: 'EBAY', status: result.order.status, ts: Date.now() })
    } catch { /* bus failure must not break ingestion */ }
  })()
  // O.21a: customer FK + cache refresh.
  void (async () => {
    try {
      const { linkAndRefreshCustomerForOrder } = await import('./customer-cache.service.js')
      await linkAndRefreshCustomerForOrder(orderId)
    } catch (error) {
      logger.warn('ebay-orders: customer cache refresh failed', { orderId, error: error instanceof Error ? error.message : String(error) })
    }
  })()
  // O.45: cascade cancellation cleanup.
  if (result.newlyCancelled) {
    void (async () => {
      try {
        const { handleOrderCancelled } = await import('./order-cancellation/index.js')
        logger.info('ebay-orders: cancellation cascade', { orderId, ...(await handleOrderCancelled(orderId)) })
      } catch (error) {
        logger.warn('ebay-orders: cancellation cascade failed', { orderId, error: error instanceof Error ? error.message : String(error) })
      }
    })()
  }
  // E3 — finish a cancellation that failed part-way. Awaited: it is bounded database work, and the
  // next read of the order retries it again if it fails.
  if (result.restorePending && !result.newlyCancelled) {
    try {
      const { restoreCancelledOrderStock } = await import('./order-cancellation/index.js')
      const restored = await restoreCancelledOrderStock(orderId)
      if (restored.errors.length) logger.warn('ebay-orders: cancelled-order restore still incomplete', { orderId, errors: restored.errors.length })
    } catch (error) {
      logger.warn('ebay-orders: cancelled-order restore failed', { orderId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // FCF.5b — auto-submit Amazon MCF for a brand-new order whose listings are MCF-backed. Double-gated.
  if (result.created && process.env.NEXUS_EBAY_AUTO_MCF === '1') {
    void (async () => {
      try {
        const { autoSubmitMcfForEbayOrder } = await import('./ebay-auto-mcf.service.js')
        const submitted = await autoSubmitMcfForEbayOrder(orderId)
        if (submitted.submitted) logger.info('ebay-orders: auto-MCF submitted', { orderId, mcfShipmentId: submitted.mcfShipmentId })
      } catch (error) {
        logger.warn('ebay-orders: auto-MCF submit failed', { orderId, error: error instanceof Error ? error.message : String(error) })
      }
    })()
  }
}

/** Contention, not a defect: the next poll retries it and nobody needs to be told. */
function transientFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'P2034' || code === 'P2028') return true
  const text = error instanceof Error ? error.message : String(error)
  return /\b(40001|40P01|55P03|57014)\b/.test(text) || /deadlock detected|could not serialize|lock timeout|canceling statement due to (lock|statement) timeout/i.test(text)
}

/** A stable, data-free name for a failure: never its message, which can carry order data. */
function failureClass(error: unknown): string {
  const prismaCode = (error as { code?: unknown } | null)?.code
  if (typeof prismaCode === 'string' && /^P\d{4}$/.test(prismaCode)) {
    const pg = /code: "([0-9A-Z]{5})"/.exec(error instanceof Error ? error.message : '')?.[1]
    return pg ? `${prismaCode}/${pg}` : prismaCode
  }
  const pg = /code: "([0-9A-Z]{5})"/.exec(error instanceof Error ? error.message : '')?.[1]
  if (pg) return `pg-${pg}`
  const reason = (error as { reason?: unknown } | null)?.reason
  const name = error instanceof Error ? error.name : 'Error'
  return typeof reason === 'string' ? `${name}:${reason}` : name
}

/**
 * The order could not be recorded at all: tell the owners once per (account, order, failure class),
 * OUTSIDE the transaction that rolled back. Best-effort; transient contention is not reported, and
 * an inactive business cannot hold the notice either.
 */
async function reportIngestFailure(raw: unknown, connectionId: string, error: unknown): Promise<void> {
  if (transientFailure(error) || error instanceof EbayOrderBusinessInactive) return
  const channelOrderId = typeof (raw as { orderId?: unknown } | null)?.orderId === 'string' ? String((raw as { orderId: string }).orderId).slice(0, 120) : 'unknown'
  const errorClass = failureClass(error)
  try {
    const [row] = await prisma.$queryRaw<Array<{ id: string | null }>>`SELECT NULLIF(current_setting('nexus.workspace_id', true), '') AS id`
    if (!row?.id) return
    await raiseChannelAlertInTx(prisma, {
      kind: 'channel-order-ingest-failed', severity: 'danger',
      title: 'An eBay order could not be recorded',
      body: `eBay order ${channelOrderId} could not be saved (${errorClass}). Nothing was recorded for it; Nexus tries again on every eBay order sync. If this persists, report the failure code.`,
      entityType: 'ChannelConnection', entityId: connectionId, href: '/orders',
      meta: { channelOrderId, errorClass },
    }, { workspaceId: row.id, actorUserId: null, occurrenceId: `ebay-order-failed:${channelOrderId}:${errorClass}` })
  } catch (alertError) {
    logger.warn('ebay-orders: could not report an order that failed to record', { channelOrderId, errorClass, error: alertError instanceof Error ? alertError.name : 'unknown' })
  }
}

/** Polling's entry: normalize, one ReadCommitted transaction, then the post-commit hooks. */
export async function ingestEbayOrder(raw: unknown, connectionId: string, options: { actor?: string } = {}): Promise<EbayOrderWriteResult> {
  let result: EbayOrderWriteResult
  try {
    const order = normalizeEbayOrder(raw)
    result = await prisma.$transaction(
      tx => writeEbayOrderInTx(tx, { order, connectionId, actor: options.actor ?? 'ebay-orders-sync' }),
      { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 },
    )
  } catch (error) {
    await reportIngestFailure(raw, connectionId, error)
    throw error
  }
  await afterEbayOrderCommit(result)
  return result
}

export interface EbayBlockedRetryResult {
  /** Lines that left stock_blocked: taken, or recorded short / pool-refused, each with its notice. */
  resolved: number
  /** Lines still refused by the configuration: unchanged, nobody told again. */
  stillBlocked: number
  movements: EbayOrderWriteResult['movements']
  poolChanged: boolean
}

/**
 * R6 — one order's stock_blocked lines, taken again from the database. The writer's lock order
 * (account KEY SHARE → order identity → order row → stock), so a read of the same order and this
 * retry run one after the other and the line is taken exactly once. A cancelled order is skipped:
 * it took nothing and owes nothing.
 */
export async function retryBlockedEbayOrderInTx(tx: Tx, input: { orderId: string; actor: string }): Promise<EbayBlockedRetryResult> {
  const none: EbayBlockedRetryResult = { resolved: 0, stillBlocked: 0, movements: [], poolChanged: false }
  const workspaceId = await transactionWorkspace(tx)
  const head = await tx.order.findFirst({ where: { id: input.orderId, workspaceId, channel: 'EBAY' }, select: { channelOrderId: true, channelConnectionId: true } })
  if (!head) return none
  if (head.channelConnectionId) await tx.$queryRaw`SELECT id FROM "ChannelConnection" WHERE id=${head.channelConnectionId} AND "workspaceId"=${workspaceId} FOR KEY SHARE`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['nexus-ebay-order', workspaceId, head.channelOrderId])}, 0))`
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${input.orderId} AND "workspaceId"=${workspaceId} FOR NO KEY UPDATE`
  // Re-read under the locks: a read of the order may have taken the lines while this waited.
  const order = await tx.order.findFirst({ where: { id: input.orderId, workspaceId },
    select: { status: true, items: { select: { id: true, externalLineItemId: true, productId: true, sku: true, quantity: true, ebayMetadata: true } } } })
  if (!order || order.status === 'CANCELLED') return none
  const pending = blockedLinesOf(order.items)
  if (!pending.length) return none
  const { movements, poolChanged } = await takePendingLinesInTx(tx, { pending, orderId: input.orderId, channelOrderId: head.channelOrderId, workspaceId, actor: input.actor, stats: { inventoryDeducted: 0 }, connectionId: head.channelConnectionId })
  const stillBlocked = pending.filter(entry => entry.effect === 'stock_blocked').length
  return { resolved: pending.length - stillBlocked, stillBlocked, movements, poolChanged }
}

/**
 * R6 — the database, not eBay's 7-day order window, decides which blocked lines are retried: every
 * non-cancelled eBay order of the business with a stock_blocked line, however old. Run by the
 * scheduled eBay order sync (jobs/ebay-orders-sync.job.ts) after it has read eBay. One transaction
 * per order; a failure is logged and retried by the next run.
 */
export async function retryBlockedEbayLines(options: { actor?: string } = {}): Promise<{ orders: number; resolved: number; stillBlocked: number; failed: number }> {
  const actor = options.actor ?? 'ebay-orders-sync'
  const totals = { orders: 0, resolved: 0, stillBlocked: 0, failed: 0 }
  const PAGE = 100
  let after: string | undefined
  for (;;) {
    const page = await prisma.order.findMany({
      where: { channel: 'EBAY', status: { not: 'CANCELLED' }, items: { some: { ebayMetadata: { path: ['stockEffect'], equals: 'stock_blocked' } } }, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true }, orderBy: { id: 'asc' }, take: PAGE,
    })
    for (const { id } of page) {
      totals.orders++
      try {
        const result = await prisma.$transaction(tx => retryBlockedEbayOrderInTx(tx, { orderId: id, actor }), { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 })
        totals.resolved += result.resolved
        totals.stillBlocked += result.stillBlocked
        for (const movement of result.movements) {
          try { await afterStockMovementCommit({ productId: movement.productId, reason: 'ORDER_PLACED' }, movement.result) }
          catch (error) { logger.warn('ebay-orders: post-commit stock hook failed', { orderId: id, productId: movement.productId, error: error instanceof Error ? error.message : String(error) }) }
        }
        if (result.poolChanged) void import('./stock-pool/pool-tasks.js').then(({ afterPoolChange }) => afterPoolChange()).catch(() => { /* the poller is the backstop */ })
      } catch (error) {
        totals.failed++
        logger.warn('ebay-orders: blocked-line retry failed; the next run retries it', { orderId: id, errorClass: failureClass(error) })
      }
    }
    if (page.length < PAGE) break
    after = page[page.length - 1].id
  }
  return totals
}
