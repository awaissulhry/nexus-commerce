/**
 * R4.2 — eBay returns ingest.
 *
 * Mirrors return cases from eBay's Post Order Return API into Nexus
 * Return rows so /fulfillment/returns shows eBay-initiated cases
 * alongside Amazon FBM and Shopify channel-issued refunds. The
 * canonical surface eBay exposes for "list seller's open returns"
 * still lives on the legacy Post Order API:
 *
 *   GET https://api.ebay.com/post-order/v2/return/search
 *     ?return_state=OPEN
 *     &limit=100
 *     &offset=0
 *
 * The modern Sell Fulfillment API only surfaces returns inside an
 * order's `paymentSummary.refunds[]` — no dedicated list endpoint
 * — which makes Post Order the right fit for this poller.
 *
 * Idempotency: every Return we create stamps `channelReturnId =
 * payload.returnId`. The next poll dedupes via that lookup. The
 * poller is safe to run on overlapping schedules (we never race-
 * create two Returns for the same eBay returnId thanks to the
 * lookup + the @@unique on idempotencyKey at the DB level).
 *
 * Status mapping is conservative — when in doubt, map to
 * REQUESTED so the operator sees the case in their workspace and
 * makes the call. We don't auto-promote past RECEIVED because
 * that would skip the physical-receipt confirmation.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { ebayAuthService } from '../ebay-auth.service.js'
import { recordApiCall } from '../outbound-api-call-log.service.js'

// Subset of fields we read from eBay's Post Order Return payload.
// Documented at developer.ebay.com/devzone/post-order/post-order_v2_return-search.html.
// The shape varies between OPEN/CLOSED returns; nullable everywhere
// so a partial payload doesn't crash the mapper.
export interface EbayReturnPayload {
  returnId?: string
  state?: string
  creationInfo?: {
    creationDate?: string
    type?: string
    reason?: string
    comments?: string
    item?: {
      itemId?: string
      transactionId?: string
      sku?: string
      title?: string
      quantity?: number
      amount?: { value?: number | string; currency?: string }
    }
  }
  buyerLoginName?: string
  sellerLoginName?: string
  lastModifiedDate?: string
  rmaProvided?: string | null
  // Newer/alt shape:
  returnLineItems?: Array<{
    itemId?: string
    transactionId?: string
    sku?: string
    title?: string
    quantity?: number
    amount?: { value?: number | string; currency?: string }
  }>
}

export type IngestOutcome = 'created' | 'duplicate' | 'no_lines'

export interface IngestResult {
  outcome: IngestOutcome
  returnId?: string
  channelReturnId?: string
}

// eBay return.state → our ReturnStatusFlow. Conservative defaults.
function mapEbayState(state: string | undefined): string {
  if (!state) return 'REQUESTED'
  const s = state.toUpperCase()
  if (s.includes('REQUESTED') || s.includes('PENDING')) return 'REQUESTED'
  if (s.includes('AUTHORIZED') || s.includes('WAITING_FOR_RETURN')) return 'AUTHORIZED'
  if (s.includes('IN_TRANSIT') || s.includes('SHIPPED')) return 'IN_TRANSIT'
  if (s.includes('DELIVERED') || s.includes('RECEIVED')) return 'RECEIVED'
  if (s.includes('REFUND')) return 'REFUNDED'
  if (s.includes('DENIED') || s.includes('REJECTED')) return 'REJECTED'
  if (s === 'CLOSED') return 'REFUNDED' // most CLOSED returns settled with a refund
  return 'REQUESTED'
}

function generateRmaNumber(): string {
  const d = new Date()
  const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `RMA-${yymmdd}-${rand}`
}

/**
 * Pure-ish mapper: takes a raw eBay return + DB context, persists
 * one Return + N ReturnItems (or returns 'duplicate' / 'no_lines'
 * with no writes). Designed to be unit-testable without a real
 * eBay session.
 */
