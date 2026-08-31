// Phase 2 — In-process event bus for automation rule execution results.
// Mirrors the order-events / outbound-events pattern. SSE subscribers
// convert these into writes on the /api/advertising/execution-events stream;
// the Activity feed subscribes and auto-refreshes when any rule fires.
//
// Single-process (fine for Railway). Horizontal scaling later adds Redis pub/sub.
// Replay ring buffer: 50 events / 5 min so a briefly-closed tab reconnects
// without a full refetch.

export interface AdsExecutionEvent {
  type: 'automation.rule.fired'
  // ADX.1 — null for CAP_EXCEEDED: a cap refusal is not work, so it no longer
  // persists an AutomationRuleExecution row (writing one made the daily-cap
  // counter feed itself). The event still fires so a capped rule stays visible.
  executionId: string | null
  ruleId: string
  ruleName: string
  trigger: string
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'DRY_RUN' | 'CAP_EXCEEDED'
  dryRun: boolean
  durationMs: number | null
  marketplace: string | null
  campaignId: string | null         // local Campaign.id if present in context
  campaignName: string | null
  externalCampaignId: string | null // for Amazon deep links
  actionCount: number
  ts: number
}


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

type Listener = (event: AdsExecutionEvent) => void

/** The catalogue types this bus carries. A remote event outside this set
 *  belongs to another bus and must not be delivered here. */
const CARRIED = [
  'automation.rule.fired',
] as const satisfies readonly EventType[]

const bus = createCrossReplicaBus<AdsExecutionEvent>({
  name: 'ads-execution-sse',
  types: CARRIED,
  // Replay ring buffer: a briefly-closed tab reconnects without a full refetch.
  replay: { max: 50, ttlMs: 5 * 60_000 },
})

export function publishAdsExecution(event: AdsExecutionEvent): void {
  bus.publish(event)
}

export function subscribeAdsExecutions(listener: Listener): () => void {
  return bus.subscribe(listener)
}

export function getAdsExecutionListenerCount(): number {
  return bus.listenerCount()
}

export function replayAdsExecutionsSince(sinceMs: number): AdsExecutionEvent[] {
  return bus.replaySince(sinceMs)
}

/** Attach this process to events raised on OTHER replicas. Call once at boot. */
export async function startAdsExecutionEventIntake(): Promise<void> {
  await bus.startIntake()
}

export async function stopAdsExecutionEventIntake(): Promise<void> {
  await bus.stopIntake()
}
