/**
 * P2.5 — Etsy's inbound receiver.
 *
 * There was no Etsy webhook route at all. `connectors/etsy/spec.ts` declared
 * `scheme: 'standard-webhooks'` and nothing implemented it, `utils/webhook.ts` carried
 * a note that Etsy's real order webhooks "land in CX.6", and the only Etsy order code
 * in the repository — `syncEstyOrders` — has no call site and reads five environment
 * variables production does not have. So no Etsy order has ever entered Nexus by any
 * route.
 *
 * Everything here goes through the P2.1 ledger: every arrival and every rejection is a
 * row, deduped on Etsy's own `webhook-id`, retried on failure and replayable. That is
 * what makes it safe to receive an event type nobody has seen yet — it is recorded with
 * its payload rather than guessed at, which is how P2.2's and P2.3's wrong names were
 * found.
 *
 * Etsy configures webhooks in its portal, not through an API (`subscriptionApi: false`),
 * so the Owner sets the endpoint and the signing secret there. Until then this route
 * exists and answers, and nothing arrives.
 */
import type { FastifyInstance } from 'fastify'
import { logger } from '../utils/logger.js'
import { registerRawJsonParser, type RawBodyRequest } from '../utils/webhook.js'
import { verifyStandardWebhook } from '../services/cx/ingress/standard-webhooks.js'
import { recordInbound, inboundNotRecorded, InboundDeferred } from '../services/cx/ingress/ledger.js'
import { claimInbound, runWithInboundClaim } from '../services/cx/ingress/claims.js'
import { legacyIngress, verifiedChannelWorkspace, withIngressWorkspace } from '../lib/workspace-ingress.js'

/**
 * Etsy's event names, and what Nexus does with each.
 *
 * `order.paid` is the one the plan names, so it is the one the done-when is written
 * against. The other three are the rest of an order's life. They are marked by how well
 * we know them, the same discipline P2.2 and P2.3 arrived at: an event name nobody has
 * ever received is a belief, and a belief that is never contradicted is how
 * `marketplace.order.created` survived in the eBay receiver for weeks.
 */
// https://developers.etsy.com/documentation/essentials/webhooks/ (2026-09-22).
export const ETSY_ORDER_EVENTS: Record<string, { purpose: string; evidence: 'official' }> = {
  'order.paid': { purpose: 'A receipt is paid — pull it and ingest the order.', evidence: 'official' },
  'order.shipped': { purpose: 'A receipt shipped — refresh it.', evidence: 'official' },
  'order.canceled': { purpose: 'A receipt was canceled — refresh it.', evidence: 'official' },
  'order.delivered': { purpose: 'A receipt was delivered — refresh it.', evidence: 'official' },
}

/** The receipt id an Etsy order event is about, wherever Etsy puts it. */
export function etsyReceiptIdFrom(payload: unknown): string | null {
  const body = payload as Record<string, any> | null
  // Extract IDs only. Never fetch a webhook-supplied URL, and never fall back to a
  // legacy receipt_id when a supplied resource URL is invalid or names another shop.
  if (body && 'resource_url' in body) {
    if (typeof body.resource_url !== 'string') return null
    try {
      const url = new URL(body.resource_url)
      const match = /^\/v3\/application\/shops\/([1-9]\d*)\/receipts\/([1-9]\d*)$/.exec(url.pathname)
      if (url.origin !== 'https://api.etsy.com' || url.username || url.password || url.search || url.hash || !match) return null
      return match[1] === String(body.shop_id ?? '') ? match[2] : null
    } catch { return null }
  }
  const candidates = [
    body?.receipt_id, body?.receiptId,
    body?.data?.receipt_id, body?.data?.receiptId,
    body?.object?.receipt_id, body?.payload?.receipt_id,
  ]
  for (const candidate of candidates) {
    const id = candidate === null || candidate === undefined ? '' : String(candidate)
    if (/^[1-9]\d*$/.test(id)) return id
  }
  return null
}