export async function ingestEbayReturn(raw: EbayReturnPayload): Promise<IngestResult> {
  const channelReturnId = raw.returnId?.toString().trim()
  if (!channelReturnId) {
    return { outcome: 'no_lines' }
  }

  // Idempotency check.
  const existing = await prisma.return.findFirst({
    where: { channel: 'EBAY', channelReturnId },
    select: { id: true, channelReturnId: true },
  })
  if (existing) {
    return { outcome: 'duplicate', returnId: existing.id, channelReturnId }
  }

  // Resolve line items. eBay returns either a single creationInfo.item
  // or a returnLineItems[] depending on case type; normalize to one
  // path. Skip items without a SKU — those are non-mappable
  // adjustments.
  const lines = Array.isArray(raw.returnLineItems) && raw.returnLineItems.length > 0
    ? raw.returnLineItems
    : raw.creationInfo?.item
      ? [raw.creationInfo.item]
      : []
  const itemCreates: Array<{ sku: string; quantity: number; productId: string | null }> = []
  let amountCents = 0
  let currencyCode: string | null = null
  for (const li of lines) {
    const sku = li.sku?.trim()
    const qty = Number(li.quantity ?? 0)
    if (!sku || qty <= 0) continue
    const amount = li.amount?.value
    if (amount != null) amountCents += Math.round(Number(amount) * 100)
    if (!currencyCode && li.amount?.currency) currencyCode = li.amount.currency
    const product = await prisma.product.findUnique({
      where: { sku },
      select: { id: true },
    })
    itemCreates.push({ sku, quantity: qty, productId: product?.id ?? null })
  }
  if (itemCreates.length === 0) {
    return { outcome: 'no_lines' }
  }

  // Resolve the originating Order. Prefer matching the eBay
  // transactionId on Order.channelOrderId; fall back to itemId.
  // Orphan creates with orderId=null are fine — a later sync can
  // attach via channelReturnId.
  const txId = raw.creationInfo?.item?.transactionId
    ?? raw.returnLineItems?.[0]?.transactionId
    ?? null
  const itemId = raw.creationInfo?.item?.itemId
    ?? raw.returnLineItems?.[0]?.itemId
    ?? null
  let orderId: string | null = null
  for (const candidate of [txId, itemId].filter(Boolean) as string[]) {
    const order = await prisma.order.findFirst({
      where: { channel: 'EBAY', channelOrderId: candidate },
      select: { id: true },
    })
    if (order) { orderId = order.id; break }
  }

  const status = mapEbayState(raw.state)
  const isRefunded = status === 'REFUNDED'
  const createdAt = raw.creationInfo?.creationDate
    ? new Date(raw.creationInfo.creationDate)
    : new Date()

  const ret = await prisma.return.create({
    data: {
      orderId,
      channel: 'EBAY',
      channelReturnId,
      rmaNumber: generateRmaNumber(),
      status: status as any,
      reason: raw.creationInfo?.reason
        ? raw.creationInfo.reason.replace(/_/g, ' ').toLowerCase()
        : 'eBay return request',
      notes: raw.creationInfo?.comments?.trim() || null,
      refundStatus: isRefunded ? 'REFUNDED' : 'PENDING',
      refundCents: amountCents > 0 ? amountCents : null,
      currencyCode: currencyCode ?? 'EUR',
      // For CLOSED/refunded states we mirror the channel refund id
      // (the eBay refund id is the same as the returnId for buyer-
      // initiated returns; partial refunds carry their own id we
      // don't get here).
      channelRefundId: isRefunded ? channelReturnId : null,
      channelRefundedAt: isRefunded ? new Date() : null,
      refundedAt: isRefunded ? new Date() : null,
      createdAt,
      items: {
        create: itemCreates.map((it) => ({
          sku: it.sku,
          quantity: it.quantity,
          productId: it.productId,
        })),
      },
    },
    select: { id: true },
  })

  // Audit attribution — operators reading the timeline see the
  // poller, not a phantom local create.
  try {
    await prisma.auditLog.create({
      data: {
        userId: null,
        ip: null,
        entityType: 'Return',
        entityId: ret.id,
        action: 'create',
        metadata: {
          source: 'ebay-returns-poll',
          ebayReturnId: channelReturnId,
          ebayState: raw.state ?? null,
          mappedStatus: status,
          itemCount: itemCreates.length,
          amountCents,
          mirroredOrder: !!orderId,
        } as any,
      },
    })
  } catch (err) {
    logger.warn('ebay-returns-poll: audit write failed (non-fatal)', { err })
  }

  return { outcome: 'created', returnId: ret.id, channelReturnId }
}

