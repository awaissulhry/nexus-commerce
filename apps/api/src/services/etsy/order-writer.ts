/**
 * CX Etsy E3 — the ONE writer of an Etsy receipt into Nexus, shared by the webhook, its replays and
 * the poller.
 *
 * The receipt is read from Etsy and normalised BEFORE this runs (no network inside a transaction,
 * never a lock held over a call). Everything else is ONE READ COMMITTED transaction:
 *
 *   1. the account is still this business's active Etsy account, for the shop the receipt came from;
 *   2. Owner ruling H1 — a receipt created before the account's activation time T0 is skipped;
 *   3. the Order is inserted if absent and LOCKED, so the webhook, a replay and the poller of one
 *      receipt run one after the other;
 *   4. an older read than the one already written (Etsy's updated_timestamp) changes nothing;
 *   5. the status only ever moves forward (`mergeStatus`); money is Etsy's exact decimals, and the
 *      raw minor units of every amount go into `etsyMetadata` (OrderItem has no Etsy column);
 *   6. one OrderItem per Etsy transaction (`externalLineItemId`); SKU finds its first product,
 *      then the stored product identity survives catalog SKU changes;
 *   7. stock, by the one model every channel follows (docs/channel-connections/2026-09-26-STOCK-MODEL.md):
 *      Owner rulings (S1, changed 2026-09-26) — each product of the receipt is HELD once for the units of
 *      all its lines as soon as the receipt arrives, payment processing included; given back if the
 *      payment fails (Etsy cancels the receipt); the holds are TAKEN OUT when the WHOLE receipt has shipped (capped to what
 *      the order owes); a partial shipment keeps the holds and tells the owners; a cancellation or a
 *      full refund gives open holds back; after (part of) a shipment (C1) the lines Etsy says shipped
 *      are taken, the rest given back, nothing that shipped is put back, and the owners are told (R4). A stock problem on a line (no product, no warehouse, not enough stock,
 *      shared stock refused) is recorded on the line and told to the owners: it never blocks the
 *      receipt or the poll (R5), and a later read tries the hold again;
 *   8. the inbound ledger row is NOT this writer's: every webhook, retry and replay runs under a
 *      processing claim (PR #4), which finishes, retries or defers the row fenced by its token after
 *      this transaction commits. A stale claim holder therefore cannot complete a row.
 *
 * After the commit: the stock movements' post-commit work, shared-stock bookkeeping, and for a newly
 * cancelled receipt the shared cancellation cascade (E3: parcels, events). A failure anywhere else
 * rolls ALL of it back — no order without its stock, no stock without its order.
 */
import type { OrderStatus, Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { mergeStatus, type NormalizedEtsyReceipt, type NormalizedMoney } from './receipt-normalizer.js'
import {
  addAfter, afterOrderHoldsCommit, consumeOpenOrderInTx, nothingAfter, reserveOpenOrderInTx, resolveLocationByCode,
  StockLevelMissingError, unitsPerProduct, type OrderHoldsAfterCommit,
} from '../stock-level.service.js'
import { InsufficientStockError } from '../stock-movement.service.js'
import { PooledProductError } from '../stock-pool/pool-guard.js'
import { raiseChannelAlertInTx } from '../cx/channel-alerts.service.js'
import { noticeCancelledAfterShipment, settleCancelledOrderHoldsInTx } from '../order-cancellation/index.js'
import { matchInboundSku, type InboundSkuMatch } from '../listings/channel-sku-inbound.js'

export const etsyLineKey = (transactionId: string): string => `etsy:transaction:${transactionId}`

/**
 * A receipt in one of these holds stock for its lines. Owner ruling 2026-09-26 (replaces S1's "hold on
 * paid"): hold as soon as the receipt arrives, including while Etsy is still processing the payment
 * (AWAITING_PAYMENT: 'open' / 'payment processing', up to about three days). A payment that fails
 * makes Etsy cancel the receipt, and the cancellation gives the hold back.
 */
const HOLDING: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['AWAITING_PAYMENT', 'PROCESSING', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED'])
const SHIPPED: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['SHIPPED', 'DELIVERED'])
const ENDED: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['CANCELLED', 'REFUNDED'])
const TRANSACTION = { maxWait: 5_000, timeout: 30_000, isolationLevel: 'ReadCommitted' as const }
const ACTOR = 'etsy-orders'

