/**
 * The inbound ledger — one writer for every channel (CX.4a).
 *
 * Before this, an inbound event was recorded only once it had already been accepted:
 * the Amazon SQS poll wrote a row per message, and the eBay receiver wrote nothing at
 * all unless the payload passed a check that could never pass. A rejected notification
 * left a `logger.warn` and a 204, which is to say it left nothing an operator could
 * find later.
 *
 * So the rule here is that arrival is what creates the row, not acceptance. A
 * notification we could not verify is a row with `signatureOk = false` and a reason;
 * a notification on a transport that carries no signature is a row with
 * `signatureOk = null` and the name of what did establish trust. Both can be counted.
 * Neither can be confused for the other.
 */
import crypto from 'node:crypto'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'

export type InboundStatus = 'pending' | 'done' | 'failed' | 'dlq'

/** What established trust for this event, or that nothing did. */
export type VerifiedBy = 'ebay_ecdsa' | 'sqs_iam' | 'shopify_hmac' | 'none'

export interface InboundRecord {
  channel: string
  eventType: string
  /** The channel's own id when it gives one; a body digest is used when it does not. */
  externalId?: string | null
  rawBody?: Buffer | null
  payload: unknown
  /** true = checked and passed · false = checked and failed · null = nothing to check. */
  signatureOk: boolean | null
  verifiedBy: VerifiedBy
  connectionId?: string | null
  providerTimestamp?: Date | null
  lastError?: string | null
  status?: InboundStatus
}

export interface InboundWriteResult {
  id: string | null
  duplicate: boolean
}

export function digestOf(body: Buffer | string | null | undefined): string | null {
  if (body === null || body === undefined) return null
  return crypto.createHash('sha256').update(body).digest('hex')
}

/**
 * Write one arrival. Idempotent on `(channel, externalId)`: a redelivery does not
 * rewrite the original verdict, it only increments `attempts`, so "how often did this
 * arrive" and "what did we decide the first time" stay separately answerable.
 *
 * Never throws. An ingress endpoint that 500s because its audit trail is unavailable
 * would turn a logging problem into dropped notifications — and eBay marks an endpoint
 * down when it stops answering.
 */
export async function recordInbound(rec: InboundRecord): Promise<InboundWriteResult> {
  const payloadDigest = digestOf(rec.rawBody ?? null)
  const externalId =
    rec.externalId && rec.externalId !== ''
      ? rec.externalId
      : payloadDigest
        ? `sha256:${payloadDigest}`
        : `unidentified:${crypto.randomUUID()}`
  const status: InboundStatus = rec.status ?? (rec.signatureOk === false ? 'failed' : 'pending')

  try {
    const existing = await prisma.webhookEvent.findUnique({
      where: { channel_externalId: { channel: rec.channel, externalId } },
      select: { id: true },
    })
    if (existing) {
      await prisma.webhookEvent.update({
        where: { id: existing.id },
        data: { attempts: { increment: 1 } },
      })
      return { id: existing.id, duplicate: true }
    }
    const row = await prisma.webhookEvent.create({
      data: {
        channel: rec.channel,
        eventType: rec.eventType,
        externalId,
        payload: (rec.payload ?? {}) as never,
        isProcessed: status === 'done',
        processedAt: status === 'done' ? new Date() : null,
        providerTimestamp: rec.providerTimestamp ?? null,
        connectionId: rec.connectionId ?? null,
        status,
        signatureOk: rec.signatureOk,
        verifiedBy: rec.verifiedBy,
        payloadDigest,
        lastError: rec.lastError ?? null,
        error: rec.lastError ?? null,
      },
      select: { id: true },
    })
    return { id: row.id, duplicate: false }
  } catch (err) {
    logger.error('[cx-ingress] could not record an inbound event', {
      channel: rec.channel,
      eventType: rec.eventType,
      error: err instanceof Error ? err.message : String(err),
    })
    return { id: null, duplicate: false }
  }
}

/** Mark an event processed, or failed with a reason. */
export async function completeInbound(id: string | null, ok: boolean, error?: string): Promise<void> {
  if (!id) return
  try {
    await prisma.webhookEvent.update({
      where: { id },
      data: ok
        ? { status: 'done', isProcessed: true, processedAt: new Date(), lastError: null }
        : { status: 'failed', lastError: (error ?? 'unknown').slice(0, 500), error: (error ?? 'unknown').slice(0, 500) },
    })
  } catch (err) {
    logger.warn('[cx-ingress] could not close out an inbound event', { id, error: err instanceof Error ? err.message : String(err) })
  }
}
