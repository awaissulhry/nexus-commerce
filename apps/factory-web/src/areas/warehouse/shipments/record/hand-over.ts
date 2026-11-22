import { HAND_OVER_LIMITS } from '@nexus/factory-domain/shipping/shipments'
import { words, type Words } from '../queue/shared/depth'
import { REASON_LIMITS } from '../queue/move/model'

/**
 * F-OS-203 (order SHIPMENTS tab; 13-backend B-OS-014) — Mark handed over at the time the goods really left, pure: now (nothing to
 * type), or a time not before the shipment was packed or its DDT issued, not in the future (a few minutes' clock slack), not more
 * than 60 days back (made elsewhere's span); more than a quarter of an hour ago says why (3 to 500 characters, office words: the
 * audit keeps it). Stock and the cost of sales still post at the click (the API's rule). The API keeps the last word.
 */

export interface HandOverAt {
  /** The time typed (a local date-time the field gives), or null: now. */
  readonly when: string | null
  readonly reason: string
}

/** The API's own limits (factory-domain shipping/shipments handOverTimeProblems). */
export { HAND_OVER_LIMITS }

/** What stops the time typed (null: it may go). The words are the lane's (`order-shipments`: door.handOver.*). */
export function handOverTimeProblem(at: HandOverAt, facts: { readonly packedAt: string | null; readonly ddtAt: string | null }, now: Date = new Date()): Words | null {
  if (!at.when) return null
  const time = Date.parse(at.when)
  if (!Number.isFinite(time)) return words('door.handOver.notATime')
  if (time > now.getTime() + HAND_OVER_LIMITS.futureSkewMs) return words('door.handOver.future')
  if (time < now.getTime() - HAND_OVER_LIMITS.pastDays * 86_400_000) return words('door.handOver.tooOld', { days: HAND_OVER_LIMITS.pastDays })
  if (facts.packedAt && time < Date.parse(facts.packedAt)) return words('door.handOver.beforePacked')
  if (facts.ddtAt && time < Date.parse(facts.ddtAt)) return words('door.handOver.beforeDdt')
  const reason = at.reason.trim()
  if (time < now.getTime() - HAND_OVER_LIMITS.reasonAfterMs && reason.length < REASON_LIMITS.min) return words('door.handOver.why')
  if (reason.length > REASON_LIMITS.max) return words('move.held.wordsLong', { max: REASON_LIMITS.max })
  return null
}

/** What the hand-over sends beside its version: the time with its reason when it is not now (now: nothing). */
export function handOverBody(at: { readonly shippedAt: string; readonly reason: string | null } | null): { shippedAt?: string; reason?: string } {
  if (!at) return {}
  return { shippedAt: at.shippedAt, ...(at.reason ? { reason: at.reason } : {}) }
}