/**
 * Live polling path. Walks active OAuth-managed eBay connections,
 * fetches the OPEN return queue, and ingests each. Network failures
 * mark the connection's lastSyncStatus and continue to the next
 * connection — one bad token shouldn't poison the whole sweep.
 *
 * fetchImpl override is for tests; default uses global fetch.
 */
export async function pollEbayReturns(opts?: {
  fetchImpl?: typeof fetch
  pageSize?: number
}): Promise<{
  connectionsScanned: number
  created: number
  duplicate: number
  failed: number
  noLines: number
}> {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const limit = Math.min(200, Math.max(1, opts?.pageSize ?? 100))

  const connections = await prisma.channelConnection.findMany({
    where: {
      isActive: true,
      channelType: 'EBAY',
      managedBy: 'oauth',
    },
    select: { id: true, ebaySignInName: true },
  })

  const counters = { connectionsScanned: 0, created: 0, duplicate: 0, failed: 0, noLines: 0 }

  for (const conn of connections) {
    counters.connectionsScanned++
    let token: string
    try {
      token = await ebayAuthService.getValidToken(conn.id)
    } catch (err) {
      counters.failed++
      logger.warn('ebay-returns-poll: token fetch failed', {
        connectionId: conn.id,
        signInName: conn.ebaySignInName ?? null,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    const url = `https://api.ebay.com/post-order/v2/return/search?return_state=OPEN&limit=${limit}&offset=0`
    let json: { members?: EbayReturnPayload[] }
    try {
      json = await recordApiCall<{ members?: EbayReturnPayload[] }>(
        {
          channel: 'EBAY',
          operation: 'searchReturns',
          endpoint: '/post-order/v2/return/search',
          method: 'GET',
          connectionId: conn.id,
          triggeredBy: 'cron',
        },
        async () => {
          const resp = await fetchImpl(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
            },
          })
          if (!resp.ok) {
            const errorBody = await resp.text().catch(() => '')
            const e = new Error(
              `eBay API error ${resp.status}: ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string }
            e.statusCode = resp.status
            e.body = errorBody
            throw e
          }
          return (await resp.json().catch(() => ({}))) as {
            members?: EbayReturnPayload[]
          }
        },
      )
    } catch (err) {
      counters.failed++
      const status = (err as { statusCode?: number })?.statusCode
      if (status != null) {
        logger.warn('ebay-returns-poll: non-200 from eBay', {
          connectionId: conn.id,
          status,
          error: err instanceof Error ? err.message : String(err),
        })
      } else {
        logger.warn('ebay-returns-poll: HTTP error', {
          connectionId: conn.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      continue
    }

    const members = Array.isArray(json.members) ? json.members : []

    for (const member of members) {
      try {
        const r = await ingestEbayReturn(member)
        if (r.outcome === 'created') counters.created++
        else if (r.outcome === 'duplicate') counters.duplicate++
        else counters.noLines++
      } catch (err) {
        counters.failed++
        logger.warn('ebay-returns-poll: ingest failed for one return', {
          connectionId: conn.id,
          channelReturnId: member.returnId ?? null,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  logger.info('ebay-returns-poll: complete', counters)
  return counters
}
