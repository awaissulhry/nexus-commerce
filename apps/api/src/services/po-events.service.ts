/**
 * PO.4 — In-process event bus for purchase-order mutations.
 *
 * Mirrors inbound-events.service.ts (H.14) so subscribers can react
 * to PO state changes without polling. SSE handler in
 * fulfillment.routes.ts converts each event to a wire write.
 *
 * Listener model: single-process, in-memory. Good for Xavia's scale.
 * If we ever scale horizontally on Railway, swap for Redis pub/sub —
 * the publish/subscribe API stays the same.
 *
 * Events are intentionally lean — { type, poId, ts, optional context }
 * — because subscribers refetch fresh state on receipt. Sending the
 * full PO would couple wire format to the DB shape.
 */

export type PoEvent =
  | { type: 'po.created'; poId: string; poNumber: string; ts: number }
  | {
      type: 'po.transitioned'
      poId: string
      poNumber: string
      fromStatus: string
      toStatus: string
      ts: number
    }
  | { type: 'po.updated'; poId: string; reason?: string; ts: number }
  | { type: 'po.deleted'; poId: string; ts: number }
  | { type: 'po.restored'; poId: string; ts: number }
  | { type: 'po.received'; poId: string; shipmentId: string; ts: number }
  | { type: 'ping'; ts: number }


// ── EV.3 — cross-replica via the shared bus factory ─────────────────────────
//
// Signatures and synchronous behaviour are UNCHANGED. What changed is that a
// publish also fans out to other replicas, and this process receives theirs.
//
// 🔴 The PoEventLog persistence runs on the LOCAL publish only, via the
// factory's onPublish hook. A remote event must NOT re-persist it: the replica
// that published it already wrote the row, and repeating it would duplicate
// every audit entry once per running instance.

import { createCrossReplicaBus } from '../lib/events/bus.js'
import type { EventType } from '@nexus/events'

type Listener = (event: PoEvent) => void

/** The catalogue types this bus carries. */
const CARRIED = [
  'po.created', 'po.transitioned', 'po.updated', 'po.deleted', 'po.restored', 'po.received',
] as const satisfies readonly EventType[]

/**
 * PO-Plus.8 — persist every non-ping event to PoEventLog so the audit trail
 * survives a restart. Fire-and-forget: failures are logged but never block the
 * in-process listeners (the SSE pipe is the operator-facing path; the row is
 * forensics).
 */
async function persistPoEvent(event: PoEvent): Promise<void> {
  // Dynamic import keeps this service runnable without the DB layer wired
  // (e.g. in unit tests that exercise the bus behaviour).
  const { default: prisma } = await import('../db.js')
  const anyEvent = event as any
  await prisma.poEventLog.create({
    data: {
      poId: anyEvent.poId ?? null,
      poNumber: anyEvent.poNumber ?? null,
      type: event.type,
      reason: anyEvent.reason ?? null,
      payload: event as unknown as import('@prisma/client').Prisma.InputJsonValue,
    },
  })
}

const bus = createCrossReplicaBus<PoEvent>({
  name: 'po-sse',
  types: CARRIED,
  onPublish: (event) => {
    void persistPoEvent(event).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[po-events] PoEventLog persist failed for ${event.type}:`,
        err instanceof Error ? err.message : String(err),
      )
    })
  },
})

export function publishPoEvent(event: PoEvent): void {
  bus.publish(event)
}

export function subscribePoEvents(listener: Listener): () => void {
  return bus.subscribe(listener)
}

export function getPoListenerCount(): number {
  return bus.listenerCount()
}

/** Attach this process to PO events raised on OTHER replicas. Call once at boot. */
export async function startPoEventIntake(): Promise<void> {
  await bus.startIntake()
}

export async function stopPoEventIntake(): Promise<void> {
  await bus.stopIntake()
}
