// UM-series (P3) — in-process event bus for Unified Marketing OS.
//
// Mirrors order-events.service.ts (O.6) exactly: single-process bus,
// lightweight payloads (subscribers re-fetch on receipt), a replay ring
// buffer for reconnecting tabs (?since=<ts>), and a heartbeat-friendly
// SSE endpoint at /api/marketing/os/events.
//
// The cockpit roster / calendar / budget center / automation studio all
// subscribe so they auto-refresh when:
//   • the backfill or a forward shadow-sync upserts campaigns (P2/P5)
//   • metrics ingest refreshes performance (P2/P5)
//   • a budget pool rebalances (P7)
//   • an automation rule executes (P6)
//
// Single-process is fine at current Railway scale; horizontal scaling
// later swaps in Redis pub/sub without changing this public API.

export type MarketingEvent =
  // A campaign (any channel) was created / updated / status-changed.
  | {
      type: 'campaign.mutated'
      campaignId: string
      channel: string
      action: 'created' | 'updated' | 'status' | 'deleted'
      ts: number
    }
  // Daily performance metrics refreshed for a channel/marketplace window.
  | {
      type: 'campaign.metrics.refreshed'
      channel: string
      marketplace?: string | null
      rows: number
      ts: number
    }
  // A cross-channel budget pool finished a rebalance (P7).
  | {
      type: 'budget.rebalanced'
      budgetId: string
      dryRun: boolean
      totalShiftCents: number
      ts: number
    }
  // An automation rule (domain=marketing) executed (P6).
  | {
      type: 'rule.executed'
      ruleId: string
      executionId: string
      status: string
      ts: number
    }
  | { type: 'ping'; ts: number }

type Listener = (event: MarketingEvent) => void

const listeners = new Set<Listener>()

// Replay ring buffer — same sizing rationale as order-events (a ~5-min
// tab suspend almost always finds its events; longer gaps fall back to a
// full re-fetch). Negligible memory.
const REPLAY_BUFFER_MAX = 100
const REPLAY_BUFFER_TTL_MS = 5 * 60_000
const replayBuffer: MarketingEvent[] = []

function trimReplayBuffer(): void {
  const cutoff = Date.now() - REPLAY_BUFFER_TTL_MS
  while (replayBuffer.length > 0 && replayBuffer[0]!.ts < cutoff) {
    replayBuffer.shift()
  }
  while (replayBuffer.length > REPLAY_BUFFER_MAX) {
    replayBuffer.shift()
  }
}

export function publishMarketingEvent(event: MarketingEvent): void {
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

export function subscribeMarketingEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getMarketingListenerCount(): number {
  return listeners.size
}

export function replayMarketingEventsSince(sinceMs: number): MarketingEvent[] {
  trimReplayBuffer()
  return replayBuffer.filter((e) => e.ts > sinceMs)
}

export function getMarketingReplayBufferDepth(): number {
  trimReplayBuffer()
  return replayBuffer.length
}