export interface EtsyReceiptWrite {
  connectionId: string
  receipt: NormalizedEtsyReceipt
  source: 'webhook' | 'poll' | 'replay'
  /** A SIGNED order.delivered event for this receipt. Believed only when the receipt read shows it shipped. */
  deliveredEvent?: boolean
  /**
   * The business's warehouse, when the caller resolved it once for a run of receipts (the poller: one
   * lookup per run, not one per receipt). Omitted, the writer resolves it; `null` means "none".
   */
  locationId?: string | null
}

export interface EtsyOrderWarning {
  code: 'unmapped_line' | 'no_stock_location' | 'hold_shortfall' | 'hold_refused' | 'partly_shipped' | 'cancelled_after_shipment'
  lineKey?: string
  detail: string
}

/** What stock did for one Etsy line on this write (kept on the order, `etsyMetadata.stock`). */
export type EtsyLineStock = 'held' | 'taken' | 'released' | 'unpaid' | 'unlinked' | 'no_stock_location' | 'shortfall' | 'pool_refused' | 'not_stocked'

export type EtsyWriteOutcome =
  | {
      kind: 'written'; orderId: string; created: boolean; previousStatus: OrderStatus | null; status: OrderStatus
      /** Per Etsy transaction id. */
      stock: Record<string, EtsyLineStock>; consumed: number; released: number; warnings: EtsyOrderWarning[]
    }
  /** An older read of the receipt than the one already written. Nothing changed. */
  | { kind: 'stale'; orderId: string; storedUpdatedAt: number; incomingUpdatedAt: number }
  /** Owner ruling H1: the receipt predates the account's explicit activation. */
  | { kind: 'skipped'; reason: 'before_activation'; activatedAt: string }
  /** The account can no longer take this receipt. Nothing written; the ledger row stays failed. */
  | { kind: 'refused'; code: 'connection_inactive' | 'connection_changed' | 'not_activated'; message: string }

const raw = (m: NormalizedMoney | null) => (m ? { amount: m.amount, divisor: m.divisor, currency_code: m.currencyCode } : null)
const at = (seconds: number | null) => (seconds === null ? null : new Date(seconds * 1000))

/** Everything Etsy said that Nexus keeps but has no column for — raw minor units included. */
function etsyMetadata(receipt: NormalizedEtsyReceipt, source: EtsyReceiptWrite['source']) {
  return {
    receipt: {
      id: receipt.receiptId, shopId: receipt.shopId, sellerUserId: receipt.sellerUserId, buyerUserId: receipt.buyerUserId,
      status: receipt.etsyStatus, statusRaw: receipt.etsyStatusRaw, isPaid: receipt.isPaid, isShipped: receipt.isShipped,
      createdTimestamp: receipt.createdAt, updatedTimestamp: receipt.updatedAt,
    },
    money: {
      grandtotal: raw(receipt.grandTotal), subtotal: raw(receipt.subtotal), total_price: raw(receipt.totalPrice),
      total_shipping_cost: raw(receipt.totalShipping), total_tax_cost: raw(receipt.totalTax), total_vat_cost: raw(receipt.totalVat),
      discount_amt: raw(receipt.discount), gift_wrap_price: raw(receipt.giftWrap),
    },
    lines: Object.fromEntries(receipt.lines.map((line) => [line.transactionId, {
      price: raw(line.unitPrice), shippingCost: raw(line.shippingCost), quantity: line.quantity, lineTotal: line.lineTotal,
      listingId: line.listingId, etsyProductId: line.etsyProductId, title: line.title, paidAt: line.paidAt, shippedAt: line.shippedAt,
      stockEligible: line.stockEligible,
    }])),
    refunds: receipt.refunds.map((refund) => ({ amount: raw(refund.amount), createdTimestamp: refund.createdAt, status: refund.status })),
    checks: receipt.checks,
    source,
  }
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  return row.now
}

interface WriteResult { outcome: EtsyWriteOutcome; after: OrderHoldsAfterCommit | null }

