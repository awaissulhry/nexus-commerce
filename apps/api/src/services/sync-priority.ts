/**
 * Phase 4 — order-driven outbound pushes (a real sale) should win the worker
 * over manual edits when jobs queue up. BullMQ: lower number = higher priority;
 * absent = normal. Mirrors the ORDER_DRIVEN_REASONS set used for the delay:0 path.
 */
const ORDER_DRIVEN = new Set(['ORDER_PLACED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'RETURN_RESTOCKED'])

export function outboundEnqueuePriority(reason: string): number | undefined {
  return ORDER_DRIVEN.has(reason) ? 1 : undefined
}
