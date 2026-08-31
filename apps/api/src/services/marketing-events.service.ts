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

type Listener = (event: MarketingEvent) => void

/** The catalogue types this bus carries. A remote event outside this set
 *  belongs to another bus and must not be delivered here. */
const CARRIED = [
  'campaign.mutated',
  'campaign.metrics.refreshed',
  'budget.rebalanced',
  'rule.executed',
] as const satisfies readonly EventType[]

const bus = createCrossReplicaBus<MarketingEvent>({
  name: 'marketing-sse',
  types: CARRIED,
  // Replay ring buffer: a briefly-closed tab reconnects without a full refetch.
  replay: { max: 100, ttlMs: 5 * 60_000 },
})

export function publishMarketingEvent(event: MarketingEvent): void {
  bus.publish(event)
}

export function subscribeMarketingEvents(listener: Listener): () => void {
  return bus.subscribe(listener)
}

export function getMarketingListenerCount(): number {
  return bus.listenerCount()
}

export function replayMarketingEventsSince(sinceMs: number): MarketingEvent[] {
  return bus.replaySince(sinceMs)
}

export function getMarketingReplayBufferDepth(): number {
  return bus.bufferDepth()
}

/** Attach this process to events raised on OTHER replicas. Call once at boot. */
export async function startMarketingEventIntake(): Promise<void> {
  await bus.startIntake()
}

export async function stopMarketingEventIntake(): Promise<void> {
  await bus.stopIntake()
}