/**
 * Handle one Etsy order event by reading the receipt back from Etsy.
 *
 * The webhook says an order CHANGED; Etsy is asked what it now looks like. Nothing in
 * the notification body is trusted as the new state — a payload is a claim, and the
 * shop's own API is the record.
 */
export async function handleEtsyOrderEvent(
  payload: unknown,
  context?: { connectionId: string | null; eventType?: string; signal?: AbortSignal },
): Promise<void> {
  const receiptId = etsyReceiptIdFrom(payload)
  if (!receiptId) {
    throw new Error('The Etsy notification names no receipt.')
  }
  // The receiver passes the account it routed to. A REPLAY gets it from the LEDGER ROW,
  // which recorded it at arrival — not from the stored payload, which is Etsy's own
  // body and names no Nexus account.
  //
  // The first draft fell back to "the only connected Etsy shop in this workspace" and
  // the MAP.3 ratchet refused the push, correctly: a site that resolves a connection
  // without being told which account it means is how a write lands in the wrong store
  // the day a second one is connected. Asking the ledger is both safer and simpler —
  // it already knew.
  const accountId = context?.connectionId ?? null
  if (!accountId) {
    throw new Error('This Etsy notification has no connected account on its ledger row, so no shop can be asked about it.')
  }
  const { pullEtsyReceipt } = await import('../services/etsy/receipts.service.js')
  const shopId = (payload as Record<string, unknown> | null)?.shop_id
  const ingest = await import('../services/etsy/receipt-ingest.js')
  if (ingest.etsyOrderIngestEnabled()) {
    await ingestEtsyOrderEvent(accountId, receiptId, shopId == null ? null : String(shopId), context ?? { connectionId: accountId })
    return
  }
  // The switch is read by each process on its own (API receiver, worker retry, scheduler poll). With it
  // OFF here, an ACTIVATED account's event must not be finished as a read-back: the claim would mark it
  // done with no order and no hold. Hold it for a process with the switch on, spending no attempt.
  if (await ingest.etsyIngestActivated(accountId)) {
    const held = `Etsy order ingest is off in this process (${ingest.ETSY_ORDER_INGEST_FLAG} is not 1) but the account is activated: the event is held for a process with it on.`
    logger.warn('[etsy-webhooks] Etsy order ingest is off in this process; an activated account\'s event stays held', { receiptId, flag: ingest.ETSY_ORDER_INGEST_FLAG })
    throw new InboundDeferred(held, ingest.ETSY_AUTH_HOLD_MS)
  }
  // E1 — `null` is Etsy's 404 only. An expired token, a rate limit or an outage throws its own
  // typed error, which fails this event with that reason (still retryable, still a 500 to Etsy).
  const receipt = await pullEtsyReceipt(accountId, receiptId, shopId == null ? undefined : String(shopId))
  if (!receipt) {
    throw new Error(`Etsy receipt ${receiptId} was not found in this shop (HTTP 404).`)
  }
  // Ingesting a receipt into Order/OrderItem is not done here. Etsy's order shape has
  // never been observed in this installation, and P2.1 means the payload and the
  // read-back are both recorded — so the mapping can be written from a real receipt
  // instead of from a guess. Writing it now would be the same mistake as the fixture
  // in P2.2 that agreed with the bug.
  logger.warn('[etsy-webhooks] receipt read back; order ingest is not implemented yet', {
    receiptId, status: receipt.status ?? null, isPaid: receipt.is_paid ?? null,
    transactions: receipt.transactions?.length ?? 0,
  })
}