/**
 * R5 — a stock problem on a line is told to the owners, once per order and problem (a stable occurrence
 * id): re-reads of the same receipt do not repeat it. The same notice kinds the eBay writer raises.
 */
async function noticeStockProblems(tx: Prisma.TransactionClient, args: {
  orderId: string; workspaceId: string; receiptId: string; stock: Record<string, EtsyLineStock>
  lines: Array<{ line: { transactionId: string; sku: string | null }; quantity: number; unlinkedReason?: string | null }>; warnings: EtsyOrderWarning[]
}): Promise<void> {
  const of = (effect: EtsyLineStock) => args.lines.filter(({ line }) => args.stock[line.transactionId] === effect)
  const what = (rows: ReturnType<typeof of>) => rows.map(({ line, quantity }) => `${quantity} × ${line.sku ?? `Etsy line ${line.transactionId}`}`).join(', ')
  const detail = (code: EtsyOrderWarning['code']) => args.warnings.filter((w) => w.code === code).map((w) => w.detail).join(' ')
  const raise = async (kind: 'channel-order-stock-unlinked' | 'channel-order-stock-shortfall' | 'channel-order-stock-blocked' | 'channel-order-partly-shipped', severity: 'warn' | 'danger', title: string, body: string, occurrence: string) =>
    raiseChannelAlertInTx(tx, { kind, severity, title, body, entityType: 'Order', entityId: args.orderId, href: `/orders/${args.orderId}`, meta: { channel: 'ETSY', receiptId: args.receiptId } },
      { workspaceId: args.workspaceId, actorUserId: null, occurrenceId: `etsy:${occurrence}:${args.orderId}` })
  const unlinked = of('unlinked'), short = of('shortfall'), blocked = of('no_stock_location')
  // S6 — a SKU that names several products says so, with their SKUs, instead of "matches no product".
  const reasons = [...new Set(unlinked.flatMap(({ unlinkedReason }) => (unlinkedReason ? [unlinkedReason] : [])))]
  if (unlinked.length) await raise('channel-order-stock-unlinked', 'warn', `An Etsy sale was recorded without a product: ${what(unlinked)}`,
    reasons.length
      ? `Etsy receipt ${args.receiptId} is saved, but no stock was held or taken for ${what(unlinked)}. ${reasons.join(' ')} The next read of the receipt holds it once the SKU names one product.`
      : `Etsy receipt ${args.receiptId} is saved, but ${what(unlinked)} matches no product, so no stock was held or taken for it. Link the SKU to its product; the next read of the receipt holds it.`, `unlinked:${unlinked.map(({ line }) => line.transactionId).join(',')}`)
  if (short.length) await raise('channel-order-stock-shortfall', 'danger', `An Etsy sale of ${what(short)} was recorded without stock`,
    `Etsy receipt ${args.receiptId} is saved. ${detail('hold_shortfall')} Check the stock before it ships.`, `shortfall:${short.map(({ line }) => line.transactionId).join(',')}`)
  if (blocked.length) await raise('channel-order-stock-blocked', 'danger', `An Etsy sale of ${what(blocked)} was recorded, but its stock was not held`,
    `Etsy receipt ${args.receiptId} is saved. ${detail('no_stock_location')} Do not change the stock by hand for it.`, 'blocked')
  if (args.warnings.some((w) => w.code === 'partly_shipped')) await raise('channel-order-partly-shipped', 'warn', `Etsy receipt ${args.receiptId} is partly shipped`,
    detail('partly_shipped'), 'partly-shipped')
}

