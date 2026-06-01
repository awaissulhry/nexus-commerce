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
  executionId: string
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

type Listener = (e: AdsExecutionEvent) => void

const listeners = new Set<Listener>()

const BUFFER_MAX = 50
const BUFFER_TTL = 5 * 60_000
const buffer: AdsExecutionEvent[] = []

function trim(): void {
  const cut = Date.now() - BUFFER_TTL
  while (buffer.length > 0 && buffer[0]!.ts < cut) buffer.shift()
  while (buffer.length > BUFFER_MAX) buffer.shift()
}

export function publishAdsExecution(event: AdsExecutionEvent): void {
  buffer.push(event); trim()
  for (const l of listeners) { try { l(event) } catch { /* listener fault isolation */ } }
}

export function subscribeAdsExecutions(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function replayAdsExecutionsSince(sinceMs: number): AdsExecutionEvent[] {
  trim(); return buffer.filter(e => e.ts > sinceMs)
}

export function getAdsExecutionListenerCount(): number { return listeners.size }