/**
 * E4 — with `NEXUS_ENABLE_ETSY_ORDER_INGEST=1`: exactly ONE account (the ledger row's) and ONE
 * receipt (the event's), read back from Etsy, normalised, and written by the shared writer, which
 * completes the ledger row in its own transaction.
 *
 * Outcomes: a sign-in problem (401, or Nexus holding the account) is deferred WITHOUT spending an
 * attempt; 429, 5xx and no answer fail with the normal back-off; Etsy's 404 and every refusal fail
 * with their code (and a refused receipt is also stored). order.delivered is believed only when
 * the receipt read shows the order shipped; otherwise the status is left alone.
 */
async function ingestEtsyOrderEvent(
  accountId: string,
  receiptId: string,
  claimedShopId: string | null,
  context: { connectionId: string | null; eventType?: string; signal?: AbortSignal },
): Promise<void> {
  const ingest = await import('../services/etsy/receipt-ingest.js')
  const { pullEtsyReceipt, EtsyReceiptReadError } = await import('../services/etsy/receipts.service.js')
  const binding = await ingest.etsyIngestBinding(accountId)
  try {
    await ingest.requireEtsyIngestActivation(accountId)
  } catch (error) {
    if (!(error instanceof ingest.EtsyIngestRefused) || error.code !== 'not_activated') throw error
    throw new InboundDeferred(error.message, ingest.ETSY_AUTH_HOLD_MS)
  }
  let raw: unknown
  try {
    raw = await pullEtsyReceipt(accountId, receiptId, claimedShopId ?? undefined)
  } catch (error) {
    if (error instanceof EtsyReceiptReadError && error.kind === 'unauthorized') {
      throw new InboundDeferred(`auth hold: ${error.message}`, ingest.ETSY_AUTH_HOLD_MS)
    }
    throw error
  }
  if (!raw) throw new ingest.EtsyIngestRefused('not_found', `Etsy receipt ${receiptId} was not found in this shop (HTTP 404).`)
  const outcome = await ingest.ingestEtsyReceipt({
    // The claim that runs this handler completes the ledger row after the write commits
    // (PR #4's processing claims); the writer does not.
    connectionId: accountId, raw, binding, source: context.eventType ? 'webhook' : 'replay',
    deliveredEvent: context.eventType === 'order.delivered',
    expectedReceiptId: receiptId, claimedShopId,
  })
  if (outcome.kind === 'receipt_refused') throw new ingest.EtsyIngestRefused(outcome.refusal.code, outcome.refusal.message)
  if (outcome.kind === 'refused') throw new ingest.EtsyIngestRefused(outcome.code, outcome.message)
  logger.info('[etsy-webhooks] receipt ingested', {
    receiptId, outcome: outcome.kind,
    ...(outcome.kind === 'written' ? { status: outcome.status, created: outcome.created, warnings: outcome.warnings.map((w) => w.code) } : {}),
    ...(outcome.kind === 'skipped' ? { reason: outcome.reason } : {}),
  })
}

