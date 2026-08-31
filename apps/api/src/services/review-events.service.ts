// RX.3 — In-process event bus for review mutations.
//
// Mirrors order-events.service.ts (O.6 / RT.8). SSE subscribers on
// /api/reviews/events turn these into writes on the response stream so
// the review Feed + Response Desk auto-refresh, and negative reviews /
// spikes fire operator alerts + (opt-in) browser notifications without a
// manual F5.
//
// Single-process design (fine for current Railway scale). Payloads stay
// lightweight: subscribers re-fetch on receipt rather than apply deltas.

export type ReviewEvent =
  | {
      type: 'review.created'
      reviewId: string
      channel: string
      marketplace?: string | null
      rating?: number | null
      label?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | null
      productId?: string | null
      ts: number
    }
  // Fired in addition to review.created when sentiment is NEGATIVE (or
  // rating ≤ 2). Drives the negative-review toast + browser notification.
  | {
      type: 'review.negative'
      reviewId: string
      channel: string
      marketplace?: string | null
      rating?: number | null
      productId?: string | null
      productName?: string | null
      excerpt?: string
      ts: number
    }
  | {
      type: 'review.spike.detected'
      spikeId: string
      productId: string | null
      marketplace: string
      category: string
      multiplier: number | null
      ts: number
    }
  | { type: 'review.responded'; reviewId: string; channel: string; ts: number }
  | { type: 'ping'; ts: number }


// ── EV.3 — cross-replica via the shared bus factory ─────────────────────────
//
// Signatures, synchronous behaviour AND the replay buffer are unchanged: every
// call site is untouched, a local subscriber still receives an event in the
// same tick, and a briefly-disconnected tab still replays. What changed is
// that a publish also fans out to other replicas, and this process receives
// theirs — so a reconnecting tab replays what happened on ANY instance, not
// just the one it happens to be attached to.
//
// The bus logic is lib/events/bus.ts, shared rather than copied.

import { createCrossReplicaBus } from '../lib/events/bus.js'
import type { EventType } from '@nexus/events'

type Listener = (event: ReviewEvent) => void

/** The catalogue types this bus carries. A remote event outside this set
 *  belongs to another bus and must not be delivered here. */
const CARRIED = [
  'review.created',
  'review.negative',
  'review.spike.detected',
  'review.responded',
] as const satisfies readonly EventType[]

const bus = createCrossReplicaBus<ReviewEvent>({
  name: 'review-sse',
  types: CARRIED,
  // Replay ring buffer: a briefly-closed tab reconnects without a full refetch.
  replay: { max: 100, ttlMs: 5 * 60_000 },
})

export function publishReviewEvent(event: ReviewEvent): void {
  bus.publish(event)
}

export function subscribeReviewEvents(listener: Listener): () => void {
  return bus.subscribe(listener)
}

export function getReviewListenerCount(): number {
  return bus.listenerCount()
}

export function replayReviewEventsSince(sinceMs: number): ReviewEvent[] {
  return bus.replaySince(sinceMs)
}

/** Attach this process to events raised on OTHER replicas. Call once at boot. */
export async function startReviewEventIntake(): Promise<void> {
  await bus.startIntake()
}

export async function stopReviewEventIntake(): Promise<void> {
  await bus.stopIntake()
}