/** Write one normalised Etsy receipt. See the file header for exactly what happens, in what order. */
export async function writeEtsyReceipt(input: EtsyReceiptWrite): Promise<EtsyWriteOutcome> {
  const { receipt } = input
  // A read, outside the transaction: the business's own warehouse (with the default fallback).
  const locationId = input.locationId !== undefined ? input.locationId : await resolveLocationByCode('IT-MAIN')

  const result = await prisma.$transaction(async (tx): Promise<WriteResult> => {
    // 1. The account, re-checked inside the transaction (KEY SHARE: it cannot be deleted under us).
    const [connection] = await tx.$queryRaw<Array<{ channelType: string; isActive: boolean; shopId: string | null; externalAccountId: string | null }>>`
      SELECT "channelType"::text AS "channelType", "isActive", identity->'extra'->>'shopId' AS "shopId", "externalAccountId"
      FROM "ChannelConnection" WHERE id = ${input.connectionId} FOR KEY SHARE`
    if (!connection || connection.channelType !== 'ETSY' || !connection.isActive) {
      return { outcome: { kind: 'refused', code: 'connection_inactive', message: 'The Etsy account is not an active Etsy connection of this business; nothing was written.' }, after: null }
    }
    if (String(connection.shopId ?? '') !== receipt.shopId || (receipt.sellerUserId !== null && connection.externalAccountId !== receipt.sellerUserId)) {
      return { outcome: { kind: 'refused', code: 'connection_changed', message: 'The Etsy account now names a different shop or seller than this receipt; nothing was written.' }, after: null }
    }

    // 2. Owner ruling H1 — from activation only.
    const ingest = await tx.etsyReceiptIngest.findUnique({ where: { workspace_connectionId: workspaceKey({ connectionId: input.connectionId }) }, select: { activatedAt: true } })
    if (!ingest) {
      return { outcome: { kind: 'refused', code: 'not_activated', message: 'Explicit Etsy activation is required before processing this account.' }, after: null }
    }
    if (receipt.createdAt < Math.floor(ingest.activatedAt.getTime() / 1000)) {
      return { outcome: { kind: 'skipped', reason: 'before_activation', activatedAt: ingest.activatedAt.toISOString() }, after: null }
    }

    // 3. The order: inserted if absent, then locked for the rest of the transaction.
    const inserted = await tx.order.createMany({
      skipDuplicates: true,
      data: [{
        channel: 'ETSY', channelOrderId: receipt.receiptId, status: receipt.status, totalPrice: receipt.grandTotal.decimal,
        currencyCode: receipt.currencyCode, customerName: receipt.buyer.name ?? 'Etsy buyer', customerEmail: receipt.buyer.email ?? '',
        shippingAddress: {}, channelConnectionId: input.connectionId, etsyMetadata: etsyMetadata(receipt, input.source) as never,
      }],
    })
    // NO KEY UPDATE, like the stock lock: rows that reference the order (lines, holds) take KEY SHARE.
    const [order] = await tx.$queryRaw<Array<{ id: string; workspaceId: string; status: OrderStatus; channelConnectionId: string | null; stored: string | null; paidAt: Date | null; shippedAt: Date | null; cancelledAt: Date | null; deliveredAt: Date | null; customerEmail: string }>>`
      SELECT id, "workspaceId", status::text AS status, "channelConnectionId", "etsyMetadata"->'receipt'->>'updatedTimestamp' AS stored,
             "paidAt", "shippedAt", "cancelledAt", "deliveredAt", "customerEmail"
      FROM "Order" WHERE channel = 'ETSY' AND "channelOrderId" = ${receipt.receiptId} FOR NO KEY UPDATE`
    if (!order) throw new Error(`Etsy receipt ${receipt.receiptId}: the order row could not be read back after its insert.`)
    const created = inserted.count === 1
    if (order.channelConnectionId && order.channelConnectionId !== input.connectionId) {
      return { outcome: { kind: 'refused', code: 'connection_changed', message: 'This receipt belongs to an order of another Etsy account; nothing was written.' }, after: null }
    }

    // 4. An older read changes nothing (an equal one re-applies idempotently).
    const stored = order.stored === null ? null : Number(order.stored)
    if (!created && stored !== null && Number.isFinite(stored) && receipt.updatedAt < stored) {
      return { outcome: { kind: 'stale', orderId: order.id, storedUpdatedAt: stored, incomingUpdatedAt: receipt.updatedAt }, after: null }
    }

    // 5. Status forward only; order.delivered is believed only for a receipt that shows it shipped.
    const delivered = input.deliveredEvent === true && receipt.status === 'SHIPPED'
    const previousStatus = created ? null : order.status
    const status = mergeStatus(previousStatus, delivered ? 'DELIVERED' : receipt.status)
    const now = await databaseNow(tx)
    const paidTimes = receipt.lines.map((line) => line.paidAt).filter((t): t is number => t !== null)
    const shippedTimes = receipt.lines.map((line) => line.shippedAt).filter((t): t is number => t !== null)
    await tx.order.update({
      where: { id: order.id },
      data: {
        status,
        totalPrice: receipt.grandTotal.decimal,
        currencyCode: receipt.currencyCode,
        customerName: receipt.buyer.name ?? 'Etsy buyer',
        // Etsy withholds buyer_email unless access is granted: an empty email never replaces a real one.
        ...(receipt.buyer.email ? { customerEmail: receipt.buyer.email } : {}),
        shippingAddress: {
          name: receipt.shippingAddress.name, street: receipt.shippingAddress.firstLine, street2: receipt.shippingAddress.secondLine,
          city: receipt.shippingAddress.city, state: receipt.shippingAddress.state, postalCode: receipt.shippingAddress.zip,
          country: receipt.shippingAddress.countryIso, formatted: receipt.shippingAddress.formatted,
        },
        purchaseDate: at(receipt.createdAt),
        ...(order.paidAt === null && (receipt.isPaid || paidTimes.length > 0) ? { paidAt: at(paidTimes.length ? Math.min(...paidTimes) : receipt.createdAt) } : {}),
        // R4 — any shipment, a partial one included, is recorded: a cancellation after it gives nothing back.
        ...(order.shippedAt === null && (SHIPPED.has(status) || status === 'PARTIALLY_SHIPPED' || shippedTimes.length > 0)
          ? { shippedAt: at(shippedTimes.length ? Math.max(...shippedTimes) : receipt.updatedAt) } : {}),
        ...(order.cancelledAt === null && status === 'CANCELLED' ? { cancelledAt: now } : {}),
        ...(order.deliveredAt === null && status === 'DELIVERED' && delivered ? { deliveredAt: now, deliveredAtSource: 'ETSY_WEBHOOK' } : {}),
        channelConnectionId: input.connectionId,
        etsyMetadata: etsyMetadata(receipt, input.source) as never,
      },
    })

    // 6. A linked purchase line keeps its product identity, even if the catalog renames/reuses its SKU.
    const storedItems = await tx.orderItem.findMany({ where: { orderId: order.id }, select: { externalLineItemId: true, productId: true, quantity: true } })
    const productByLine = new Map(storedItems.map((item) => [item.externalLineItemId, item.productId]))
    const quantityByLine = new Map(storedItems.map((item) => [item.externalLineItemId, item.quantity]))
    // S6 — an unlinked line's SKU through the one inbound match (this Etsy account's listings, also a SKU renamed in
    // Nexus that Etsy still holds; then the master SKU), once per SKU. Several products: not linked, with the reason.
    const matchBySku = new Map<string, InboundSkuMatch>()
    for (const line of receipt.lines) {
      const sku = line.sku?.trim() ?? ''
      if (!sku || productByLine.get(line.transactionId) || matchBySku.has(sku)) continue
      matchBySku.set(sku, await matchInboundSku(tx, { channel: 'ETSY', channelConnectionId: input.connectionId, sku }))
    }
    const lines = receipt.lines.map((line) => ({
      line, key: etsyLineKey(line.transactionId),
      // The purchase quantity as first written: what the stock guards count per product.
      quantity: quantityByLine.get(line.transactionId) ?? line.quantity,
      productId: productByLine.get(line.transactionId) ?? (line.sku ? matchBySku.get(line.sku.trim())?.productId ?? null : null),
      unlinkedReason: line.sku ? matchBySku.get(line.sku.trim())?.problem?.sentence ?? null : null,
    }))
    for (const { line, productId } of lines) {
      await tx.orderItem.upsert({
        where: { orderId_externalLineItemId: workspaceKey({ orderId: order.id, externalLineItemId: line.transactionId }) },
        // Etsy's quantity and price are purchase facts: written once, never rewritten.
        create: { orderId: order.id, externalLineItemId: line.transactionId, sku: line.sku?.trim() || `ETSY-TX-${line.transactionId}`, quantity: line.quantity, price: line.unitPrice.decimal, productId },
        update: {},
      })
      // A line that gains a product later is linked; a linked line is never re-pointed here.
      if (productId) await tx.orderItem.updateMany({ where: { orderId: order.id, externalLineItemId: line.transactionId, productId: null }, data: { productId } })
    }

    // 7. Stock — the one model every channel follows (see the file header).
    const warnings: EtsyOrderWarning[] = []
    const stock: Record<string, EtsyLineStock> = {}
    const after = nothingAfter()
    let consumed = 0
    let released = 0
    const eligible = lines.filter(({ quantity }) => quantity > 0)
    for (const { line, quantity } of lines) if (!(quantity > 0)) stock[line.transactionId] = 'not_stocked'
    const unlinked = eligible.filter(({ productId }) => !productId)
    for (const { line, key, unlinkedReason } of unlinked) {
      stock[line.transactionId] = 'unlinked'
      warnings.push({ code: 'unmapped_line', lineKey: key, detail: unlinkedReason
        ? `Etsy line ${line.transactionId} (${line.sku}): ${unlinkedReason} No stock was held or taken for it.`
        : `Etsy line ${line.transactionId} (${line.sku ?? 'no SKU'}) matches no product: no stock was held or taken for it.` })
    }
    const perProduct = unitsPerProduct(eligible.map(({ line, key, productId, quantity }) => ({ productId, quantity, transactionId: line.transactionId, key })))
      .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
    const setLines = (lines: Array<{ transactionId: string }>, effect: EtsyLineStock) => { for (const l of lines) stock[l.transactionId] = effect }
    // The whole receipt shipped: its stored status (forward only), or Etsy's own facts on this read.
    const wholeShipped = SHIPPED.has(status) || receipt.isShipped || (eligible.length > 0 && eligible.every(({ line }) => line.shippedAt !== null))
    const ended = ENDED.has(status)
    // Every product the order holds or may hold, and their pool sources, locked in ONE sorted set before
    // any stock effect (the eBay writer's door): writers of receipts with lines in opposite orders, or
    // two writers of one receipt, run one after the other instead of deadlocking.
    const lockSet = [...new Set([...perProduct.map((p) => p.productId), ...storedItems.flatMap((item) => (item.productId ? [item.productId] : []))])]
    if (lockSet.length > 0) await tx.$executeRaw`SELECT nexus_lock_order_stock(${lockSet}::text[])`

    // Held when paid; a receipt that ended AFTER it wholly shipped is held (only what is still owed)
    // so its shipped units are taken below — they left the shelf.
    if (perProduct.length > 0 && (HOLDING.has(status) || (ended && wholeShipped))) {
      if (!locationId) {
        for (const product of perProduct) setLines(product.lines, 'no_stock_location')
        warnings.push({ code: 'no_stock_location', detail: 'This business has no warehouse to hold Etsy stock in (IT-MAIN or the default one): nothing was held. Nexus holds it on the next read once one exists.' })
      } else {
        for (const product of perProduct) {
          let effect: EtsyLineStock = 'held'
          try {
            const held = await reserveOpenOrderInTx(tx, { orderId: order.id, productId: product.productId, locationId, quantity: product.quantity, actor: ACTOR })
            addAfter(after, held.after)
            if (held.via === 'refused') {
              effect = 'pool_refused'
              warnings.push({ code: 'hold_refused', lineKey: product.lines.map((l) => l.key).join(','), detail: `Shared stock refused a hold of ${product.quantity}: ${held.refusal.error}` })
            }
          } catch (error) {
            // Refusals raised after reads only, before anything was written: the transaction is intact.
            if (error instanceof InsufficientStockError || error instanceof StockLevelMissingError) {
              effect = 'shortfall'
              warnings.push({ code: 'hold_shortfall', lineKey: product.lines.map((l) => l.key).join(','),
                detail: `Not enough stock to hold ${product.quantity} (available ${error instanceof InsufficientStockError ? error.have : 0}); the Etsy sale stands, and Nexus holds it on a later read once stock is there.` })
            } else if (error instanceof PooledProductError) {
              effect = 'pool_refused'
              warnings.push({ code: 'hold_refused', lineKey: product.lines.map((l) => l.key).join(','), detail: 'This product sells from shared stock now; its own stock was not held.' })
            } else throw error
          }
          setLines(product.lines, effect)
        }
      }
    } else if (perProduct.length > 0 && !ended) {
      for (const product of perProduct) setLines(product.lines, 'unpaid')
    }

    if (wholeShipped && perProduct.length > 0) {
      // Taken out once the WHOLE receipt shipped; capped to what the order still owes (R1).
      const taken = await consumeOpenOrderInTx(tx, { orderId: order.id, actor: ACTOR })
      consumed = taken.consumed
      addAfter(after, taken.after)
      for (const [transactionId, effect] of Object.entries(stock)) if (effect === 'held') stock[transactionId] = 'taken'
    } else if (status === 'PARTIALLY_SHIPPED' && perProduct.length > 0) {
      // R3: a partial shipment keeps every hold (Etsy's order-level state cannot say which units left).
      warnings.push({ code: 'partly_shipped', detail: 'Etsy shows part of this receipt as shipped. Its stock stays held until the whole receipt has shipped; check the parcel if the rest will not follow.' })
    }

    if (ended) {
      // Open holds: given back when nothing shipped. After a partial shipment (C1) the lines Etsy says
      // shipped are taken and the rest given back; units that shipped are never put back (R4), and a
      // product Etsy does not describe keeps its hold.
      const settled = await settleCancelledOrderHoldsInTx(tx, { orderId: order.id, actor: ACTOR, reason: status === 'CANCELLED' ? 'etsy: receipt canceled' : 'etsy: receipt fully refunded' })
      released = settled.released
      consumed += settled.consumed
      addAfter(after, settled.after)
      const lineShipped = new Map(receipt.lines.map((l) => [l.transactionId, l.shippedAt !== null]))
      for (const product of perProduct) {
        const kept = (settled.products.get(product.productId)?.kept ?? 0) > 0
        for (const l of product.lines) {
          if (stock[l.transactionId] && stock[l.transactionId] !== 'held') continue
          stock[l.transactionId] = kept ? 'held' : settled.shipped && lineShipped.get(l.transactionId) ? 'taken' : 'released'
        }
      }
      if (settled.shipped) {
        warnings.push({ code: 'cancelled_after_shipment', detail: `Etsy ${status === 'CANCELLED' ? 'cancelled' : 'refunded'} this receipt after (part of) it shipped: nothing that shipped was put back into stock${settled.releasedUnits > 0 ? `; ${settled.releasedUnits} unshipped units were put back on sale` : ''}.` })
        await noticeCancelledAfterShipment(order.id, { putBack: settled.releasedUnits, kept: settled.kept }, tx)
      }
    }

    // What stock did for each line, on the order, and the owners told once per order and problem.
    await tx.order.update({ where: { id: order.id }, data: { etsyMetadata: { ...etsyMetadata(receipt, input.source), stock } as never } })
    await noticeStockProblems(tx, { orderId: order.id, workspaceId: order.workspaceId, receiptId: receipt.receiptId, stock, lines: eligible, warnings })

    return {
      outcome: { kind: 'written', orderId: order.id, created, previousStatus, status, stock, consumed, released, warnings },
      after,
    }
  }, TRANSACTION)

  if (result.after) await afterOrderHoldsCommit(result.after)
  const outcome = result.outcome
  // The shared cancellation cascade (parcels, events), as every channel runs it. Its stock half finds
  // nothing left to do here: the holds were given back above, and shipped units stay taken (R4).
  if (outcome.kind === 'written' && outcome.status === 'CANCELLED' && outcome.previousStatus !== 'CANCELLED') {
    void (async () => {
      try {
        const { handleOrderCancelled } = await import('../order-cancellation/index.js')
        await handleOrderCancelled(outcome.orderId)
      } catch (error) {
        logger.warn('[etsy-orders] cancellation cascade failed', { orderId: outcome.orderId, error: error instanceof Error ? error.message : String(error) })
      }
    })()
  }
  if (outcome.kind === 'written' && outcome.created && receipt.buyer.email) {
    import('../customer-cache.service.js').then((m) => m.linkAndRefreshCustomerForOrder(outcome.orderId)).catch((error) => {
      logger.warn('[etsy-orders] customer link failed', { orderId: outcome.orderId, error: error instanceof Error ? error.message : String(error) })
    })
  }
  return outcome
}