export default async function etsyWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Etsy signs the exact bytes it sent.
  registerRawJsonParser(app)

  app.post('/webhooks/etsy', async (request, reply) => {
    const body = (request as RawBodyRequest).rawBody
    const payload = request.body as Record<string, any> | undefined
    const eventType = String(
      payload?.event_type ?? payload?.event ?? payload?.type ?? 'unknown',
    )

    const secret = process.env.ETSY_WEBHOOK_SIGNING_SECRET || null
    const verdict = verifyStandardWebhook({
      rawBody: body ?? null,
      headers: {
        id: request.headers['webhook-id'],
        timestamp: request.headers['webhook-timestamp'],
        signature: request.headers['webhook-signature'],
      },
      secret,
    })

    if (!verdict.ok) {
      // Recorded, as every rejection is since P2.1 — a forged notification and one that
      // never arrived must not look the same afterwards. Keyed on the body digest, not
      // on the `webhook-id` the sender claims: `(channel, externalId)` is unique, and a
      // forgery naming a real delivery id would sit in that slot and make the genuine
      // delivery look like a duplicate.
      await legacyIngress(() =>
        recordInbound({
          channel: 'ETSY', eventType, externalId: null, rawBody: body ?? null,
          payload: payload ?? {}, signatureOk: false, verifiedBy: 'none',
          status: 'failed', lastError: `standard-webhooks verification failed: ${verdict.reason}`,
        }),
      )
      logger.warn('[etsy-webhooks] signature rejected', { eventType, reason: verdict.reason })
      // 401, not 204: a sender told nothing is a sender that believes it succeeded.
      return reply.status(401).send({ error: 'Signature verification failed.' })
    }

    // Verified, so the shop it names can be trusted as a routing key.
    const shopId = String(payload?.shop_id ?? payload?.shopId ?? payload?.data?.shop_id ?? '')
    let route: { workspaceId: string; connectionId: string }
    try {
      if (!/^[1-9]\d*$/.test(shopId)) throw new Error('The notification has no valid shop id.')
      route = await verifiedChannelWorkspace('ETSY', shopId)
    } catch (error) {
      await legacyIngress(() =>
        recordInbound({
          channel: 'ETSY', eventType, externalId: verdict.webhookId ?? null, rawBody: body ?? null,
          payload: payload ?? {}, signatureOk: true, verifiedBy: 'none', status: 'failed',
          lastError: `no connected Etsy shop matches ${shopId || '(no shop id in the payload)'}: ${error instanceof Error ? error.message : String(error)}`,
        }),
      )
      logger.error('[etsy-webhooks] verified notification needs a shop', { eventType, shopId })
      return reply.status(503).send({ error: 'The shop on this notification is not connected.' })
    }

    return withIngressWorkspace(route.workspaceId, async () => {
      const ingestOn = process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST === '1'
      const written = await recordInbound({
        channel: 'ETSY', eventType,
        // Etsy's own delivery id, which is stable across ITS retries and different for
        // every new change to the same receipt.
        externalId: verdict.webhookId ?? null,
        rawBody: body ?? null, payload: payload ?? {},
        signatureOk: true, verifiedBy: 'none', connectionId: route.connectionId, status: 'pending',
        headers: request.headers,
      })
      if (!written.id) {
        logger.error(`[etsy-webhooks] not acked: ${inboundNotRecorded(written)}`, { eventType })
        return reply.status(503).send({ error: `Not recorded: ${inboundNotRecorded(written)}.` })
      }
      if (ingestOn) {
        // E6 — the account's last verified delivery (never counted as freshness; only a poll is).
        await (await import('../services/etsy/receipt-ingest.js')).stampEtsyInbound(route.connectionId)
      }
      if (written.duplicate && written.existingStatus === 'done') {
        return reply.send({ success: true, message: 'Already processed' })
      }
      const claim = await claimInbound(written.id)
      if (!claim) return reply.send({ success: true, queued: true })
      if (!ETSY_ORDER_EVENTS[eventType]) {
        // Not a failure. An event we have no use for is recorded and acknowledged; the
        // ledger row is how its real name and shape get learned.
        await runWithInboundClaim(claim, async () => {})
        logger.info('[etsy-webhooks] recorded an event with no handler', { eventType })
        return reply.send({ success: true, message: 'Recorded' })
      }
      try {
        await runWithInboundClaim(claim, (stored, signal) => handleEtsyOrderEvent(stored.payload, { connectionId: stored.connectionId, eventType: stored.eventType, signal }))
        return reply.send({ success: true })
      } catch (error) {
        if (error instanceof InboundDeferred) {
          // The claim rescheduled it without spending an attempt; Etsy is told to try again too.
          logger.warn('[etsy-webhooks] deferred', { eventType, error: error.message })
          return reply.status(503).send({ error: error.message })
        }
        const message = error instanceof Error ? error.message : String(error)
        logger.error('[etsy-webhooks] handling failed', { eventType, error: message })
        return reply.status(500).send({ error: message })
      }
    })
  })

}
