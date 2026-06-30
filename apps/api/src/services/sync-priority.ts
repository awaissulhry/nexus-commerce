/**
 * Phase 4 — order-driven outbound pushes (a real sale) should win the worker
 * over manual edits when jobs queue up. BullMQ: lower number = higher priority;
 * absent = normal. This is a deliberate SUBSET of stock-movement's broader
 * ORDER_DRIVEN_REASONS (the delay:0 set) — only true sales/customer events
 * warrant the highest-priority slot; RETURN_RECEIVED (a restock receipt) fires
 * immediately but does not need to jump ahead of other pushes.
 */
const ORDER_DRIVEN = new Set(['ORDER_PLACED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'RETURN_RESTOCKED'])

export function outboundEnqueuePriority(reason: string): number | undefined {
  return ORDER_DRIVEN.has(reason) ? 1 : undefined
}
