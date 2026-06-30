/**
 * Phase 0 — pure metric helpers for inventory-sync instrumentation.
 *
 * Outbound latency = OutboundSyncQueue.syncedAt - createdAt, grouped by
 * targetChannel. Mirrors the inbound RT.3 push-latency math so the two
 * dashboards read the same way. No DB or IO here — all pure + tested.
 */

export interface HistogramBucket {
  bucket: string
  count: number
}

export interface LatencyStats {
  sampleCount: number
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  minMs: number | null
  maxMs: number | null
  histogram: HistogramBucket[]
}

export const LATENCY_BUCKETS: Array<{ label: string; maxMs: number }> = [
  { label: '0-1s', maxMs: 1_000 },
  { label: '1-5s', maxMs: 5_000 },
  { label: '5-15s', maxMs: 15_000 },
  { label: '15-60s', maxMs: 60_000 },
  { label: '1-5min', maxMs: 5 * 60_000 },
  { label: '5-15min', maxMs: 15 * 60_000 },
  { label: '15-60min', maxMs: 60 * 60_000 },
  { label: '>1h', maxMs: Number.POSITIVE_INFINITY },
]

function percentile(sortedMs: number[], pct: number): number | null {
  if (sortedMs.length === 0) return null
  const rank = Math.ceil((pct / 100) * sortedMs.length)
  return sortedMs[Math.max(0, Math.min(sortedMs.length - 1, rank - 1))] ?? null
}

function bucketIndex(ms: number): number {
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
    if (ms <= LATENCY_BUCKETS[i]!.maxMs) return i
  }
  return LATENCY_BUCKETS.length - 1
}

export function computeLatencyStats(deltasMs: number[]): LatencyStats {
  const sorted = [...deltasMs].sort((a, b) => a - b)
  const histogram = LATENCY_BUCKETS.map((b) => ({ bucket: b.label, count: 0 }))
  for (const d of sorted) histogram[bucketIndex(d)]!.count++
  return {
    sampleCount: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    minMs: sorted[0] ?? null,
    maxMs: sorted[sorted.length - 1] ?? null,
    histogram,
  }
}

export function outboundDeltaMs(row: { createdAt: Date; syncedAt: Date | null }): number | null {
  if (!row.syncedAt) return null
  return Math.max(0, row.syncedAt.getTime() - row.createdAt.getTime())
}

export interface OutboundLatencyRow {
  targetChannel: string
  createdAt: Date
  syncedAt: Date | null
}

export interface ChannelLatency extends LatencyStats {
  channel: string
  pendingCount: number
}

export function buildOutboundLatencyResponse(
  rows: OutboundLatencyRow[],
  window: string,
  checkedAtIso: string,
): { window: string; channels: ChannelLatency[]; checkedAt: string } {
  const byChannel = new Map<string, { deltas: number[]; pending: number }>()
  for (const r of rows) {
    const entry = byChannel.get(r.targetChannel) ?? { deltas: [], pending: 0 }
    const d = outboundDeltaMs(r)
    if (d === null) entry.pending++
    else entry.deltas.push(d)
    byChannel.set(r.targetChannel, entry)
  }
  const channels: ChannelLatency[] = [...byChannel.entries()]
    .map(([channel, { deltas, pending }]) => ({
      channel,
      pendingCount: pending,
      ...computeLatencyStats(deltas),
    }))
    .sort((a, b) => a.channel.localeCompare(b.channel))
  return { window, channels, checkedAt: checkedAtIso }
}

export interface DiagnosticsInput {
  queueWorkersEnabled: boolean
  redisConfigured: boolean
  ebayNotificationsActive: boolean | null
  shopifyPublishLive: boolean
  amazonPublishLive: boolean
  outboundPending: number
  outboundOldestPendingAgeMs: number | null
  dlqDepth: number
  crons: Array<{ name: string; lastRunAt: string | null; lastStatus: string | null; ageMs: number | null }>
}

export interface DiagnosticsReport {
  checkedAt: string
  dispatchPath: 'immediate-bullmq' | 'cron-60s-only'
  realtimeReady: boolean
  warnings: string[]
  config: {
    queueWorkersEnabled: boolean
    redisConfigured: boolean
    amazonPublishLive: boolean
    ebayNotificationsActive: boolean | null
    shopifyPublishLive: boolean
  }
  queue: { pending: number; oldestPendingAgeMs: number | null; dlqDepth: number }
  crons: DiagnosticsInput['crons']
}

const BACKLOG_WARN_MS = 5 * 60_000

export function summarizeDiagnostics(input: DiagnosticsInput, checkedAtIso: string): DiagnosticsReport {
  const immediate = input.queueWorkersEnabled && input.redisConfigured
  const dispatchPath = immediate ? 'immediate-bullmq' : 'cron-60s-only'
  const warnings: string[] = []

  if (!immediate) {
    warnings.push(
      'Outbound queue workers are OFF — cross-channel push is bounded by the 60s cron, not real-time.',
    )
  }
  if (input.ebayNotificationsActive === false) {
    warnings.push(
      'eBay Platform Notifications inactive — eBay sales may lag up to 15min (poll backstop).',
    )
  }
  if (input.dlqDepth > 0) {
    warnings.push(`${input.dlqDepth} dead-letter (DLQ) row(s) need manual retry.`)
  }
  if (input.outboundOldestPendingAgeMs !== null && input.outboundOldestPendingAgeMs > BACKLOG_WARN_MS) {
    warnings.push(
      `Outbound backlog: oldest pending sync is ${Math.round(input.outboundOldestPendingAgeMs / 1000)}s old.`,
    )
  }

  const realtimeReady = immediate && input.ebayNotificationsActive !== false

  return {
    checkedAt: checkedAtIso,
    dispatchPath,
    realtimeReady,
    warnings,
    config: {
      queueWorkersEnabled: input.queueWorkersEnabled,
      redisConfigured: input.redisConfigured,
      amazonPublishLive: input.amazonPublishLive,
      ebayNotificationsActive: input.ebayNotificationsActive,
      shopifyPublishLive: input.shopifyPublishLive,
    },
    queue: {
      pending: input.outboundPending,
      oldestPendingAgeMs: input.outboundOldestPendingAgeMs,
      dlqDepth: input.dlqDepth,
    },
    crons: input.crons,
  }
}
