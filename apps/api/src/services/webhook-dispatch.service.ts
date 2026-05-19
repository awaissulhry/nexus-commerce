/**
 * Phase E follow-up — outbound webhook dispatcher.
 *
 * Single entry point: emitWebhookEvent(eventType, payload). Looks
 * up every active NotificationWebhook whose events[] includes the
 * eventType (or whose events[] is empty = "subscribe to all"),
 * signs the payload with each subscription's stored secret, and
 * fires the POST.
 *
 * Per-subscription bookkeeping after each delivery:
 *   • 2xx → lastFiredAt, lastStatus=<code>, lastError=null,
 *           consecutiveFails reset to 0
 *   • non-2xx / network error → lastError populated,
 *           consecutiveFails += 1
 *
 * Subscriptions whose consecutiveFails crosses a threshold (10)
 * get isActive flipped off — we don't want to keep spamming an
 * endpoint that's clearly dead. The operator can Resume from
 * /settings/webhooks once the receiver is back.
 *
 * Fire-and-forget by design: emitWebhookEvent returns immediately
 * with a Promise the caller can await if they want delivery
 * confirmation, but the standard usage is `void emitWebhookEvent(…)`
 * so the request that triggered the event isn't slowed down.
 *
 * Rows with a bcrypt-shaped secret (created during the brief
 * Phase E window before the signing-secret format flip) are
 * skipped with a logged warning; the operator must recreate the
 * subscription to get a usable signing key.
 */

import { createHmac } from 'crypto'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

// Same shape as the test-payload signing in the routes file.
function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

const FAILS_BEFORE_AUTO_PAUSE = 10
const DELIVERY_TIMEOUT_MS = 8_000

export interface WebhookEventPayload {
  /** The event-type, must match one of the canonical strings
   *  registered in apps/web/src/app/settings/notifications/event-types.ts.
   *  Empty events[] subscriptions match everything. */
  event: string
  /** Stable id for the receiver's idempotency check. */
  deliveryId?: string
  /** Free-form payload. JSON-serialisable; gets sent as-is. */
  data: Record<string, unknown>
}

interface DispatchResult {
  matched: number
  delivered: number
  failed: number
  skipped: number
}

/**
 * Emit one event to every matching subscription. Returns a
 * summary; downstream calls usually `void` this Promise.
 */
export async function emitWebhookEvent(
  input: WebhookEventPayload,
): Promise<DispatchResult> {
  const result: DispatchResult = {
    matched: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
  }
  try {
    // Pull every active subscription. Filter event-match in JS
    // because Prisma can't do "events is empty OR contains X" in
    // one where-clause cleanly across Postgres + SQLite.
    const subs = await (prisma as any).notificationWebhook.findMany({
      where: { isActive: true },
    })
    const matching = subs.filter(
      (s: any) =>
        !Array.isArray(s.events) ||
        s.events.length === 0 ||
        s.events.includes(input.event),
    )
    result.matched = matching.length
    if (matching.length === 0) return result

    const deliveryId =
      input.deliveryId ?? randomDeliveryId()
    const envelope = JSON.stringify({
      event: input.event,
      deliveryId,
      timestamp: new Date().toISOString(),
      data: input.data,
    })

    // Fire all in parallel — the receivers run on the operator's
    // own infrastructure and each one's latency is independent.
    await Promise.allSettled(
      matching.map((sub: any) => deliverOne(sub, envelope, result)),
    )
  } catch (err) {
    logger.error('webhook-dispatch: lookup failed', {
      event: input.event,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return result
}

async function deliverOne(
  sub: any,
  envelope: string,
  result: DispatchResult,
): Promise<void> {
  const looksLikeBcrypt =
    typeof sub.secretHash === 'string' && sub.secretHash.startsWith('$2')
  if (looksLikeBcrypt) {
    result.skipped++
    logger.warn(
      'webhook-dispatch: skipped legacy bcrypted subscription — operator must recreate to enable dispatch',
      { subscriptionId: sub.id, label: sub.label },
    )
    return
  }
  const signature = signPayload(sub.secretHash, envelope)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
  let status = 0
  let errText: string | null = null
  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Nexus-Event': sub.events?.[0] ?? 'event',
        'X-Nexus-Signature': `sha256=${signature}`,
      },
      body: envelope,
      signal: controller.signal,
    })
    status = res.status
    if (!(status >= 200 && status < 300)) {
      errText = (await res.text().catch(() => null)) ?? `HTTP ${status}`
    }
  } catch (err) {
    errText = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timeout)
  }

  const success = status >= 200 && status < 300
  if (success) result.delivered++
  else result.failed++

  // Bookkeeping — update per-subscription stats. We tolerate a DB
  // error here (logged + swallowed) so a transient Prisma blip
  // doesn't crash the request that emitted the event.
  try {
    const nextFails = success ? 0 : (sub.consecutiveFails ?? 0) + 1
    const autoPause = !success && nextFails >= FAILS_BEFORE_AUTO_PAUSE
    await (prisma as any).notificationWebhook.update({
      where: { id: sub.id },
      data: {
        lastFiredAt: new Date(),
        lastStatus: status,
        lastError: errText,
        consecutiveFails: nextFails,
        ...(autoPause ? { isActive: false } : {}),
      },
    })
    if (autoPause) {
      logger.warn('webhook-dispatch: auto-paused after consecutive failures', {
        subscriptionId: sub.id,
        label: sub.label,
        consecutiveFails: nextFails,
      })
    }
  } catch (writeErr) {
    logger.error('webhook-dispatch: bookkeeping write failed', {
      subscriptionId: sub.id,
      error: writeErr instanceof Error ? writeErr.message : String(writeErr),
    })
  }
}

function randomDeliveryId(): string {
  // 16 hex chars — enough entropy for idempotency on the receiver
  // side without a full UUID's verbosity.
  const bytes = new Uint8Array(8)
  // Node's webcrypto via globalThis.crypto. Available on Node 19+.
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    // Fallback shouldn't trigger; left for defensive completeness.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
