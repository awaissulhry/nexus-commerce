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

type Listener = (event: ReviewEvent) => void

const listeners = new Set<Listener>()

const REPLAY_BUFFER_MAX = 100
const REPLAY_BUFFER_TTL_MS = 5 * 60_000
const replayBuffer: ReviewEvent[] = []

function trimReplayBuffer(): void {
  const cutoff = Date.now() - REPLAY_BUFFER_TTL_MS
  while (replayBuffer.length > 0 && replayBuffer[0]!.ts < cutoff) {
    replayBuffer.shift()
  }
  while (replayBuffer.length > REPLAY_BUFFER_MAX) {
    replayBuffer.shift()
  }
}

export function publishReviewEvent(event: ReviewEvent): void {
  if (event.type !== 'ping') {
    replayBuffer.push(event)
    trimReplayBuffer()
  }
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A misbehaving listener mustn't break the bus for others.
    }
  }
}

export function subscribeReviewEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function replayReviewEventsSince(sinceMs: number): ReviewEvent[] {
  trimReplayBuffer()
  return replayBuffer.filter((e) => e.ts > sinceMs)
}

export function getReviewListenerCount(): number {
  return listeners.size
}
